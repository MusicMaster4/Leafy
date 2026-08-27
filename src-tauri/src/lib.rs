use axum::{
    body::Body,
    extract::{DefaultBodyLimit, State as AxumState},
    http::{header::AUTHORIZATION, HeaderMap, Response, StatusCode},
    routing::get,
    Router,
};
use axum_server::tls_rustls::RustlsConfig;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rcgen::{generate_simple_self_signed, CertifiedKey};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, TcpListener},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tauri::State;
use tokio::sync::RwLock;

const MAX_SYNC_BYTES: usize = 5_000_000;
const SYNC_SESSION_SECONDS: u64 = 60 * 60;

fn ensure_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[derive(Default)]
struct AppState {
    openrouter_key: Mutex<Option<String>>,
    received_sync: Arc<Mutex<Option<String>>>,
}

#[derive(Clone)]
struct SyncServerState {
    token: [u8; 32],
    expires_at: Instant,
    payload: Arc<RwLock<String>>,
    received: Arc<Mutex<Option<String>>>,
}

#[derive(Serialize)]
struct PairingSession {
    endpoint: String,
    certificate: String,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: String,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    temperature: f32,
    max_tokens: u16,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatAnswer,
}

#[derive(Deserialize)]
struct ChatAnswer {
    content: Option<String>,
}

#[tauri::command]
fn set_openrouter_key(key: String, state: State<'_, AppState>) -> Result<(), String> {
    let key = key.trim();
    if !key.is_empty() && (!key.starts_with("sk-or-") || key.len() > 256) {
        return Err("That does not look like an OpenRouter API key.".into());
    }
    *state
        .openrouter_key
        .lock()
        .map_err(|_| "Could not access the key store")? =
        (!key.is_empty()).then(|| key.to_string());
    Ok(())
}

#[tauri::command]
async fn categorize_transaction(
    description: String,
    transaction_type: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let description = description.trim();
    if description.is_empty() || description.len() > 200 {
        return Err("Transaction descriptions must be between 1 and 200 characters".into());
    }
    if transaction_type != "income" && transaction_type != "expense" {
        return Err("Invalid transaction type".into());
    }
    let key = state
        .openrouter_key
        .lock()
        .map_err(|_| "Could not access the key store")?
        .clone()
        .or_else(|| std::env::var("OPENROUTER_API_KEY").ok())
        .ok_or("OpenRouter is not configured")?;

    let categories = if transaction_type == "income" {
        "Salary, Freelance, Investments, Gift, Other"
    } else {
        "Food, Housing, Transport, Leisure, Health, Shopping, Subscriptions, Other"
    };
    let prompt = format!(
        "Classify this personal finance transaction into exactly one category. Valid categories: {categories}. Transaction: {description:?}. Reply with the category only."
    );
    let model =
        std::env::var("LEAFY_OPENROUTER_MODEL").unwrap_or_else(|_| "openrouter/auto".into());
    let response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Could not create the OpenRouter client: {error}"))?
        .post("https://openrouter.ai/api/v1/chat/completions")
        .bearer_auth(key)
        .header("HTTP-Referer", "https://github.com/MusicMaster4/Leafy")
        .header("X-OpenRouter-Title", "Leafy")
        .json(&ChatRequest {
            model: &model,
            messages: vec![ChatMessage {
                role: "user",
                content: prompt,
            }],
            temperature: 0.0,
            max_tokens: 12,
        })
        .send()
        .await
        .map_err(|error| format!("OpenRouter request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("OpenRouter returned {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > 65_536)
    {
        return Err("OpenRouter returned an oversized response".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Could not read the OpenRouter response")?;
    if bytes.len() > 65_536 {
        return Err("OpenRouter returned an oversized response".into());
    }
    let body: ChatResponse = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid OpenRouter response: {error}"))?;
    let answer = body
        .choices
        .first()
        .and_then(|choice| choice.message.content.as_deref())
        .unwrap_or("")
        .trim();
    categories
        .split(", ")
        .find(|category| answer.eq_ignore_ascii_case(category))
        .map(str::to_string)
        .ok_or_else(|| "OpenRouter returned an unknown category".into())
}

fn decode_token(value: &str) -> Result<[u8; 32], String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "Invalid pairing token")?;
    decoded
        .try_into()
        .map_err(|_| "Invalid pairing token".into())
}

fn is_authorized(headers: &HeaderMap, state: &SyncServerState) -> bool {
    if Instant::now() >= state.expires_at {
        return false;
    }
    let Some(value) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    decode_token(value).is_ok_and(|candidate| bool::from(candidate.ct_eq(&state.token)))
}

fn valid_ciphertext(payload: &str) -> bool {
    if payload.is_empty() || payload.len() > MAX_SYNC_BYTES {
        return false;
    }
    let Some((iv, ciphertext)) = payload.split_once('.') else {
        return false;
    };
    iv.len() == 16
        && ciphertext.len() >= 22
        && !ciphertext.contains('.')
        && iv
            .bytes()
            .chain(ciphertext.bytes())
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

async fn download_sync(
    AxumState(state): AxumState<SyncServerState>,
    headers: HeaderMap,
) -> Response<Body> {
    if !is_authorized(&headers, &state) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap();
    }
    let payload = state.payload.read().await.clone();
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/octet-stream")
        .body(Body::from(payload))
        .unwrap()
}

async fn upload_sync(
    AxumState(state): AxumState<SyncServerState>,
    headers: HeaderMap,
    body: String,
) -> Response<Body> {
    if !is_authorized(&headers, &state) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap();
    }
    if !valid_ciphertext(&body) {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::empty())
            .unwrap();
    }
    *state.payload.write().await = body.clone();
    if let Ok(mut received) = state.received.lock() {
        *received = Some(body);
    }
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Body::empty())
        .unwrap()
}

