use std::sync::Arc;
use tauri::menu::{Menu, PredefinedMenuItem, Submenu};

use groundwork_backend::Backend;
use groundwork_protocol::{ApiError, ErrorCode, Host};
use serde_json::Value;
use tauri::http::{Response, StatusCode, header};
use tauri::{Emitter, Manager, RunEvent};

/// Name of the Tauri event carrying backend `Event`s to the UI.
const EVENT_CHANNEL: &str = "groundwork://event";

/// The single entry point for UI → backend calls. The request shape is
/// `groundwork_protocol::Request`; the browser dev server accepts the same.
#[tauri::command]
async fn api(backend: tauri::State<'_, Arc<Backend>>, request: Value) -> Result<Value, ApiError> {
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backend.handle_value(request))
        .await
        .unwrap_or_else(|e| Err(ApiError::new(ErrorCode::Internal, e.to_string())))
}

/// Serves `groundwork://localhost/vault/<path>` (raw vault files for images
/// and embeds) and `groundwork://localhost/page/<token>/<path>` (HTML pages
/// and their files, for page frames).
fn serve_vault_file(backend: &Backend, uri_path: &str) -> Response<Vec<u8>> {
    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .unwrap()
    };
    let decode = |s: &str| {
        percent_encoding::percent_decode_str(s)
            .decode_utf8_lossy()
            .into_owned()
    };
    if let Some(rest) = uri_path.strip_prefix("/page/") {
        return match backend.page_file(&decode(rest), "groundwork:") {
            Ok(file) => {
                let mut response = Response::builder().header(header::CONTENT_TYPE, file.mime);
                for (name, value) in file.headers {
                    response = response.header(name, value);
                }
                response.body(file.bytes).unwrap()
            }
            Err(_) => not_found(),
        };
    }
    let Some(encoded) = uri_path.strip_prefix("/vault/") else {
        return not_found();
    };
    match backend.read_bytes(&decode(encoded)) {
        Ok((bytes, mime)) => Response::builder()
            .header(header::CONTENT_TYPE, mime)
            .body(bytes)
            .unwrap(),
        Err(_) => not_found(),
    }
}

/// The macOS menu bar. Undo/Redo and Close Window are left out on purpose:
/// their accelerators (⌘Z, ⇧⌘Z, ⌘W) would be swallowed by the menu, and the
/// editor and tabs handle them in the webview.
fn menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let app_menu = Submenu::with_items(
        app,
        "Groundwork",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .menu(menu)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let backend = Arc::new(Backend::new(
                Host::Desktop,
                groundwork_core::data_dir(),
                Arc::new(move |event| {
                    let _ = handle.emit(EVENT_CHANNEL, &event);
                }),
            ));
            app.manage(backend);
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("groundwork", |ctx, request, responder| {
            let backend = ctx.app_handle().state::<Arc<Backend>>().inner().clone();
            let path = request.uri().path().to_string();
            std::thread::spawn(move || responder.respond(serve_vault_file(&backend, &path)));
        })
        .invoke_handler(tauri::generate_handler![api])
        .build(tauri::generate_context!())
        .expect("error while building Groundwork");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            app.state::<Arc<Backend>>().shutdown();
        }
    });
}
