//! Terminals, which live in the `groundworkd` daemon (`crates/terminal-daemon`)
//! so they outlive the app. The backend keeps one connection to it, started
//! on first use, and forwards the events of the terminals it attached to.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use groundwork_protocol::{ApiError, ErrorCode, Event, TerminalInfo, TerminalSnapshot};
use groundwork_terminal_daemon::protocol::{
    self as daemon, CreateSession, Hello, PROTOCOL, Request, SessionInfo, Snapshot,
};
use groundwork_terminal_daemon::{Client, Error};

use crate::EventSink;

pub struct Terminals {
    socket: PathBuf,
    daemon: PathBuf,
    events: EventSink,
    client: Mutex<Option<Arc<Client>>>,
}

impl Terminals {
    pub fn new(data_dir: &Path, events: EventSink) -> Self {
        Self {
            socket: data_dir.join("groundworkd.sock"),
            daemon: daemon_binary(),
            events,
            client: Mutex::new(None),
        }
    }

    pub fn create(
        &self,
        cwd: PathBuf,
        command: Vec<String>,
        env: Vec<(String, String)>,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalInfo, ApiError> {
        let info: SessionInfo = self.call(Request::Create(CreateSession {
            cwd,
            command,
            env,
            cols,
            rows,
        }))?;
        Ok(terminal_info(info))
    }

    pub fn list(&self) -> Result<Vec<TerminalInfo>, ApiError> {
        let sessions: Vec<SessionInfo> = self.call(Request::List)?;
        Ok(sessions.into_iter().map(terminal_info).collect())
    }

    pub fn attach(&self, id: String, cols: u16, rows: u16) -> Result<TerminalSnapshot, ApiError> {
        let Snapshot { data, seq } = self.call(Request::Attach { id, cols, rows })?;
        Ok(TerminalSnapshot { data, seq })
    }

    pub fn input(&self, id: String, data: String) -> Result<(), ApiError> {
        self.call(Request::Input { id, data })
    }

    pub fn resize(&self, id: String, cols: u16, rows: u16) -> Result<(), ApiError> {
        self.call(Request::Resize { id, cols, rows })
    }

    pub fn kill(&self, id: String) -> Result<(), ApiError> {
        self.call(Request::Kill { id })
    }

    fn call<T: serde::de::DeserializeOwned>(&self, request: Request) -> Result<T, ApiError> {
        self.client()?.call(request).map_err(api_error)
    }

    /// The connection, made (and the daemon started) on first use, and again
    /// after the daemon went away.
    fn client(&self) -> Result<Arc<Client>, ApiError> {
        let mut slot = self.client.lock().unwrap();
        if let Some(client) = slot.as_ref().filter(|c| c.is_open()) {
            return Ok(client.clone());
        }
        let mut client = self.connect()?;
        let hello: Hello = client.call(Request::Hello).map_err(api_error)?;
        if hello.protocol != PROTOCOL {
            // Left running by another build of Groundwork.
            if hello.sessions > 0 {
                return Err(ApiError::new(
                    ErrorCode::Conflict,
                    format!(
                        "a terminal daemon from another version of Groundwork is still running {} terminals; \
                         end them with `{} --socket '{}' --shutdown`",
                        hello.sessions,
                        self.daemon.display(),
                        self.socket.display()
                    ),
                ));
            }
            let _ = client.call::<()>(Request::Shutdown);
            drop(client);
            let deadline = Instant::now() + Duration::from_secs(3);
            while self.socket.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            client = self.connect()?;
        }
        let client = Arc::new(client);
        *slot = Some(client.clone());
        Ok(client)
    }

    fn connect(&self) -> Result<Client, ApiError> {
        let events = self.events.clone();
        let lost = self.events.clone();
        Client::connect_or_start(
            &self.socket,
            &self.daemon,
            move |event| events(app_event(event)),
            move || lost(Event::TerminalDisconnected),
        )
        .map_err(|e| {
            ApiError::new(
                ErrorCode::Internal,
                format!(
                    "can't start the terminal daemon ({}): {e}",
                    self.daemon.display()
                ),
            )
        })
    }
}

/// `groundworkd` builds next to the app and the dev server (`target/debug`,
/// or `Contents/MacOS` once bundled). Tests run from `target/debug/deps`.
fn daemon_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("GROUNDWORKD") {
        return path.into();
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().unwrap_or(Path::new("."));
    let beside = dir.join("groundworkd");
    if !beside.exists()
        && let Some(parent) = dir.parent()
        && parent.join("groundworkd").exists()
    {
        return parent.join("groundworkd");
    }
    beside
}

fn app_event(event: daemon::Event) -> Event {
    match event {
        daemon::Event::Output { id, seq, data } => Event::TerminalOutput { id, seq, data },
        daemon::Event::Title { id, title } => Event::TerminalTitle { id, title },
        daemon::Event::Bell { id } => Event::TerminalBell { id },
        daemon::Event::Exit { id, code } => Event::TerminalExit { id, code },
    }
}

fn terminal_info(info: SessionInfo) -> TerminalInfo {
    TerminalInfo {
        id: info.id,
        cwd: info.cwd.display().to_string(),
        program: info.program,
        process: info.process,
        title: info.title,
        started: info.started,
    }
}

fn api_error(error: Error) -> ApiError {
    let code = match &error {
        Error::Remote(e) => match e.code {
            daemon::ErrorCode::NotFound => ErrorCode::NotFound,
            daemon::ErrorCode::BadRequest => ErrorCode::BadRequest,
            daemon::ErrorCode::Failed => ErrorCode::Internal,
        },
        _ => ErrorCode::Internal,
    };
    ApiError::new(code, error.to_string())
}