#[tauri::command]
async fn start_pairing_server(
    token: String,
    payload: String,
    state: State<'_, AppState>,
) -> Result<PairingSession, String> {
    let token = decode_token(&token)?;
    if !valid_ciphertext(&payload) {
        return Err("Invalid encrypted sync payload".into());
    }
    let listener = TcpListener::bind("0.0.0.0:0")
        .map_err(|error| format!("Could not start pairing: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not secure the pairing listener: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let address = local_ip_address::local_ip()
        .map_err(|error| format!("Could not find a local network address: {error}"))?;
    let CertifiedKey { cert, signing_key } = generate_simple_self_signed(vec![address.to_string()])
        .map_err(|error| format!("Could not create the private TLS session: {error}"))?;
    let certificate = cert.der().to_vec();
    let tls = RustlsConfig::from_der(vec![certificate.clone()], signing_key.serialize_der())
        .await
        .map_err(|error| format!("Could not configure private TLS: {error}"))?;
    let server_state = SyncServerState {
        token,
        expires_at: Instant::now() + Duration::from_secs(SYNC_SESSION_SECONDS),
        payload: Arc::new(RwLock::new(payload)),
        received: state.received_sync.clone(),
    };
    let app = Router::new()
        .route("/sync", get(download_sync).put(upload_sync))
        .layer(DefaultBodyLimit::max(MAX_SYNC_BYTES))
        .with_state(server_state);
    let server = axum_server::from_tcp_rustls(listener, tls)
        .map_err(|error| format!("Could not start private TLS: {error}"))?;
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = server.serve(app.into_make_service()) => {},
            _ = tokio::time::sleep(Duration::from_secs(SYNC_SESSION_SECONDS)) => {},
        }
    });
    Ok(PairingSession {
        endpoint: format!("https://{}/sync", std::net::SocketAddr::new(address, port)),
        certificate: URL_SAFE_NO_PAD.encode(certificate),
    })
}

fn private_sync_url(endpoint: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| "Invalid sync endpoint")?;
    if url.scheme() != "https"
        || url.path() != "/sync"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("The sync endpoint is not allowed".into());
    }
    let address: IpAddr = url
        .host_str()
        .ok_or("The sync endpoint has no address")?
        .parse()
        .map_err(|_| "The sync endpoint must use a private IP address")?;
    let private = match address {
        IpAddr::V4(value) => value.is_private() || value.is_link_local() || value.is_loopback(),
        IpAddr::V6(value) => {
            value.is_unique_local() || value.is_unicast_link_local() || value.is_loopback()
        }
    };
    private
        .then_some(url)
        .ok_or_else(|| "Leafy only syncs over a private local network".into())
}

fn private_sync_client(certificate: &str) -> Result<reqwest::Client, String> {
    let der = URL_SAFE_NO_PAD
        .decode(certificate)
        .map_err(|_| "Invalid pairing certificate")?;
    if der.is_empty() || der.len() > 4096 {
        return Err("Invalid pairing certificate".into());
    }
    let certificate =
        reqwest::Certificate::from_der(&der).map_err(|_| "Invalid pairing certificate")?;
    reqwest::Client::builder()
        .add_root_certificate(certificate)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Could not create the private sync client: {error}"))
}

