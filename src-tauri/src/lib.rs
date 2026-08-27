use axum::{
    body::Body,
    extract::{DefaultBodyLimit, State as AxumState},
    http::{header::AUTHORIZATION, HeaderMap, Response, StatusCode},
    routing::{get, post},
    Router,
};
use axum_server::tls_rustls::RustlsConfig;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rcgen::{generate_simple_self_signed, CertifiedKey};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::{
    net::{IpAddr, TcpListener},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tauri::State;
#[cfg(desktop)]
use tauri::{AppHandle, Emitter, Manager};
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::RwLock;

const MAX_SYNC_BYTES: usize = 5_000_000;
const SYNC_SESSION_SECONDS: u64 = 60 * 60;

fn ensure_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[cfg(target_os = "android")]
#[export_name = "Java_app_leafy_financas_MainActivity_initTlsVerifier"]
pub extern "C" fn init_android_tls_verifier<'local>(
    mut env: jni::EnvUnowned<'local>,
    activity: jni::objects::JObject<'local>,
) {
    use jni::errors::ThrowRuntimeExAndDefault;
    env.with_env(|env| rustls_platform_verifier::android::init_with_env(env, activity))
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[derive(Default)]
struct AppState {
    openrouter_key: Arc<Mutex<Option<String>>>,
    received_sync: Arc<Mutex<Option<String>>>,
}

#[derive(Clone)]
struct SyncServerState {
    token: [u8; 32],
    expires_at: Instant,
    payload: Arc<RwLock<String>>,
    received: Arc<Mutex<Option<String>>>,
    openrouter_key: Arc<Mutex<Option<String>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingSession {
    endpoint: String,
    certificate: String,
    network_mode: &'static str,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CategorizeRequest {
    description: String,
    transaction_type: String,
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

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheck {
    current_version: String,
    latest_version: String,
    available: bool,
    apk_url: Option<String>,
    updater_url: String,
}

#[cfg(desktop)]
#[derive(Clone, Serialize)]
struct UpdateProgress {
    percent: u8,
}

#[cfg(desktop)]
#[derive(Clone, Serialize)]
struct UpdateStatus<'a> {
    status: &'a str,
}

#[cfg(desktop)]
#[derive(Clone, Serialize)]
struct UpdateError<'a> {
    message: &'a str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ReleaseVersion {
    core: [u64; 3],
    testing: Option<u64>,
}

impl Ord for ReleaseVersion {
    fn cmp(&self, other: &Self) -> Ordering {
        self.core
            .cmp(&other.core)
            .then_with(|| match (self.testing, other.testing) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(left), Some(right)) => left.cmp(&right),
            })
    }
}

impl PartialOrd for ReleaseVersion {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn parse_release_version(version: &str) -> Option<ReleaseVersion> {
    let version = version.trim().trim_start_matches('v');
    let (core, suffix) = version
        .split_once('-')
        .map_or((version, None), |(core, suffix)| (core, Some(suffix)));
    let mut parts = core.split('.').map(str::parse::<u64>);
    let core = [
        parts.next()?.ok()?,
        parts.next()?.ok()?,
        parts.next()?.ok()?,
    ];
    if parts.next().is_some() {
        return None;
    }
    let testing = match suffix {
        None => None,
        Some(value) => Some(value.strip_prefix("testing.")?.parse().ok()?),
    };
    Some(ReleaseVersion { core, testing })
}

fn trusted_apk_url(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("github.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url
                .path()
                .starts_with("/MusicMaster4/Leafy/releases/download/v")
            && matches!(
                url.path().rsplit('/').next(),
                Some("leafy.apk" | "leafy-beta.apk")
            )
    })
}

#[cfg(any(desktop, test))]
fn trusted_updater_url(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|url| {
        let parts = url
            .path_segments()
            .map(|segments| segments.collect::<Vec<_>>())
            .unwrap_or_default();
        url.scheme() == "https"
            && url.host_str() == Some("github.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && parts.len() == 6
            && parts[..4] == ["MusicMaster4", "Leafy", "releases", "download"]
            && parse_release_version(parts[4]).is_some()
            && parts[5] == "latest.json"
    })
}

