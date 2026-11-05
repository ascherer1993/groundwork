//! Asking the app's window to do something. The CLI's live commands (`open`,
//! `workspace open`, `tab new`…) arrive on the socket, but only the window
//! has the tabs: the backend sends it a `ui.command` event and waits for its
//! `ui.reply`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::Duration;

use groundwork_protocol::{ApiError, ErrorCode, Event, UiCommand};
use serde_json::Value;

use crate::EventSink;

/// How long the window gets. A new tab may have to start the terminal
/// daemon first.
const TIMEOUT: Duration = Duration::from_secs(15);

type Reply = Result<Value, String>;

pub(crate) struct Window {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    events: EventSink,
}

impl Window {
    pub fn new(events: EventSink) -> Self {
        Self {
            next: AtomicU64::new(0),
            pending: Mutex::new(HashMap::new()),
            events,
        }
    }

    /// Sends the window a command and waits for what it answers.
    pub fn call(&self, command: UiCommand) -> Result<Value, ApiError> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        (self.events)(Event::UiCommand { id, command });
        let reply = rx.recv_timeout(TIMEOUT);
        self.pending.lock().unwrap().remove(&id);
        match reply {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => Err(ApiError::new(ErrorCode::BadRequest, message)),
            Err(_) => Err(ApiError::new(
                ErrorCode::Unavailable,
                "Groundwork's window didn't answer (it needs a vault open)",
            )),
        }
    }

    /// The window's answer. Only the first one counts (in browser mode
    /// several tabs may answer), and a late one is dropped.
    pub fn reply(&self, id: u64, reply: Reply) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(reply);
        }
    }
}
