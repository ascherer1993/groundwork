//! macOS notifications for the inbox. They're sent from here, not the UI,
//! so a question's notification can carry its choices (an "Answer" menu) or
//! a reply field, and answer it the way the inbox does: `groundwork ask`
//! returns without the app ever coming forward.
//!
//! They go through `NSUserNotification` (mac-notification-sys), which needs
//! a bundle macOS knows: the built app, or `make dev`'s Groundwork Dev
//! (`scripts/dev-app`, which sets `GROUNDWORK_NOTIFY_AS`).

use std::collections::HashMap;
use std::ffi::{CStr, c_char};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use groundwork_backend::Backend;
use groundwork_core::inbox::{InboxItem, InboxKind};
use groundwork_protocol::{Event, Request};
use mac_notification_sys::{MainButton, Notification, NotificationResponse};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, UserAttentionType};

/// What the UI hears when a notification is clicked (`{"id"}`), or when the
/// test notification is answered (`{"test"}`).
pub const CHANNEL: &str = "groundwork://notification";

static ENABLED: AtomicBool = AtomicBool::new(false);

/// What's on screen, by inbox item: its title and text, to find it again.
fn shown() -> &'static Mutex<HashMap<String, (String, String)>> {
    static SHOWN: std::sync::OnceLock<Mutex<HashMap<String, (String, String)>>> =
        std::sync::OnceLock::new();
    SHOWN.get_or_init(Default::default)
}

/// Picks the bundle notifications come from, before any is sent: only the
/// first choice counts. Clears what an earlier run left in Notification
/// Center, which nothing would answer now.
pub fn setup(identifier: &str) {
    let id = if cfg!(debug_assertions) {
        std::env::var("GROUNDWORK_NOTIFY_AS").unwrap_or_default()
    } else {
        identifier.to_string()
    };
    if id.is_empty() {
        eprintln!("notifications are off: run the app with `make dev`");
        return;
    }
    match mac_notification_sys::set_application(&id) {
        Ok(()) => ENABLED.store(true, Ordering::Relaxed),
        Err(e) => eprintln!("notifications can't be sent as {id}: {e}"),
    }
    remove_delivered(|_, _| true);
}

/// Follows the inbox: notifies new items while the window is in the
/// background, and takes down notifications for items done elsewhere.
pub fn on_event(app: &AppHandle, event: &Event) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let Event::InboxChanged { added } = event else {
        return;
    };
    let app = app.clone();
    let added = added.clone();
    std::thread::spawn(move || {
        if let Some(item) = added
            && !focused(&app)
        {
            attention(&app, &item);
            show(&app, item);
        }
        withdraw_done(&app);
    });
}

/// Sends a sample question a few seconds from now, so you can switch away
/// and see it (macOS doesn't show the frontmost app's notifications).
#[tauri::command]
pub fn test_notification(app: AppHandle) -> Result<(), String> {
    if !ENABLED.load(Ordering::Relaxed) {
        return Err(if cfg!(debug_assertions) {
            "notifications are off: start the app with `make dev`".into()
        } else {
            "notifications are off".into()
        });
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        let choices = ["Yes", "No"];
        let mut options = Notification::new();
        options
            .main_button(MainButton::DropdownActions("Answer", &choices))
            .close_button("Later")
            .default_sound();
        let reply = match send(
            "Test question",
            "Can you see this question's choices?",
            &options,
        ) {
            Some(NotificationResponse::ActionButton(a)) if choices.contains(&a.as_str()) => Some(a),
            Some(NotificationResponse::ActionButton(_) | NotificationResponse::Click) => {
                bring_forward(&app);
                None
            }
            _ => return,
        };
        let _ = app.emit(CHANNEL, json!({ "test": reply }));
    });
    Ok(())
}

fn focused(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false)
}

fn bring_forward(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Bounces the dock icon: until you look for questions and Claude waiting,
/// once for a note.
fn attention(app: &AppHandle, item: &InboxItem) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.request_user_attention(Some(match item.kind {
            InboxKind::Notify => UserAttentionType::Informational,
            _ => UserAttentionType::Critical,
        }));
    }
}

/// Notification Center splits the menu's titles at commas.
fn menu_title(choice: &str) -> String {
    choice.replace(',', "\u{201a}")
}

