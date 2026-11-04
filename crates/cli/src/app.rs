//! Reaching the running app over its socket (`$GROUNDWORK_SOCKET`, else
//! `groundwork.sock` in the data folder): the same requests the UI makes,
//! one JSON line each way.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

use groundwork_core::data_dir;
use serde_json::{Value, json};

pub fn socket_path() -> PathBuf {
    std::env::var_os("GROUNDWORK_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir().join("groundwork.sock"))
}

pub enum CallError {
    /// The app isn't running, or went away.
    Unreachable,
    /// The app answered with an error.
    Api { code: String, message: String },
}

impl CallError {
    pub fn message(&self) -> String {
        match self {
            CallError::Unreachable => "Groundwork isn't running".into(),
            CallError::Api { message, .. } => message.clone(),
        }
    }
}

pub struct App {
    write: UnixStream,
    read: BufReader<UnixStream>,
}

impl App {
    /// Connects, if the app is running. `timeout` bounds each reply.
    pub fn connect(timeout: Option<Duration>) -> Option<App> {
        let stream = UnixStream::connect(socket_path()).ok()?;
        stream.set_read_timeout(timeout).ok()?;
        stream.set_write_timeout(timeout).ok()?;
        let read = BufReader::new(stream.try_clone().ok()?);
        Some(App {
            write: stream,
            read,
        })
    }

    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, CallError> {
        let request = json!({ "method": method, "params": params });
        writeln!(self.write, "{request}").map_err(|_| CallError::Unreachable)?;
        let mut line = String::new();
        match self.read.read_line(&mut line) {
            Ok(n) if n > 0 => {}
            _ => return Err(CallError::Unreachable),
        }
        let mut reply: Value = serde_json::from_str(&line).map_err(|_| CallError::Unreachable)?;
        if let Some(error) = reply.get_mut("error") {
            return Err(CallError::Api {
                code: error["code"].as_str().unwrap_or_default().to_string(),
                message: error["message"].as_str().unwrap_or_default().to_string(),
            });
        }
        Ok(reply["ok"].take())
    }
}
