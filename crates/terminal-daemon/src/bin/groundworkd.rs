//! `groundworkd --socket <path>`: runs the terminal daemon.
//! `groundworkd --socket <path> --shutdown`: ends a running one and its sessions.

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use groundwork_terminal_daemon::Client;
use groundwork_terminal_daemon::protocol::Request;
use groundwork_terminal_daemon::server::{self, Options};

/// With nothing to keep running, the daemon goes away after this long.
const IDLE_EXIT: Duration = Duration::from_secs(10);

fn main() -> ExitCode {
    let mut socket = None;
    let mut shutdown = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket = args.next().map(PathBuf::from),
            "--shutdown" => shutdown = true,
            "--version" => {
                println!("groundworkd {}", env!("CARGO_PKG_VERSION"));
                return ExitCode::SUCCESS;
            }
            _ => {
                eprintln!("groundworkd: unknown argument {arg}");
                return ExitCode::from(2);
            }
        }
    }
    let Some(socket) = socket else {
        eprintln!("usage: groundworkd --socket <path> [--shutdown]");
        return ExitCode::from(2);
    };

    if shutdown {
        let Ok(client) = Client::connect(&socket, |_| {}, || {}) else {
            println!("groundworkd isn't running");
            return ExitCode::SUCCESS;
        };
        return match client.call::<()>(Request::Shutdown) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("groundworkd: {e}");
                ExitCode::FAILURE
            }
        };
    }

    match server::run(Options {
        socket,
        idle_exit: Some(IDLE_EXIT),
    }) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("groundworkd: {e}");
            ExitCode::FAILURE
        }
    }
}
