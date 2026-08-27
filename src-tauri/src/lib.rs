use axum::{
    body::Body,
    extract::State as AxumState,
    http::{header::AUTHORIZATION, HeaderMap, Response, StatusCode},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::State;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

#[derive(Default)]
struct AppState {
    openrouter_key: Mutex<Option<String>>,
    received_sync: Arc<Mutex<Vec<String>>>,
}

#[derive(Clone)]
struct SyncServerState {
    token: String,
    payload: Arc<RwLock<String>>,
    received: Arc<Mutex<Vec<String>>>,
}

#[derive(Serialize)]
struct PairingSession {
    endpoint: String,
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
    if !key.is_empty() && !key.starts_with("sk-or-") {
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
    let response = reqwest::Client::new()
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
    let body: ChatResponse = response
        .json()
        .await
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

fn is_authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == format!("Bearer {token}"))
}

async fn download_sync(
    AxumState(state): AxumState<SyncServerState>,
    headers: HeaderMap,
) -> Response<Body> {
    if !is_authorized(&headers, &state.token) {
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
    if !is_authorized(&headers, &state.token) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap();
    }
    if body.len() > 5_000_000 {
        return Response::builder()
            .status(StatusCode::PAYLOAD_TOO_LARGE)
            .body(Body::empty())
            .unwrap();
    }
    *state.payload.write().await = body.clone();
    if let Ok(mut received) = state.received.lock() {
        received.push(body);
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
    if token.len() < 32 {
        return Err("Invalid pairing token".into());
    }
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(|error| format!("Could not start pairing: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let address = local_ip_address::local_ip()
        .map_err(|error| format!("Could not find a local network address: {error}"))?;
    let server_state = SyncServerState {
        token,
        payload: Arc::new(RwLock::new(payload)),
        received: state.received_sync.clone(),
    };
    let app = Router::new()
        .route("/sync", get(download_sync).put(upload_sync))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(server_state);
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(PairingSession {
        endpoint: format!("http://{address}:{port}/sync"),
    })
}

#[tauri::command]
fn take_sync_update(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state
        .received_sync
        .lock()
        .map_err(|_| "Could not access sync updates")?
        .pop())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            set_openrouter_key,
            categorize_transaction,
            start_pairing_server,
            take_sync_update
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Leafy");
}
