//! The app's side of the socket: calls, and events for attached sessions.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::protocol::{Call, ErrorCode, Event, RemoteError, Request, ServerMessage};

/// Calls are quick (none waits on a program), so this only catches a hung daemon.
const TIMEOUT: Duration = Duration::from_secs(10);
/// How long a daemon gets to start listening.
const START_TIMEOUT: Duration = Duration::from_secs(5);

/// Environment the app was started with that shells shouldn't inherit: from
/// the tools that launched it in development, and from a Claude Code session
/// it was launched from.
const UNINHERITED: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_",
    "npm_",
    "INIT_CWD",
    "TAURI_",
    "CARGO_PKG_",
    "CARGO_MANIFEST_",
    "CARGO_PRIMARY_PACKAGE",
    "CARGO_CRATE_",
    "CARGO_BIN_",
];

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("can't reach the terminal daemon: {0}")]
    Io(#[from] io::Error),
    #[error("{}", .0.message)]
    Remote(RemoteError),
    #[error("the terminal daemon disconnected")]
    Closed,
    #[error("the terminal daemon didn't answer")]
    Timeout,
}

type Waiter = mpsc::Sender<Result<Value, RemoteError>>;

struct Pending {
    open: bool,
    waiting: HashMap<u64, Waiter>,
}

pub struct Client {
    stream: Mutex<UnixStream>,
    pending: Arc<Mutex<Pending>>,
    next_id: AtomicU64,
}

impl Client {
    /// Connects to a running daemon. `on_event` gets events for the sessions
    /// this connection attaches to; `on_close` runs once the connection ends.
    pub fn connect(
        socket: &Path,
        on_event: impl Fn(Event) + Send + 'static,
        on_close: impl FnOnce() + Send + 'static,
    ) -> io::Result<Self> {
        let stream = UnixStream::connect(socket)?;
        let reader = BufReader::new(stream.try_clone()?);
        let pending = Arc::new(Mutex::new(Pending {
            open: true,
            waiting: HashMap::new(),
        }));
        let replies = pending.clone();
        thread::spawn(move || {
            for line in reader.lines() {
                let Ok(line) = line else { break };
                match serde_json::from_str::<ServerMessage>(&line) {
                    Ok(ServerMessage::Reply { id, result }) => {
                        if let Some(waiter) = replies.lock().unwrap().waiting.remove(&id) {
                            let _ = waiter.send(result);
                        }
                    }
                    Ok(ServerMessage::Event(event)) => on_event(event),
                    Err(_) => {}
                }
            }
            let mut pending = replies.lock().unwrap();
            pending.open = false;
            // Dropping the waiters fails their calls.
            pending.waiting.clear();
            drop(pending);
            on_close();
        });
        Ok(Self {
            stream: Mutex::new(stream),
            pending,
            next_id: AtomicU64::new(1),
        })
    }

    /// Connects, first starting the daemon (`daemon` is the `groundworkd`
    /// binary) if none is listening on `socket`.
    pub fn connect_or_start(
        socket: &Path,
        daemon: &Path,
        on_event: impl Fn(Event) + Send + 'static,
        on_close: impl FnOnce() + Send + 'static,
    ) -> io::Result<Self> {
        if UnixStream::connect(socket).is_err() {
            start(daemon, socket)?;
            let deadline = Instant::now() + START_TIMEOUT;
            while UnixStream::connect(socket).is_err() {
                if Instant::now() > deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!("{} didn't start", daemon.display()),
                    ));
                }
                thread::sleep(Duration::from_millis(25));
            }
        }
        Self::connect(socket, on_event, on_close)
    }

    pub fn is_open(&self) -> bool {
        self.pending.lock().unwrap().open
    }

    pub fn call<T: DeserializeOwned>(&self, request: Request) -> Result<T, Error> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if !pending.open {
                return Err(Error::Closed);
            }
            pending.waiting.insert(id, tx);
        }
        let mut line = serde_json::to_string(&Call { id, request }).expect("calls serialize");
        line.push('\n');
        if let Err(e) = self.stream.lock().unwrap().write_all(line.as_bytes()) {
            self.pending.lock().unwrap().waiting.remove(&id);
            return Err(e.into());
        }
        match rx.recv_timeout(TIMEOUT) {
            Ok(Ok(value)) => serde_json::from_value(value)
                .map_err(|e| Error::Remote(RemoteError::new(ErrorCode::Failed, e.to_string()))),
            Ok(Err(e)) => Err(Error::Remote(e)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().unwrap().waiting.remove(&id);
                Err(Error::Timeout)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(Error::Closed),
        }
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self
            .stream
            .lock()
            .unwrap()
            .shutdown(std::net::Shutdown::Both);
    }
}

/// Starts `groundworkd` in its own session, so it outlives the app and isn't
/// hung up with the terminal the app was started from.
pub fn start(daemon: &Path, socket: &Path) -> io::Result<()> {
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(socket.with_extension("log"))?;
    let mut cmd = Command::new(daemon);
    cmd.arg("--socket")
        .arg(socket)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if UNINHERITED.iter().any(|prefix| name.starts_with(prefix)) {
            cmd.env_remove(&key);
        }
    }
    // SAFETY: setsid is async-signal-safe, so it's fine between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;
    // Reaped when it exits, so it doesn't linger as a zombie while the app runs.
    thread::spawn(move || child.wait());
    Ok(())
}