#[tauri::command]
async fn sync_download(
    endpoint: String,
    certificate: String,
    token: String,
) -> Result<String, String> {
    let url = private_sync_url(&endpoint)?;
    decode_token(&token)?;
    let response = private_sync_client(&certificate)?
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("Private sync failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Private sync returned {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_SYNC_BYTES as u64)
    {
        return Err("Private sync response is too large".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Could not read private sync response")?;
    if bytes.len() > MAX_SYNC_BYTES {
        return Err("Private sync response is too large".into());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "Private sync returned invalid data".into())
}

#[tauri::command]
async fn sync_upload(
    endpoint: String,
    certificate: String,
    token: String,
    payload: String,
) -> Result<(), String> {
    let url = private_sync_url(&endpoint)?;
    decode_token(&token)?;
    if !valid_ciphertext(&payload) {
        return Err("Invalid encrypted sync payload".into());
    }
    let response = private_sync_client(&certificate)?
        .put(url)
        .bearer_auth(token)
        .header("content-type", "application/octet-stream")
        .body(payload)
        .send()
        .await
        .map_err(|error| format!("Private sync failed: {error}"))?;
    response
        .status()
        .is_success()
        .then_some(())
        .ok_or_else(|| format!("Private sync returned {}", response.status()))
}

#[tauri::command]
fn take_sync_update(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state
        .received_sync
        .lock()
        .map_err(|_| "Could not access sync updates")?
        .take())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_crypto_provider();
    let builder = tauri::Builder::default();
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            set_openrouter_key,
            categorize_transaction,
            start_pairing_server,
            sync_download,
            sync_upload,
            take_sync_update
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Leafy");
}

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn accepts_only_well_formed_ciphertext() {
        assert!(valid_ciphertext("AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA"));
        assert!(!valid_ciphertext("plaintext financial data"));
        assert!(!valid_ciphertext("AAAAAAAAAAAAAAAA.short"));
        assert!(!valid_ciphertext(
            "AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.extra"
        ));
    }

    #[test]
    fn accepts_only_private_pinned_sync_destinations() {
        assert!(private_sync_url("https://192.168.1.20:49152/sync").is_ok());
        assert!(private_sync_url("https://10.0.0.2:49152/sync").is_ok());
        assert!(private_sync_url("http://192.168.1.20:49152/sync").is_err());
        assert!(private_sync_url("https://example.com/sync").is_err());
        assert!(private_sync_url("https://8.8.8.8/sync").is_err());
        assert!(private_sync_url("https://192.168.1.20/other").is_err());
        assert!(private_sync_url("https://user:pass@192.168.1.20/sync").is_err());
    }

    #[test]
    fn pairing_tokens_are_exactly_256_bits() {
        let token = URL_SAFE_NO_PAD.encode([7_u8; 32]);
        assert_eq!(decode_token(&token).unwrap(), [7_u8; 32]);
        assert!(decode_token(&URL_SAFE_NO_PAD.encode([7_u8; 31])).is_err());
        assert!(decode_token("not base64!").is_err());
    }

    #[tokio::test]
    async fn tls_pin_protects_the_local_sync_channel() {
        ensure_crypto_provider();
        let address = "127.0.0.1";
        let listener = TcpListener::bind((address, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let CertifiedKey { cert, signing_key } =
            generate_simple_self_signed(vec![address.to_string()]).unwrap();
        let certificate = cert.der().to_vec();
        let tls = RustlsConfig::from_der(vec![certificate.clone()], signing_key.serialize_der())
            .await
            .unwrap();
        let state = SyncServerState {
            token: [7_u8; 32],
            expires_at: Instant::now() + Duration::from_secs(30),
            payload: Arc::new(RwLock::new(
                "AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA".into(),
            )),
            received: Arc::new(Mutex::new(None)),
        };
        let app = Router::new()
            .route("/sync", get(download_sync).put(upload_sync))
            .layer(DefaultBodyLimit::max(MAX_SYNC_BYTES))
            .with_state(state);
        let server = axum_server::from_tcp_rustls(listener, tls).unwrap();
        let task = tokio::spawn(server.serve(app.into_make_service()));
        let endpoint = format!("https://{address}:{port}/sync");
        let token = URL_SAFE_NO_PAD.encode([7_u8; 32]);
        let pinned = URL_SAFE_NO_PAD.encode(certificate);

        let response = private_sync_client(&pinned)
            .unwrap()
            .get(&endpoint)
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let other = generate_simple_self_signed(vec![address.to_string()]).unwrap();
        let wrong_pin = URL_SAFE_NO_PAD.encode(other.cert.der());
        let refused = tokio::time::timeout(
            Duration::from_secs(3),
            private_sync_client(&wrong_pin)
                .unwrap()
                .get(&endpoint)
                .bearer_auth(token)
                .send(),
        )
        .await;
        assert!(!matches!(refused, Ok(Ok(_))));
        task.abort();
    }
}