#[tauri::command]
async fn check_for_updates() -> Result<UpdateCheck, String> {
    const MAX_RELEASE_BYTES: usize = 64 * 1024;
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let current =
        parse_release_version(&current_version).ok_or("The current app version is invalid")?;
    let testing_channel = current.testing.is_some();
    let endpoint = if testing_channel {
        "https://api.github.com/repos/MusicMaster4/Leafy/releases?per_page=1"
    } else {
        "https://api.github.com/repos/MusicMaster4/Leafy/releases/latest"
    };
    let response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not prepare the update check")?
        .get(endpoint)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Leafy update checker")
        .send()
        .await
        .map_err(|_| "Could not reach GitHub Releases")?;
    if !response.status().is_success() {
        return Err(format!("GitHub Releases returned {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RELEASE_BYTES as u64)
    {
        return Err("GitHub Releases returned an oversized response".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Could not read the latest release")?;
    if bytes.len() > MAX_RELEASE_BYTES {
        return Err("GitHub Releases returned an oversized response".into());
    }
    let release: GithubRelease = if testing_channel {
        serde_json::from_slice::<Vec<GithubRelease>>(&bytes)
            .map_err(|_| "GitHub Releases returned an invalid response")?
            .into_iter()
            .next()
            .ok_or("GitHub Releases did not return a compatible release")?
    } else {
        serde_json::from_slice(&bytes)
            .map_err(|_| "GitHub Releases returned an invalid response")?
    };
    let latest = parse_release_version(&release.tag_name)
        .ok_or("GitHub Releases did not return a compatible release")?;
    let apk_url = release
        .assets
        .iter()
        .find(|asset| {
            matches!(asset.name.as_str(), "leafy.apk" | "leafy-beta.apk")
                && trusted_apk_url(&asset.browser_download_url)
        })
        .map(|asset| asset.browser_download_url.clone());
    Ok(UpdateCheck {
        current_version,
        latest_version: release.tag_name.trim_start_matches('v').to_string(),
        available: latest > current,
        apk_url,
        updater_url: format!(
            "https://github.com/MusicMaster4/Leafy/releases/download/{}/latest.json",
            release.tag_name
        ),
    })
}

#[cfg(desktop)]
#[tauri::command]
async fn install_desktop_update(updater_url: String, app: AppHandle) -> Result<(), String> {
    if !trusted_updater_url(&updater_url) {
        return Err("Leafy refused an untrusted update address".into());
    }
    let endpoint = updater_url
        .parse()
        .map_err(|_| "The update address is invalid")?;
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|_| "Could not prepare the updater")?
        .build()
        .map_err(|_| "Could not prepare the updater")?
        .check()
        .await
        .map_err(|_| "Could not verify the available update")?
        .ok_or("The update is no longer available")?;

    let progress_app = app.clone();
    let installing_app = app.clone();
    let mut downloaded = 0_u64;
    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                if let Some(total) = content_length.filter(|total| *total > 0) {
                    let percent = ((downloaded.saturating_mul(100) / total).min(100)) as u8;
                    let _ = progress_app.emit("leafy:update-progress", UpdateProgress { percent });
                }
            },
            move || {
                let _ = installing_app.emit(
                    "leafy:update-status",
                    UpdateStatus {
                        status: "installing",
                    },
                );
            },
        )
        .await
        .map_err(|_| {
            let _ = app.emit(
                "leafy:update-error",
                UpdateError {
                    message: "Leafy could not securely install this update.",
                },
            );
            "Could not download or install the update"
        })?;
    app.restart();
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
    let key = state
        .openrouter_key
        .lock()
        .map_err(|_| "Could not access the key store")?
        .clone()
        .or_else(|| std::env::var("OPENROUTER_API_KEY").ok());
    categorize_with_openrouter(description, transaction_type, key).await
}

async fn categorize_with_openrouter(
    description: String,
    transaction_type: String,
    key: Option<String>,
) -> Result<String, String> {
    let description = description.trim();
    if description.is_empty() || description.len() > 200 {
        return Err("Transaction descriptions must be between 1 and 200 characters".into());
    }
    if transaction_type != "income" && transaction_type != "expense" {
        return Err("Invalid transaction type".into());
    }
    let key = key.ok_or("OpenRouter is not configured")?;

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

async fn categorize_for_peer(
    AxumState(state): AxumState<SyncServerState>,
    headers: HeaderMap,
    axum::Json(request): axum::Json<CategorizeRequest>,
) -> Response<Body> {
    if !is_authorized(&headers, &state) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap();
    }
    let key = state
        .openrouter_key
        .lock()
        .ok()
        .and_then(|value| value.clone())
        .or_else(|| std::env::var("OPENROUTER_API_KEY").ok());
    match categorize_with_openrouter(request.description, request.transaction_type, key).await {
        Ok(category) => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/plain; charset=utf-8")
            .body(Body::from(category))
            .unwrap(),
        Err(error) => Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .body(Body::from(error))
            .unwrap(),
    }
}

fn is_tailscale_ipv4(value: std::net::Ipv4Addr) -> bool {
    let octets = value.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

fn is_pairing_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(value) => {
            !value.is_loopback() && (value.is_private() || is_tailscale_ipv4(value))
        }
        IpAddr::V6(value) => !value.is_loopback() && value.is_unique_local(),
    }
}

fn sync_address() -> Result<(IpAddr, bool), String> {
    if let Ok(interfaces) = local_ip_address::list_afinet_netifas() {
        if let Some((_, address)) = interfaces.iter().find(|(name, address)| {
            name.to_ascii_lowercase().contains("tailscale")
                && match address {
                    IpAddr::V4(value) => is_tailscale_ipv4(*value),
                    IpAddr::V6(value) => value.is_unique_local(),
                }
        }) {
            return Ok((*address, true));
        }
        if let Ok(address) = local_ip_address::local_ip() {
            if is_pairing_address(address) {
                let tailscale = matches!(address, IpAddr::V4(value) if is_tailscale_ipv4(value));
                return Ok((address, tailscale));
            }
        }
        if let Some((_, address)) = interfaces
            .into_iter()
            .find(|(_, address)| is_pairing_address(*address))
        {
            let tailscale = matches!(address, IpAddr::V4(value) if is_tailscale_ipv4(value));
            return Ok((address, tailscale));
        }
    }
    local_ip_address::local_ip()
        .ok()
        .filter(|address| is_pairing_address(*address))
        .map(|address| {
            let tailscale = matches!(address, IpAddr::V4(value) if is_tailscale_ipv4(value));
            (address, tailscale)
        })
        .ok_or_else(|| "Could not find a private local or Tailscale address".into())
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
    let (address, tailscale) = sync_address()?;
    let unspecified = match address {
        IpAddr::V4(_) => IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
        IpAddr::V6(_) => IpAddr::V6(std::net::Ipv6Addr::UNSPECIFIED),
    };
    let listener = TcpListener::bind(std::net::SocketAddr::new(unspecified, 0))
        .map_err(|error| format!("Could not start pairing: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not secure the pairing listener: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
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
        openrouter_key: state.openrouter_key.clone(),
    };
    let app = Router::new()
        .route("/sync", get(download_sync).put(upload_sync))
        .route("/categorize", post(categorize_for_peer))
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
        network_mode: if tailscale { "tailscale" } else { "local" },
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
    let host = url.host_str().ok_or("The sync endpoint has no address")?;
    // URL serialization wraps IPv6 hosts in brackets. Remove only that
    // syntactic pair before parsing the literal address.
    let host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    let address: IpAddr = host
        .parse()
        .map_err(|_| "The sync endpoint must use a private IP address")?;
    let private = match address {
        IpAddr::V4(value) => {
            value.is_private()
                || value.is_link_local()
                || value.is_loopback()
                || is_tailscale_ipv4(value)
        }
        IpAddr::V6(value) => {
            value.is_unique_local() || value.is_unicast_link_local() || value.is_loopback()
        }
    };
    private
        .then_some(url)
        .ok_or_else(|| "Leafy only syncs over a private local network".into())
}

fn private_peer_url(endpoint: &str, path: &str) -> Result<reqwest::Url, String> {
    let mut url = private_sync_url(endpoint)?;
    url.set_path(path);
    Ok(url)
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
async fn categorize_via_peer(
    endpoint: String,
    certificate: String,
    token: String,
    description: String,
    transaction_type: String,
) -> Result<String, String> {
    let url = private_peer_url(&endpoint, "/categorize")?;
    decode_token(&token)?;
    let response = private_sync_client(&certificate)?
        .post(url)
        .bearer_auth(token)
        .json(&CategorizeRequest {
            description,
            transaction_type,
        })
        .send()
        .await
        .map_err(|error| format!("Could not reach OpenRouter through your computer: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Your computer could not categorize this transaction ({})",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Could not read the category from your computer")?;
    if bytes.len() > 64 {
        return Err("Your computer returned an invalid category".into());
    }
    String::from_utf8(bytes.to_vec())
        .map_err(|_| "Your computer returned an invalid category".into())
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
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build());
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
            categorize_via_peer,
            take_sync_update,
            check_for_updates,
            #[cfg(desktop)]
            install_desktop_update
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Leafy");
}

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn parses_release_versions_for_update_comparison() {
        assert_eq!(parse_release_version("v1.12.3").unwrap().core, [1, 12, 3]);
        assert!(
            parse_release_version("0.2.0-testing.4").unwrap()
                > parse_release_version("0.2.0-testing.3").unwrap()
        );
        assert!(
            parse_release_version("0.2.0").unwrap()
                > parse_release_version("0.2.0-testing.4").unwrap()
        );
        assert!(parse_release_version("1.2").is_none());
        assert!(parse_release_version("1.10.0").unwrap() > parse_release_version("1.9.9").unwrap());
        assert!(parse_release_version("0.2.0-beta.4").is_none());
    }

    #[test]
    fn accepts_only_official_leafy_updater_manifests() {
        assert!(trusted_updater_url(
            "https://github.com/MusicMaster4/Leafy/releases/download/v0.1.6-testing.6/latest.json"
        ));
        assert!(!trusted_updater_url(
            "https://github.com.evil.test/MusicMaster4/Leafy/releases/download/v9/latest.json"
        ));
        assert!(!trusted_updater_url(
            "https://github.com/other/Leafy/releases/download/v9/latest.json"
        ));
        assert!(!trusted_updater_url(
            "https://github.com/MusicMaster4/Leafy/releases/download/v9/not-latest.json"
        ));
    }

    #[test]
    fn accepts_only_official_leafy_apk_assets() {
        assert!(trusted_apk_url("https://github.com/MusicMaster4/Leafy/releases/download/v0.1.6-testing.3/leafy-beta.apk"));
        assert!(trusted_apk_url(
            "https://github.com/MusicMaster4/Leafy/releases/download/v0.1.5/leafy.apk"
        ));
        assert!(!trusted_apk_url(
            "https://github.com/other/Leafy/releases/download/v9/leafy.apk"
        ));
        assert!(!trusted_apk_url(
            "https://github.com/MusicMaster4/Leafy/releases/download/v9/other.apk"
        ));
    }

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
        assert!(private_sync_url("https://100.64.0.1:49152/sync").is_ok());
        assert!(private_sync_url("https://100.113.41.57:49152/sync").is_ok());
        assert!(private_sync_url("https://100.127.255.254:49152/sync").is_ok());
        assert!(private_sync_url("https://100.63.255.254:49152/sync").is_err());
        assert!(private_sync_url("https://100.128.0.1:49152/sync").is_err());
        assert!(private_sync_url("https://[fd7a:115c:a1e0::1234]:49152/sync").is_ok());
        assert!(private_sync_url("https://[fd00::1234]:49152/sync").is_ok());
        assert!(private_sync_url("https://[2001:4860:4860::8888]:49152/sync").is_err());
        assert!(private_sync_url("http://192.168.1.20:49152/sync").is_err());
        assert!(private_sync_url("https://example.com/sync").is_err());
        assert!(private_sync_url("https://8.8.8.8/sync").is_err());
        assert!(private_sync_url("https://192.168.1.20/other").is_err());
        assert!(private_sync_url("https://user:pass@192.168.1.20/sync").is_err());
    }

    #[test]
    fn advertises_only_reachable_private_pairing_addresses() {
        assert!(is_pairing_address("192.168.1.20".parse().unwrap()));
        assert!(is_pairing_address("10.0.0.2".parse().unwrap()));
        assert!(is_pairing_address("100.100.20.3".parse().unwrap()));
        assert!(is_pairing_address("fd7a:115c:a1e0::1234".parse().unwrap()));
        assert!(!is_pairing_address("127.0.0.1".parse().unwrap()));
        assert!(!is_pairing_address("169.254.20.3".parse().unwrap()));
        assert!(!is_pairing_address("8.8.8.8".parse().unwrap()));
        assert!(!is_pairing_address("2001:4860:4860::8888".parse().unwrap()));
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
            openrouter_key: Arc::new(Mutex::new(None)),
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
