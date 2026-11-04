//! Runs the real `groundworkd` binary against throwaway sockets.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use groundwork_terminal_daemon::Client;
use groundwork_terminal_daemon::client::start;
use groundwork_terminal_daemon::protocol::{
    CreateSession, ErrorCode, Event, Hello, PROTOCOL, Request, SessionInfo, Snapshot,
};
use groundwork_terminal_daemon::server::{self, Options};

const DAEMON: &str = env!("CARGO_BIN_EXE_groundworkd");

struct Daemon {
    dir: tempfile::TempDir,
}

impl Daemon {
    /// A daemon running in this process; stops when idle for `idle`.
    fn in_process(idle: Duration) -> (Self, std::thread::JoinHandle<std::io::Result<()>>) {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("d.sock");
        let handle = std::thread::spawn(move || {
            server::run(Options {
                socket,
                idle_exit: Some(idle),
            })
        });
        let daemon = Self { dir };
        daemon.wait_listening();
        (daemon, handle)
    }

    fn socket(&self) -> PathBuf {
        self.dir.path().join("d.sock")
    }

    fn wait_listening(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while std::os::unix::net::UnixStream::connect(self.socket()).is_err() {
            assert!(Instant::now() < deadline, "daemon didn't start");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn client(&self) -> (Client, mpsc::Receiver<Event>) {
        let (tx, rx) = mpsc::channel();
        let client = Client::connect(
            &self.socket(),
            move |event| {
                let _ = tx.send(event);
            },
            || {},
        )
        .unwrap();
        (client, rx)
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if let Ok(client) = Client::connect(&self.socket(), |_| {}, || {}) {
            let _ = client.call::<()>(Request::Shutdown);
        }
    }
}

fn sh(client: &Client, cwd: &Path, script: &str) -> SessionInfo {
    client
        .call(Request::Create(CreateSession {
            cwd: cwd.to_path_buf(),
            command: vec!["/bin/sh".into(), "-c".into(), script.into()],
            env: vec![("GREETING".into(), "hello from env".into())],
            cols: 80,
            rows: 24,
        }))
        .unwrap()
}

/// Output events for `id` until `done` says the text so far is enough.
fn read_until(events: &mpsc::Receiver<Event>, id: &str, done: impl Fn(&str) -> bool) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut text = String::new();
    while !done(&text) {
        let left = deadline.saturating_duration_since(Instant::now());
        match events.recv_timeout(left) {
            Ok(Event::Output { id: from, data, .. }) if from == id => {
                text.push_str(&String::from_utf8_lossy(&BASE64.decode(data).unwrap()));
            }
            Ok(_) => {}
            Err(_) => panic!("timed out; output so far: {text:?}"),
        }
    }
    text
}

fn attach(client: &Client, id: &str) -> Snapshot {
    client
        .call(Request::Attach {
            id: id.into(),
            cols: 80,
            rows: 24,
        })
        .unwrap()
}

#[test]
fn sessions_run_programs_and_take_input() {
    let (daemon, _) = Daemon::in_process(Duration::from_secs(60));
    let (client, events) = daemon.client();
    let hello: Hello = client.call(Request::Hello).unwrap();
    assert_eq!(hello.protocol, PROTOCOL);

    let work = tempfile::tempdir().unwrap();
    let session = sh(
        &client,
        work.path(),
        "echo \"$GREETING in $(basename \"$PWD\") as $TERM\"; read line; echo \"got $line\"; sleep 30",
    );
    assert_eq!(session.program, "sh");
    attach(&client, &session.id);
    let name = work
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    read_until(&events, &session.id, |t| {
        t.contains(&format!("hello from env in {name} as xterm-256color"))
    });
    client
        .call::<()>(Request::Input {
            id: session.id.clone(),
            data: "typed\r".into(),
        })
        .unwrap();
    read_until(&events, &session.id, |t| t.contains("got typed"));

    let listed: Vec<SessionInfo> = client.call(Request::List).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, session.id);
    assert_eq!(listed[0].clients, 1);
}