/// Shows an item's notification and acts on what's done with it. Blocks
/// until it's answered, clicked, or taken down.
fn show(app: &AppHandle, item: InboxItem) {
    let title = match item.kind {
        InboxKind::Ask => "Question",
        InboxKind::Notify => "Note",
        InboxKind::Attention => "Claude is waiting",
    };
    let titles: Vec<String> = item.choices.iter().map(|c| menu_title(c)).collect();
    let titles: Vec<&str> = titles.iter().map(String::as_str).collect();
    // A choice called "Answer" would read as the button itself.
    let label = if titles.contains(&"Answer") {
        "Choose"
    } else {
        "Answer"
    };
    let mut options = Notification::new();
    match (item.kind, titles.as_slice()) {
        (InboxKind::Ask, []) => options.main_button(MainButton::Response("Answer")),
        (InboxKind::Ask, [one]) => options.main_button(MainButton::SingleAction(one)),
        (InboxKind::Ask, _) => options.main_button(MainButton::DropdownActions(label, &titles)),
        _ => options.wait_for_click(true),
    };
    if item.kind == InboxKind::Ask {
        options.close_button("Later");
    }
    if item.kind != InboxKind::Notify {
        options.default_sound();
    }

    shown()
        .lock()
        .unwrap()
        .insert(item.id.clone(), (title.into(), item.text.clone()));
    let response = send(title, &item.text, &options);
    shown().lock().unwrap().remove(&item.id);

    let answer = match &response {
        Some(NotificationResponse::Reply(text)) if !text.trim().is_empty() => {
            Some(text.trim().to_string())
        }
        Some(NotificationResponse::ActionButton(picked)) => titles
            .iter()
            .position(|t| t == picked)
            .map(|i| item.choices[i].clone()),
        _ => None,
    };
    match (answer, response) {
        (Some(answer), _) => {
            // Already answered in the app is fine: nothing to do.
            let backend = app.state::<Arc<Backend>>();
            let _ = backend.handle(Request::InboxAnswer {
                id: item.id,
                answer: Some(answer),
            });
        }
        // The notification itself, or "Answer" without picking a choice.
        (None, Some(NotificationResponse::Click | NotificationResponse::ActionButton(_))) => {
            bring_forward(app);
            let _ = app.emit(CHANNEL, json!({ "id": item.id }));
        }
        _ => {}
    }
}

fn send(title: &str, text: &str, options: &Notification) -> Option<NotificationResponse> {
    mac_notification_sys::send_notification(title, None, text, Some(options))
        .inspect_err(|e| eprintln!("notification failed: {e}"))
        .ok()
}

/// Takes down the notifications of items no longer open (answered in the
/// app, or Claude no longer waiting), which also ends their `show`.
fn withdraw_done(app: &AppHandle) {
    let Ok(open) = app.state::<Arc<Backend>>().handle(Request::InboxList) else {
        return;
    };
    let open: Vec<InboxItem> = serde_json::from_value(open).unwrap_or_default();
    let shown = shown().lock().unwrap().clone();
    let (done, still): (Vec<_>, Vec<_>) = shown
        .into_iter()
        .partition(|(id, _)| !open.iter().any(|i| &i.id == id));
    if done.is_empty() {
        return;
    }
    let done: Vec<_> = done
        .into_iter()
        .map(|(_, shown)| shown)
        // Two items can read the same; keep it while one of them is open.
        .filter(|shown| !still.iter().any(|(_, s)| s == shown))
        .collect();
    let _ = app.run_on_main_thread(move || {
        remove_delivered(|title, text| done.iter().any(|(t, x)| t == title && x == text));
    });
}

/// Removes delivered notifications whose title and text match.
fn remove_delivered(matches: impl Fn(&str, &str) -> bool) {
    // SAFETY: plain messages to NSUserNotificationCenter and the
    // NSUserNotifications it returns, each checked for nil.
    unsafe {
        let center: *mut AnyObject = msg_send![
            class!(NSUserNotificationCenter),
            defaultUserNotificationCenter
        ];
        if center.is_null() {
            return;
        }
        let delivered: *mut AnyObject = msg_send![center, deliveredNotifications];
        if delivered.is_null() {
            return;
        }
        let count: usize = msg_send![delivered, count];
        for i in 0..count {
            let n: *mut AnyObject = msg_send![delivered, objectAtIndex: i];
            let title = string(msg_send![n, title]);
            let text = string(msg_send![n, informativeText]);
            if matches(&title, &text) {
                let _: () = msg_send![center, removeDeliveredNotification: n];
            }
        }
    }
}

/// An NSString's contents.
unsafe fn string(s: *mut AnyObject) -> String {
    if s.is_null() {
        return String::new();
    }
    // SAFETY: `s` is a non-nil NSString; UTF8String is valid while it lives.
    unsafe {
        let c: *const c_char = msg_send![s, UTF8String];
        if c.is_null() {
            return String::new();
        }
        CStr::from_ptr(c).to_string_lossy().into_owned()
    }
}
