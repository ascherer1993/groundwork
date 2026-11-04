//! Serves the Groundwork backend over a WebSocket for browser mode.
//!
//! Usage: groundwork-dev-server [--port 1430] [--vault <path>]
//! `GROUNDWORK_DATA_DIR` overrides where machine-local state is kept.

use std::sync::Arc;

use groundwork_backend::Backend;
use groundwork_backend::dev_server::EventHub;
use groundwork_protocol::{Host, Request};

#[tokio::main]
async fn main() {
    let mut port: u16 = 1430;
    let mut vault: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                port = args
                    .next()
                    .and_then(|p| p.parse().ok())
                    .expect("--port <number>")
            }
            "--vault" => vault = Some(args.next().expect("--vault <path>")),
            other => {
                eprintln!(
                    "unknown argument: {other}\nusage: groundwork-dev-server [--port 1430] [--vault <path>]"
                );
                std::process::exit(2);
            }
        }
    }

    let hub = EventHub::new();
    let backend = Arc::new(Backend::new(
        Host::DevServer,
        groundwork_core::data_dir(),
        hub.sink(),
    ));
    if let Some(path) = vault
        && let Err(e) = backend.handle(Request::VaultOpen { path })
    {
        eprintln!("could not open vault: {e}");
        std::process::exit(1);
    }
    if let Err(e) = backend.listen() {
        eprintln!("the groundwork CLI can't reach this server: {e}");
    }

    if let Err(e) = groundwork_backend::dev_server::serve(backend, hub, port).await {
        eprintln!("dev server failed: {e}");
        std::process::exit(1);
    }
}