#[test]
fn sessions_outlive_their_clients_and_reattach_with_their_screen() {
    let (daemon, _) = Daemon::in_process(Duration::from_secs(60));
    let work = tempfile::tempdir().unwrap();
    let id = {
        let (client, events) = daemon.client();
        let session = sh(
            &client,
            work.path(),
            "for i in $(seq 1 60); do echo line $i; done; printf '\\033[31mred\\033[0m'; printf '\\033]2;My title\\007'; sleep 30",
        );
        attach(&client, &session.id);
        read_until(&events, &session.id, |t| t.contains("My title"));
        session.id
    };

    // A new client gets the scrollback and the screen.
    let (client, _events) = daemon.client();
    let snapshot = attach(&client, &id);
    assert!(snapshot.seq > 0);
    assert!(snapshot.data.contains("line 1\r\n"), "{:?}", snapshot.data);
    assert!(snapshot.data.contains("line 60"));
    assert!(snapshot.data.contains("\x1b[31mred"), "{:?}", snapshot.data);
    let listed: Vec<SessionInfo> = client.call(Request::List).unwrap();
    assert_eq!(listed[0].title, "My title");

    // Replaying it into a fresh emulator gives the same screen.
    let mut replay = vt100::Parser::new(24.try_into().unwrap(), 80.try_into().unwrap(), 0);
    replay.process(snapshot.data.as_bytes());
    let screen = replay.screen().contents();
    assert!(screen.contains("line 60\nred"), "{screen}");
    assert!(!screen.contains("line 30\n"), "{screen}");

    // A client that only follows it (0×0) leaves its size alone.
    let (watcher, _events) = daemon.client();
    let followed: Snapshot = watcher
        .call(Request::Attach {
            id: id.clone(),
            cols: 0,
            rows: 0,
        })
        .unwrap();
    let mut replay = vt100::Parser::new(24.try_into().unwrap(), 80.try_into().unwrap(), 0);
    replay.process(followed.data.as_bytes());
    assert_eq!(replay.screen().contents(), screen);
}

#[test]
fn programs_folders_and_notifications_are_reported() {
    let (daemon, _) = Daemon::in_process(Duration::from_secs(60));
    let (client, events) = daemon.client();
    let work = tempfile::tempdir().unwrap();
    let sub = work.path().join("sub");
    std::fs::create_dir(&sub).unwrap();
    // A shell that moves, runs a command, and asks for attention.
    let session = sh(
        &client,
        work.path(),
        "cd sub; read go; printf '\\033]9;Claude needs you\\007\\033]9;4;1;50\\007\\033]777;notify;Build;done\\007'; exec /bin/sh -i",
    );
    attach(&client, &session.id);
    // Only attached clients hear notifications, so it waits until now.
    client
        .call::<()>(Request::Input {
            id: session.id.clone(),
            data: "go\r".into(),
        })
        .unwrap();
    // An interactive shell runs commands as their own foreground job, named
    // as they name themselves (as Claude Code does: node, calling itself claude).
    client
        .call::<()>(Request::Input {
            id: session.id.clone(),
            data: "/bin/bash -c 'exec -a dozing sleep 3'\r".into(),
        })
        .unwrap();

    let sub = std::fs::canonicalize(&sub).unwrap();
    let (mut notices, mut sleeping, mut moved) = (Vec::new(), false, false);
    let deadline = Instant::now() + Duration::from_secs(10);
    while notices.len() < 2 || !sleeping || !moved {
        match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Event::Notify { title, body, .. }) => notices.push((title, body)),
            Ok(Event::Process { process, cwd, .. }) => {
                sleeping |= process.as_deref() == Some("dozing");
                moved |= cwd.as_deref() == Some(sub.as_path());
            }
            Ok(_) => {}
            Err(_) => panic!("notices {notices:?}, sleeping {sleeping}, moved {moved}"),
        }
    }
    assert_eq!(
        notices,
        [
            (None, "Claude needs you".to_string()),
            (Some("Build".to_string()), "done".to_string())
        ]
    );
    let listed: Vec<SessionInfo> = client.call(Request::List).unwrap();
    assert_eq!(listed[0].cwd, sub);
}

