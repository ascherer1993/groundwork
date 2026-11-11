//! Saving a canvas's image where you chose in the save dialog (PLAN §5.17).
//! The image comes as the request's raw body, the path in `x-path`
//! (percent-encoded, as headers are ASCII). Only images are written.

use std::path::Path;

use tauri::ipc::{InvokeBody, Request};

#[tauri::command]
pub fn save_image(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the image's bytes".into());
    };
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("no path to save to")?;
    let path = percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .map_err(|e| e.to_string())?;
    let path = Path::new(path.as_ref());
    if !path.is_absolute() {
        return Err(format!("{} isn't a full path", path.display()));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(ext.as_deref(), Some("png" | "jpg" | "jpeg")) {
        return Err("images are saved as .png, .jpg or .jpeg".into());
    }
    std::fs::write(path, bytes).map_err(|e| format!("couldn't save {}: {e}", path.display()))
}
