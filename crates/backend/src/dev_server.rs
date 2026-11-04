//! WebSocket host for running the UI in a normal browser ("browser mode").
//!
//! Development and testing only; it is never part of the packaged app. It
//! binds to 127.0.0.1 and only accepts connections from localhost origins, so
//! an arbitrary website can't read the vault through it.
//!
//! Wire format, one JSON object per text frame:
//! - client → server: `{ "id": 1, "request": { "method": ..., "params": ... } }`
//! - server → client: `{ "id": 1, "result": ... }` or `{ "id": 1, "error": ApiError }`,
//!   and events as `{ "event": ..., "payload": ... }`
//!
//! `GET /vault/<path>` serves raw vault files (images, embeds), and
//! `GET /page/<token>/<path>` serves HTML pages and their files to page
//! frames (see `page_server`).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use groundwork_protocol::{ApiError, ErrorCode, Event};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};

use crate::{Backend, EventSink};

#[derive(Deserialize)]
struct Envelope {
    id: u64,
    request: Value,
}

/// Events fan out to every connected browser tab.
pub struct EventHub {
    tx: broadcast::Sender<String>,
}

impl EventHub {
    pub fn new() -> Self {
        Self {
            // Terminal output comes in bursts. A tab that falls behind
            // anyway drops events, and its terminals catch up by attaching again.
            tx: broadcast::channel(4096).0,
        }
    }

    pub fn sink(&self) -> EventSink {
        let tx = self.tx.clone();
        Arc::new(move |event: Event| {
            if let Ok(text) = serde_json::to_string(&event) {
                let _ = tx.send(text);
            }
        })
    }
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
struct AppState {
    backend: Arc<Backend>,
    events: broadcast::Sender<String>,
}

pub async fn serve(backend: Arc<Backend>, hub: EventHub, port: u16) -> std::io::Result<()> {
    let state = AppState {
        backend,
        events: hub.tx,
    };
    let app = Router::new()
        .route("/", get(upgrade))
        .route("/vault/{*path}", get(vault_file))
        .route("/page/{*rest}", get(page_file))
        .with_state(state);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("groundwork dev server listening on ws://{addr}");
    axum::serve(listener, app).await
}

async fn vault_file(State(state): State<AppState>, Path(path): Path<String>) -> Response {
    let backend = state.backend.clone();
    match tokio::task::spawn_blocking(move || backend.read_bytes(&path)).await {
        Ok(Ok((bytes, mime))) => ([(header::CONTENT_TYPE, mime)], bytes).into_response(),
        Ok(Err(e)) if e.code == ErrorCode::Forbidden => StatusCode::FORBIDDEN.into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn page_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(rest): Path<String>,
) -> Response {
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1");
    let self_source = format!("http://{host}");
    let backend = state.backend.clone();
    match tokio::task::spawn_blocking(move || backend.page_file(&rest, &self_source)).await {
        Ok(Ok(file)) => {
            let mut response = ([(header::CONTENT_TYPE, file.mime)], file.bytes).into_response();
            for (name, value) in file.headers {
                if let Ok(value) = value.parse() {
                    response.headers_mut().insert(name, value);
                }
            }
            response
        }
        Ok(Err(e)) if e.code == ErrorCode::Forbidden => StatusCode::FORBIDDEN.into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if !origin.is_none_or(is_local_origin) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    ws.on_upgrade(move |socket| connection(socket, state.backend, state.events.subscribe()))
}

fn is_local_origin(origin: &str) -> bool {
    let rest = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"));
    let Some(rest) = rest else { return false };
    let host = rest.split(':').next().unwrap_or_default();
    matches!(host, "localhost" | "127.0.0.1")
}

async fn connection(
    socket: WebSocket,
    backend: Arc<Backend>,
    mut events: broadcast::Receiver<String>,
) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let writer = tokio::spawn(async move {
        loop {
            let text = tokio::select! {
                reply = rx.recv() => match reply {
                    Some(text) => text,
                    None => break,
                },
                event = events.recv() => match event {
                    Ok(text) => text,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            };
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(message)) = stream.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        let envelope: Envelope = match serde_json::from_str(&text) {
            Ok(envelope) => envelope,
            Err(e) => {
                let error = ApiError::new(ErrorCode::BadRequest, e.to_string());
                let _ = tx.send(json!({ "id": null, "error": error }).to_string());
                continue;
            }
        };
        let backend = backend.clone();
        let tx = tx.clone();
        // Requests run concurrently on the blocking pool; responses carry
        // their id, so ordering doesn't matter.
        tokio::spawn(async move {
            let id = envelope.id;
            let outcome =
                tokio::task::spawn_blocking(move || backend.handle_value(envelope.request))
                    .await
                    .unwrap_or_else(|e| Err(ApiError::new(ErrorCode::Internal, e.to_string())));
            let reply = match outcome {
                Ok(result) => json!({ "id": id, "result": result }),
                Err(error) => json!({ "id": id, "error": error }),
            };
            let _ = tx.send(reply.to_string());
        });
    }
    drop(tx);
    let _ = writer.await;
}

#[cfg(test)]
mod tests {
    use super::is_local_origin;

    #[test]
    fn only_localhost_origins_are_allowed() {
        assert!(is_local_origin("http://localhost:1420"));
        assert!(is_local_origin("http://127.0.0.1:5173"));
        assert!(!is_local_origin("https://evil.example"));
        assert!(!is_local_origin("http://localhost.evil.example"));
        assert!(!is_local_origin("null"));
    }
}