#[test]
fn exits_and_kills_are_reported() {
    let (daemon, _) = Daemon::in_process(Duration::from_secs(60));
    let (client, events) = daemon.client();
    let work = tempfile::tempdir().unwrap();

    let quick = sh(&client, work.path(), "read x; exit 3");
    attach(&client, &quick.id);
    let killed = sh(&client, work.path(), "trap '' HUP; echo ready; sleep 30");
    attach(&client, &killed.id);
    read_until(&events, &killed.id, |t| t.contains("ready"));
    client
        .call::<()>(Request::Kill {
            id: killed.id.clone(),
        })
        .unwrap();

    let started = Instant::now();
    client
        .call::<()>(Request::Input {
            id: quick.id.clone(),
            data: "\r".into(),
        })
        .unwrap();
    let mut exits = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    while exits.len() < 2 {
        match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Event::Exit { id, code }) => exits.push((id, code)),
            Ok(_) => {}
            Err(_) => panic!("exits so far: {exits:?}"),
        }
    }
    assert!(exits.contains(&(quick.id.clone(), Some(3))), "{exits:?}");
    // This one ignored the hang-up, so it was killed after the grace period.
    assert!(exits.contains(&(killed.id.clone(), None)), "{exits:?}");
    assert!(started.elapsed() >= Duration::from_millis(1500));

    let listed: Vec<SessionInfo> = client.call(Request::List).unwrap();
    assert!(listed.is_empty());
    let err = client
        .call::<Snapshot>(Request::Attach {
            id: quick.id,
            cols: 80,
            rows: 24,
        })
        .unwrap_err();
    assert!(
        matches!(&err, groundwork_terminal_daemon::Error::Remote(e) if e.code == ErrorCode::NotFound),
        "{err}"
    );
}

#[test]
fn bad_requests_are_refused() {
    let (daemon, _) = Daemon::in_process(Duration::from_secs(60));
    let (client, _) = daemon.client();
    let err = client
        .call::<SessionInfo>(Request::Create(CreateSession {
            cwd: "/no/such/folder".into(),
            command: vec![],
            env: vec![],
            cols: 80,
            rows: 24,
        }))
        .unwrap_err();
    assert!(err.to_string().contains("no folder"), "{err}");
    let work = tempfile::tempdir().unwrap();
    let session = sh(&client, work.path(), "sleep 30");
    let err = client
        .call::<()>(Request::Resize {
            id: session.id,
            cols: 0,
            rows: 24,
        })
        .unwrap_err();
    assert!(err.to_string().contains("0×24"), "{err}");
}

#[test]
fn an_idle_daemon_exits_and_a_busy_one_doesnt() {
    let (daemon, handle) = Daemon::in_process(Duration::from_millis(300));
    let work = tempfile::tempdir().unwrap();
    {
        let (client, _) = daemon.client();
        sh(&client, work.path(), "sleep 1");
    }
    // The session keeps it running after the client goes; once it ends,
    // the daemon stops and removes its socket.
    std::thread::sleep(Duration::from_millis(600));
    assert!(!handle.is_finished());
    handle.join().unwrap().unwrap();
    assert!(!daemon.socket().exists());
}

#[test]
fn the_binary_starts_detached_and_one_instance_serves() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("d.sock");
    let (tx, events) = mpsc::channel();
    let client = Client::connect_or_start(
        &socket,
        Path::new(DAEMON),
        move |event| {
            let _ = tx.send(event);
        },
        || {},
    )
    .unwrap();
    let hello: Hello = client.call(Request::Hello).unwrap();

    // A second start loses the race and exits; the first keeps serving.
    start(Path::new(DAEMON), &socket).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let again = Client::connect(&socket, |_| {}, || {}).unwrap();
    assert_eq!(again.call::<Hello>(Request::Hello).unwrap().pid, hello.pid);
    let log = std::fs::read_to_string(socket.with_extension("log")).unwrap();
    assert!(log.contains("already running"), "{log}");

    let session = sh(&client, dir.path(), "echo up; sleep 30");
    attach(&client, &session.id);
    read_until(&events, &session.id, |t| t.contains("up"));

    let status = std::process::Command::new(DAEMON)
        .args([
            "--socket".as_ref(),
            socket.as_os_str(),
            "--shutdown".as_ref(),
        ])
        .status()
        .unwrap();
    assert!(status.success());
    let deadline = Instant::now() + Duration::from_secs(5);
    while socket.exists() {
        assert!(Instant::now() < deadline, "daemon didn't stop");
        std::thread::sleep(Duration::from_millis(20));
    }
}
