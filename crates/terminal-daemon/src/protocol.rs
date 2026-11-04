//! The daemon's wire format: one JSON object per line, in both directions.
//!
//! - client → daemon: [`Call`], `{ "id": 1, "request": { "method": ..., "params": ... } }`
//! - daemon → client: [`ServerMessage`], a reply to a call, or an event for a
//!   session the connection attached to

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped whenever this format changes. The app replaces a running daemon
/// that speaks a different one.
pub const PROTOCOL: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "camelCase")]
pub enum Request {
    /// → [`Hello`]
    Hello,
    /// Starts a session. → [`SessionInfo`]
    Create(CreateSession),
    /// → `Vec<SessionInfo>`
    List,
    /// Resizes the session, subscribes this connection to its events, and
    /// returns what's on screen. → [`Snapshot`]
    Attach { id: String, cols: u16, rows: u16 },
    /// Writes to the session's input. → null
    Input { id: String, data: String },
    /// → null
    Resize { id: String, cols: u16, rows: u16 },
    /// Hangs up the session's processes. → null
    Kill { id: String },
    /// Ends every session and stops the daemon. → null
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSession {
    pub cwd: PathBuf,
    /// Program and arguments; empty for the user's login shell.
    #[serde(default)]
    pub command: Vec<String>,
    /// Set on top of the daemon's own environment.
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub cwd: PathBuf,
    /// The program the session started (`zsh`).
    pub program: String,
    /// What's running in the foreground now (`zsh`, `claude`, `vim`).
    pub process: Option<String>,
    /// Set by the program with an escape sequence; empty if never set.
    pub title: String,
    pub pid: Option<u32>,
    /// Seconds since the Unix epoch.
    pub started: u64,
    /// Connections attached to it.
    pub clients: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    /// Escape sequences that redraw the scrollback, the screen and the input
    /// modes on a blank terminal of the attached size.
    pub data: String,
    /// The output offset the snapshot reflects. Output events continue from
    /// here; ones with a lower `seq` are already in the snapshot.
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub protocol: u32,
    pub version: String,
    pub pid: u32,
    pub sessions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Call {
    pub id: u64,
    pub request: Request,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    NotFound,
    BadRequest,
    Failed,
}

impl RemoteError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerMessage {
    Reply {
        id: u64,
        result: Result<Value, RemoteError>,
    },
    Event(Event),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    /// Bytes the session wrote, base64-encoded; `seq` is the offset of the
    /// first one.
    Output {
        id: String,
        seq: u64,
        data: String,
    },
    Title {
        id: String,
        title: String,
    },
    Bell {
        id: String,
    },
    /// The session's program exited; the session is gone.
    Exit {
        id: String,
        code: Option<i32>,
    },
}
