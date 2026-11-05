//! The command bar's window (PLAN §5.10) as a macOS panel, like Spotlight's:
//! it floats over every app, on whichever Space you're on (full-screen ones
//! too), and takes the keyboard without bringing Groundwork forward or
//! switching Spaces. It hides when you click elsewhere. The UI asks for it
//! with `show_command_bar` and `hide_command_bar`.

use tauri::{AppHandle, Manager, PhysicalPosition};

/// The window's label, in `tauri.conf.json`.
const LABEL: &str = "command-bar";

// `tauri_panel!`'s event handlers are written with `-> ()`.
#[allow(clippy::unused_unit)]
#[cfg(target_os = "macos")]
mod panel {
    use tauri::Manager;
    use tauri_nspanel::{
        CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt, tauri_panel,
    };

    tauri_panel! {
        panel!(CommandBarPanel {
            config: {
                can_become_key_window: true,
                is_floating_panel: true
            }
        })

        panel_event!(CommandBarEvents {
            window_did_resign_key(notification: &NSNotification) -> ()
        })
    }

    /// Makes the bar's window a non-activating panel.
    pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
        let Some(window) = app.get_webview_window(super::LABEL) else {
            return Ok(());
        };
        let panel = window.to_panel::<CommandBarPanel>()?;
        // Takes the keyboard without making Groundwork the active app.
        let _ = panel.set_style_mask(
            StyleMask::empty()
                .borderless()
                .nonactivating_panel()
                .value(),
        );
        panel.set_level(PanelLevel::Status.value());
        panel.set_collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .full_screen_auxiliary()
                .value(),
        );
        panel.set_hides_on_deactivate(false);
        panel.set_transparent(true);
        panel.set_has_shadow(true);
        panel.set_corner_radius(12.0);

        // Clicking elsewhere puts it away, as Spotlight does.
        let events = CommandBarEvents::new();
        let handle = app.clone();
        events.window_did_resign_key(move |_| hide(&handle));
        panel.set_event_handler(Some(events.as_ref()));
        Ok(())
    }

    pub fn show(app: &tauri::AppHandle) {
        if let Ok(panel) = app.get_webview_panel(super::LABEL) {
            panel.show_and_make_key();
        }
    }

    pub fn hide(app: &tauri::AppHandle) {
        if let Ok(panel) = app.get_webview_panel(super::LABEL) {
            panel.hide();
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod panel {
    use tauri::Manager;

    pub fn setup(_: &tauri::AppHandle) -> tauri::Result<()> {
        Ok(())
    }

    pub fn show(app: &tauri::AppHandle) {
        if let Some(window) = app.get_webview_window(super::LABEL) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    pub fn hide(app: &tauri::AppHandle) {
        if let Some(window) = app.get_webview_window(super::LABEL) {
            let _ = window.hide();
        }
    }
}

pub use panel::setup;

/// Shows the bar on the screen the pointer is on, a little above the middle.
#[tauri::command]
pub fn show_command_bar(app: AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let screen = app
            .cursor_position()
            .ok()
            .and_then(|at| app.monitor_from_point(at.x, at.y).ok().flatten())
            .or_else(|| window.current_monitor().ok().flatten());
        if let (Some(screen), Ok(size)) = (screen, window.outer_size()) {
            let (at, area) = (screen.position(), screen.size());
            let x = at.x + (area.width as i32 - size.width as i32) / 2;
            let y = at.y + area.height as i32 / 4;
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
    }
    panel::show(&app);
}

#[tauri::command]
pub fn hide_command_bar(app: AppHandle) {
    panel::hide(&app);
}
