//! Agents in terminals: the inbox they post to, the states their hooks
//! report, and the socket the `groundwork` CLI reaches the app through.
//!
//! The socket (`<data dir>/groundwork.sock`, given to terminals as
//! `GROUNDWORK_SOCKET`) takes the same requests as the UI: one JSON request
//! per line, answered by one line, `{"ok": …}` or `{"error": …}`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use groundwork_core::inbox::{Inbox, InboxItem, InboxKind, NewItem};
use groundwork_protocol::{AgentInfo, AgentState, ApiError, ErrorCode, Event};
use serde_json::{Value, json};

use crate::{Backend, EventSink};

pub const SOCKET_NAME: &str = "groundwork.sock";
/// The longest one `inbox.wait` call waits; the CLI calls again.
const MAX_WAIT: Duration = Duration::from_secs(60);

pub(crate) struct Agents {
    inbox: Inbox,
    states: Mutex<HashMap<String, AgentInfo>>,
    /// Bumped when an item is answered, for `wait`.
    answered: (Mutex<u64>, Condvar),
    events: EventSink,
}

impl Agents {
    pub fn new(data_dir: &Path, events: EventSink) -> Self {
        Self {
            inbox: Inbox::new(data_dir),
            states: Mutex::new(HashMap::new()),
            answered: (Mutex::new(0), Condvar::new()),
            events,
        }
    }

    pub fn open(&self) -> Vec<InboxItem> {
        self.inbox.open()
    }

    pub fn history(&self) -> Vec<InboxItem> {
        self.inbox.history(200)
    }

    pub fn add(&self, kind: InboxKind, item: NewItem) -> Result<InboxItem, ApiError> {
        let item = self.inbox.add(kind, item)?;
        // Something already done (a finished request's summary) is announced
        // in passing, a notification or a toast, but never waits.
        (self.events)(Event::InboxChanged {
            added: Some(item.clone()),
        });
        Ok(item)
    }

    pub fn answer(&self, id: &str, answer: Option<String>) -> Result<(), ApiError> {
        self.inbox.answer(id, answer)?;
        self.changed();
        Ok(())
    }

    /// Waits until the item is done, or `timeout` passes.
    pub fn wait(&self, id: &str, timeout: Duration) -> Result<InboxItem, ApiError> {
        let timeout = timeout.min(MAX_WAIT);
        let (lock, cv) = &self.answered;
        let mut generation = lock.lock().unwrap();
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let item = self
                .inbox
                .get(id)
                .ok_or_else(|| ApiError::new(ErrorCode::NotFound, format!("no inbox item {id}")))?;
            let now = std::time::Instant::now();
            if item.done || now >= deadline {
                return Ok(item);
            }
            generation = cv.wait_timeout(generation, deadline - now).unwrap().0;
        }
    }

    /// What Claude Code's hooks report for a terminal.
    pub fn hook(
        &self,
        tab: String,
        event: &str,
        session: Option<String>,
        message: Option<String>,
        vault: Option<String>,
    ) -> Result<(), ApiError> {
        let state = match event {
            "session-start" => AgentState::Idle,
            "prompt" => AgentState::Working,
            "notification" => AgentState::Waiting,
            "stop" => AgentState::Finished,
            other => {
                return Err(ApiError::new(
                    ErrorCode::BadRequest,
                    format!("unknown hook event: {other}"),
                ));
            }
        };
        let agent = {
            let mut states = self.states.lock().unwrap();
            let entry = states.entry(tab.clone()).or_insert_with(|| AgentInfo {
                tab: tab.clone(),
                session: None,
                state,
                message: None,
            });
            if session.is_some() {
                entry.session = session;
            }
            entry.state = state;
            entry.message = if state == AgentState::Waiting {
                message.clone()
            } else {
                None
            };
            entry.clone()
        };
        (self.events)(Event::AgentChanged { agent });

        // Only one attention item per terminal, and only while it waits.
        let cleared = self.inbox.clear_attention(&tab)?;
        if state == AgentState::Waiting {
            let text = message
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| "Claude is waiting for you".into());
            self.add(
                InboxKind::Attention,
                NewItem {
                    text,
                    tab: Some(tab),
                    vault,
                    ..Default::default()
                },
            )?;
        } else if cleared {
            self.changed();
        }
        Ok(())
    }

    pub fn list(&self) -> Vec<AgentInfo> {
        self.states.lock().unwrap().values().cloned().collect()
    }

    fn changed(&self) {
        let (lock, cv) = &self.answered;
        *lock.lock().unwrap() += 1;
        cv.notify_all();
        (self.events)(Event::InboxChanged { added: None });
    }
}

/// Listens on the app socket until the backend is dropped or the socket is
/// taken over. Another app (say, the desktop app and a browser dev server
/// on the same data folder) takes it over: the newest one answers the CLI.
pub fn listen(backend: &Arc<Backend>, socket: PathBuf) -> std::io::Result<()> {
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket)?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    let weak = Arc::downgrade(backend);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let Some(backend) = weak.upgrade() else { break };
            std::thread::spawn(move || serve(&backend, stream));
        }
    });
    Ok(())
}

/// The CLI (and so an agent in a terminal) can't unlock, read or change
/// encrypted notes, even ones unlocked in the app. It can lock them.
fn allowed_on_socket(request: &Value) -> bool {
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    !method.starts_with("crypt.") || method == "crypt.lock"
}

fn serve(backend: &Backend, stream: UnixStream) {
    let Ok(read) = stream.try_clone() else { return };
    let mut write = stream;
    for line in BufReader::new(read).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(request) if !allowed_on_socket(&request) => json!({ "error": ApiError::new(
                ErrorCode::Forbidden,
                "encrypted notes can only be opened in the app",
            ) }),
            Ok(request) => match backend.handle_value(request) {
                Ok(value) => json!({ "ok": value }),
                Err(err) => json!({ "error": err }),
            },
            Err(e) => json!({ "error": ApiError::new(ErrorCode::BadRequest, e.to_string()) }),
        };
        if writeln!(write, "{reply}").is_err() {
            break;
        }
    }
}
