//! The daemon itself: sessions, and the socket clients reach them through.
//!
//! Each session runs a program on a PTY. A thread reads its output into a
//! `vt100` emulator, which keeps the screen and scrollback for clients that
//! attach later, and forwards it to the clients attached now. Each connection
//! has a writer thread fed by a channel, so slow clients never block output.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use serde_json::Value;
use vt100::capture::BasicFormattedCaptureRange;

use crate::protocol::{
    Call, CreateSession, ErrorCode, Event, Hello, PROTOCOL, RemoteError, Request, ServerMessage,
    SessionInfo, Snapshot,
};

/// Lines of scrollback each session keeps.
const SCROLLBACK: usize = 5000;
/// How long processes get to exit after a hang-up before they're killed.
const KILL_GRACE: Duration = Duration::from_secs(2);
/// Output that arrives after the program exits (it's still in the PTY).
const DRAIN: Duration = Duration::from_millis(500);
/// How often sessions are checked for a new foreground program or folder.
const POLL: Duration = Duration::from_secs(1);

pub struct Options {
    pub socket: PathBuf,
    /// Stop after this long with no sessions and no clients.
    pub idle_exit: Option<Duration>,
}

/// Serves until a client asks it to shut down, or it has been idle for
/// `idle_exit`. Fails with `AddrInUse` if a daemon already serves `socket`.
pub fn run(opts: Options) -> io::Result<()> {
    if let Some(parent) = opts.socket.parent() {
        fs::create_dir_all(parent)?;
    }
    // Two daemons starting at once would remove each other's socket.
    let Some(_lock) = lock(&opts.socket.with_extension("lock"))? else {
        return Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            "groundworkd is already running",
        ));
    };
    let _ = fs::remove_file(&opts.socket);
    let listener = UnixListener::bind(&opts.socket)?;
    fs::set_permissions(&opts.socket, fs::Permissions::from_mode(0o600))?;

    let daemon = Arc::new(Daemon {
        socket: opts.socket.clone(),
        sessions: Mutex::new(HashMap::new()),
        clients: AtomicUsize::new(0),
        next_client: AtomicU64::new(1),
        next_session: AtomicU64::new(1),
        stopping: AtomicBool::new(false),
    });
    if let Some(idle) = opts.idle_exit {
        let daemon = daemon.clone();
        thread::spawn(move || daemon.watch_idle(idle));
    }
    {
        let daemon = daemon.clone();
        thread::spawn(move || daemon.watch_processes());
    }
    for stream in listener.incoming() {
        if daemon.stopping.load(Ordering::SeqCst) {
            break;
        }
        if let Ok(stream) = stream {
            let daemon = daemon.clone();
            thread::spawn(move || daemon.serve(stream));
        }
    }
    let _ = fs::remove_file(&opts.socket);
    Ok(())
}

/// An exclusive lock on `path`, held while the file stays open; `None` if
/// another process holds it.
fn lock(path: &Path) -> io::Result<Option<File>> {
    let file = File::create(path)?;
    // SAFETY: flock only reads the descriptor, which `file` keeps open.
    let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
    Ok(locked.then_some(file))
}

/// Lines waiting to be written to one connection.
type Outbox = mpsc::Sender<String>;

struct Daemon {
    socket: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    clients: AtomicUsize,
    next_client: AtomicU64,
    next_session: AtomicU64,
    stopping: AtomicBool,
}

impl Daemon {
    fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        // Wakes the accept loop so it sees the flag.
        let _ = UnixStream::connect(&self.socket);
    }

    fn watch_idle(&self, idle: Duration) {
        let mut since: Option<Instant> = None;
        while !self.stopping.load(Ordering::SeqCst) {
            thread::sleep(idle.min(Duration::from_millis(200)));
            let busy = self.clients.load(Ordering::SeqCst) > 0
                || !self.sessions.lock().unwrap().is_empty();
            if busy {
                since = None;
            } else if since.get_or_insert_with(Instant::now).elapsed() >= idle {
                self.stop();
            }
        }
    }

    /// Tells clients when a session's foreground program or folder changes
    /// (a command started or finished, the shell `cd`'d).
    fn watch_processes(&self) {
        while !self.stopping.load(Ordering::SeqCst) {
            thread::sleep(POLL);
            let sessions: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
            for session in sessions {
                session.check_process();
            }
        }
    }

    fn serve(self: Arc<Self>, stream: UnixStream) {
        let client = self.next_client.fetch_add(1, Ordering::SeqCst);
        self.clients.fetch_add(1, Ordering::SeqCst);
        if let (Ok(out), Ok(input)) = (stream.try_clone(), stream.try_clone()) {
            let (tx, rx) = mpsc::channel::<String>();
            thread::spawn(move || write_lines(out, rx));
            for line in BufReader::new(input).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let call = match serde_json::from_str::<Call>(&line) {
                    Ok(call) => call,
                    Err(e) => {
                        let error = RemoteError::new(ErrorCode::BadRequest, e.to_string());
                        let _ = tx.send(encode(&ServerMessage::Reply {
                            id: 0,
                            result: Err(error),
                        }));
                        continue;
                    }
                };
                let shutdown = matches!(call.request, Request::Shutdown);
                let reply = encode(&ServerMessage::Reply {
                    id: call.id,
                    result: self.handle(client, &tx, call.request),
                });
                if shutdown {
                    // Straight to the socket: the process ends once `run` returns.
                    let _ = (&stream).write_all(format!("{reply}\n").as_bytes());
                    self.stop();
                    break;
                }
                let _ = tx.send(reply);
            }
        }
        for session in self.sessions.lock().unwrap().values() {
            session.screen.lock().unwrap().subscribers.remove(&client);
        }
        self.clients.fetch_sub(1, Ordering::SeqCst);
    }

    fn handle(
        self: &Arc<Self>,
        client: u64,
        tx: &Outbox,
        request: Request,
    ) -> Result<Value, RemoteError> {
        match request {
            Request::Hello => json(Hello {
                protocol: PROTOCOL,
                version: env!("CARGO_PKG_VERSION").to_string(),
                pid: std::process::id(),
                sessions: self.sessions.lock().unwrap().len(),
            }),
            Request::Create(spec) => json(self.create(spec)?),
            Request::List => {
                let sessions: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
                let mut sessions: Vec<_> = sessions.iter().map(|s| (s.order, s.info())).collect();
                sessions.sort_by_key(|(order, _)| *order);
                json(
                    sessions
                        .into_iter()
                        .map(|(_, info)| info)
                        .collect::<Vec<_>>(),
                )
            }
            Request::Attach { id, cols, rows } => {
                json(self.session(&id)?.attach(client, tx.clone(), cols, rows)?)
            }
            Request::Input { id, data } => {
                self.session(&id)?.input(data.as_bytes())?;
                Ok(Value::Null)
            }
            Request::Read { id, lines } => json(self.session(&id)?.read(lines)),
            Request::Resize { id, cols, rows } => {
                self.session(&id)?.resize(cols, rows)?;
                Ok(Value::Null)
            }
            Request::Kill { id } => {
                self.session(&id)?.kill();
                Ok(Value::Null)
            }
            Request::Shutdown => {
                for session in self.sessions.lock().unwrap().values() {
                    session.kill();
                }
                Ok(Value::Null)
            }
        }
    }

    fn session(&self, id: &str) -> Result<Arc<Session>, RemoteError> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| RemoteError::new(ErrorCode::NotFound, format!("no terminal {id}")))
    }

    fn create(self: &Arc<Self>, spec: CreateSession) -> Result<SessionInfo, RemoteError> {
        if !spec.cwd.is_dir() {
            return Err(RemoteError::new(
                ErrorCode::BadRequest,
                format!("no folder at {}", spec.cwd.display()),
            ));
        }
        let size = pty_size(spec.cols, spec.rows)?;
        let pair = native_pty_system().openpty(size).map_err(failed)?;
        let mut cmd = match spec.command.split_first() {
            Some((program, args)) => {
                let mut cmd = CommandBuilder::new(program);
                cmd.args(args);
                cmd
            }
            None => CommandBuilder::new_default_prog(),
        };
        let program = match spec.command.first() {
            Some(program) => program.clone(),
            None => cmd.get_shell(),
        };
        let id = new_id();
        cmd.cwd(&spec.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Groundwork");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        cmd.env("GROUNDWORK_TAB_ID", &id);
        // Apps opened from the Finder have no locale, and shells then
        // mangle anything that isn't ASCII.
        if cmd.get_env("LANG").is_none() {
            cmd.env("LANG", "en_US.UTF-8");
        }
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }

        let mut child = pair.slave.spawn_command(cmd).map_err(failed)?;
        // The child has its own copy; ours would keep the PTY open after it exits.
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(failed)?;
        let writer = pair.master.take_writer().map_err(failed)?;
        let rows = std::num::NonZeroU16::new(size.rows).unwrap();
        let cols = std::num::NonZeroU16::new(size.cols).unwrap();
        let session = Arc::new(Session {
            id: id.clone(),
            cwd: spec.cwd,
            program: Path::new(&program)
                .file_name()
                .map_or(program.clone(), |n| n.to_string_lossy().into_owned()),
            pid: child.process_id(),
            started: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_secs()),
            order: self.next_session.fetch_add(1, Ordering::SeqCst),
            seen: Mutex::new((None, None)),
            killer: Mutex::new(child.clone_killer()),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            screen: Mutex::new(Screen {
                parser: vt100::Parser::new_with_callbacks(
                    rows,
                    cols,
                    SCROLLBACK,
                    Callbacks::default(),
                ),
                seq: 0,
                title: String::new(),
                subscribers: HashMap::new(),
            }),
        });
        self.sessions
            .lock()
            .unwrap()
            .insert(id.clone(), session.clone());

        let (drained, wait_drained) = mpsc::channel::<()>();
        let pump = session.clone();
        thread::spawn(move || {
            pump.pump(reader);
            let _ = drained.send(());
        });
        let daemon = self.clone();
        thread::spawn(move || {
            let code = child
                .wait()
                .ok()
                .filter(|status| status.signal().is_none())
                .map(|status| status.exit_code() as i32);
            let _ = wait_drained.recv_timeout(DRAIN);
            daemon.end(&id, code);
        });
        Ok(session.info())
    }

    fn end(&self, id: &str, code: Option<i32>) {
        let Some(session) = self.sessions.lock().unwrap().remove(id) else {
            return;
        };
        let line = encode(&ServerMessage::Event(Event::Exit {
            id: id.to_string(),
            code,
        }));
        for tx in session.screen.lock().unwrap().subscribers.values() {
            let _ = tx.send(line.clone());
        }
    }
}

fn write_lines(mut out: UnixStream, rx: mpsc::Receiver<String>) {
    for line in rx {
        if out
            .write_all(line.as_bytes())
            .and_then(|()| out.write_all(b"\n"))
            .is_err()
        {
            break;
        }
    }
}

struct Session {
    id: String,
    cwd: PathBuf,
    program: String,
    pid: Option<u32>,
    started: u64,
    /// Creation order, for listing.
    order: u64,
    /// The foreground program and folder clients were last told about.
    seen: Mutex<(Option<String>, Option<PathBuf>)>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    screen: Mutex<Screen>,
}

struct Screen {
    parser: vt100::Parser<Callbacks>,
    /// Bytes of output so far.
    seq: u64,
    title: String,
    subscribers: HashMap<u64, Outbox>,
}

/// Collects what the emulator saw that clients need to hear about.
#[derive(Default)]
struct Callbacks {
    title: Option<String>,
    bell: bool,
    /// (title, body)
    notices: Vec<(Option<String>, String)>,
}

impl vt100::Callbacks for Callbacks {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        self.title = Some(String::from_utf8_lossy(title).into_owned());
    }

    fn audible_bell(&mut self, _: &mut vt100::Screen) {
        self.bell = true;
    }

    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
        match params {
            // iTerm2's notification. `9;4;…` is ConEmu's progress report instead.
            [b"9", rest @ ..] if !rest.is_empty() && rest[0] != b"4" => {
                let body: Vec<String> = rest.iter().map(|p| text(p)).collect();
                self.notices.push((None, body.join(";")));
            }
            [b"777", b"notify", title, body @ ..] => {
                let body: Vec<String> = body.iter().map(|p| text(p)).collect();
                self.notices.push((Some(text(title)), body.join(";")));
            }
            _ => {}
        }
    }
}

impl Session {
    /// The foreground program's name, and the shell's current folder.
    fn process(&self) -> (Option<String>, Option<PathBuf>) {
        let foreground = self.master.lock().unwrap().process_group_leader();
        let cwd = self.pid.and_then(|pid| process_cwd(pid as i32));
        (foreground.and_then(process_name), cwd)
    }

    fn check_process(&self) {
        let now = self.process();
        let mut seen = self.seen.lock().unwrap();
        if *seen == now {
            return;
        }
        seen.clone_from(&now);
        let line = encode(&ServerMessage::Event(Event::Process {
            id: self.id.clone(),
            process: now.0,
            cwd: now.1,
        }));
        self.screen
            .lock()
            .unwrap()
            .subscribers
            .retain(|_, tx| tx.send(line.clone()).is_ok());
    }

    fn info(&self) -> SessionInfo {
        let (process, cwd) = self.process();
        let screen = self.screen.lock().unwrap();
        SessionInfo {
            id: self.id.clone(),
            cwd: cwd.unwrap_or_else(|| self.cwd.clone()),
            program: self.program.clone(),
            process,
            title: screen.title.clone(),
            pid: self.pid,
            started: self.started,
            clients: screen.subscribers.len(),
        }
    }

    fn pump(&self, mut reader: Box<dyn Read + Send>) {
        let mut buf = vec![0; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => self.output(&buf[..n]),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                // EIO once the program and everything it started have exited.
                Err(_) => break,
            }
        }
    }

    fn output(&self, bytes: &[u8]) {
        let mut guard = self.screen.lock().unwrap();
        let screen = &mut *guard;
        screen.parser.process(bytes);
        let mut events = vec![Event::Output {
            id: self.id.clone(),
            seq: screen.seq,
            data: BASE64.encode(bytes),
        }];
        screen.seq += bytes.len() as u64;
        let seen = screen.parser.callbacks_mut();
        if let Some(title) = seen.title.take()
            && title != screen.title
        {
            screen.title.clone_from(&title);
            events.push(Event::Title {
                id: self.id.clone(),
                title,
            });
        }
        if std::mem::take(&mut seen.bell) {
            events.push(Event::Bell {
                id: self.id.clone(),
            });
        }
        for (title, body) in seen.notices.drain(..) {
            events.push(Event::Notify {
                id: self.id.clone(),
                title,
                body,
            });
        }
        for event in events {
            let line = encode(&ServerMessage::Event(event));
            screen
                .subscribers
                .retain(|_, tx| tx.send(line.clone()).is_ok());
        }
    }

    fn attach(
        &self,
        client: u64,
        tx: Outbox,
        cols: u16,
        rows: u16,
    ) -> Result<Snapshot, RemoteError> {
        // 0×0: a client that isn't showing it yet, just following it.
        if (cols, rows) != (0, 0) {
            self.resize(cols, rows)?;
        }
        let mut screen = self.screen.lock().unwrap();
        screen.subscribers.insert(client, tx);
        Ok(Snapshot {
            data: snapshot(screen.parser.screen()),
            seq: screen.seq,
        })
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), RemoteError> {
        let size = pty_size(cols, rows)?;
        // The emulator first, so the program's redraw lands at the new size.
        let mut screen = self.screen.lock().unwrap();
        if screen.parser.screen().size() == (nz(size.rows), nz(size.cols)) {
            return Ok(());
        }
        screen.parser.set_size(nz(size.rows), nz(size.cols));
        self.master.lock().unwrap().resize(size).map_err(failed)
    }

    fn input(&self, bytes: &[u8]) -> Result<(), RemoteError> {
        let mut writer = self.writer.lock().unwrap();
        writer
            .write_all(bytes)
            .and_then(|()| writer.flush())
            .map_err(failed)
    }

    fn read(&self, lines: Option<usize>) -> String {
        let screen = self.screen.lock().unwrap();
        text(screen.parser.screen(), lines)
    }

    /// Hangs up, like closing a terminal window; anything still running
    /// after [`KILL_GRACE`] is killed.
    fn kill(self: &Arc<Self>) {
        let foreground = self.master.lock().unwrap().process_group_leader();
        let _ = self.killer.lock().unwrap().kill();
        let groups: Vec<i32> = self
            .pid
            .map(|pid| pid as i32)
            .into_iter()
            .chain(foreground)
            .collect();
        let session = Arc::downgrade(self);
        thread::spawn(move || {
            thread::sleep(KILL_GRACE);
            if session.upgrade().is_some() {
                for group in groups {
                    // SAFETY: killpg takes plain integers.
                    unsafe { libc::killpg(group, libc::SIGKILL) };
                }
            }
        });
    }
}

/// Redraws `screen` on a blank terminal of the same size: the scrollback as
/// lines the client can scroll back through, then the screen exactly
/// (colours, cursor), then the input modes the program set.
fn snapshot(screen: &vt100::Screen) -> String {
    let mut out = String::new();
    if screen.alternate_screen() {
        // Full-screen programs (vim, less) have no scrollback.
        out.push_str("\x1b[?1049h");
    } else {
        let mut lines = String::new();
        let _ = screen.write_contents_formatted_basic(
            &mut lines,
            BasicFormattedCaptureRange::Full(&mut Default::default()),
        );
        out.push_str(&lines.replace('\n', "\r\n"));
        out.push_str("\x1b[0m");
    }
    out.push_str(&screen.contents_formatted());
    out.push_str(&screen.input_mode_formatted());
    out
}

/// The scrollback and screen as plain text, without trailing blank lines
/// (or spaces); the last `lines` of it if given.
fn text(screen: &vt100::Screen, lines: Option<usize>) -> String {
    let mut formatted = String::new();
    let _ = screen.write_contents_formatted_basic(
        &mut formatted,
        BasicFormattedCaptureRange::Full(&mut Default::default()),
    );
    let plain: String = vt100::capture::basic_formatted_to_plain(&formatted).collect();
    let mut rows: Vec<&str> = plain.lines().map(str::trim_end).collect();
    while rows.last().is_some_and(|r| r.is_empty()) {
        rows.pop();
    }
    if let Some(n) = lines {
        rows.drain(..rows.len().saturating_sub(n));
    }
    rows.join("\n")
}

fn nz(n: u16) -> std::num::NonZeroU16 {
    std::num::NonZeroU16::new(n).unwrap_or(std::num::NonZeroU16::MIN)
}

fn pty_size(cols: u16, rows: u16) -> Result<PtySize, RemoteError> {
    if cols == 0 || rows == 0 || cols > 2000 || rows > 1000 {
        return Err(RemoteError::new(
            ErrorCode::BadRequest,
            format!("can't make a terminal {cols}×{rows}"),
        ));
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

/// The process's name as it gives it (`argv[0]`, which Claude Code installed
/// through npm sets to `claude`), else its executable's.
#[cfg(target_os = "macos")]
fn process_name(pid: i32) -> Option<String> {
    let argv0 = process_args(pid).and_then(|args| {
        let first = args.split(|&b| b == 0).next()?;
        let name = String::from_utf8_lossy(first);
        let name = name.rsplit('/').next()?.trim_start_matches('-');
        (!name.is_empty()).then(|| name.to_string())
    });
    argv0.or_else(|| executable_name(pid))
}

/// `argv` and the environment, after the executable path, as the kernel
/// keeps them (KERN_PROCARGS2: argc, the path, NUL padding, then argv).
#[cfg(target_os = "macos")]
fn process_args(pid: i32) -> Option<Vec<u8>> {
    let mut argmax: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    // SAFETY: the sysctl writes one c_int into `argmax`.
    let ok = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            (&raw mut argmax).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if ok != 0 || argmax <= 0 {
        return None;
    }
    let mut buf = vec![0u8; argmax as usize];
    let mut size = buf.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    // SAFETY: the sysctl writes at most `size` bytes into `buf`.
    let ok = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if ok != 0 || size < 4 {
        return None;
    }
    let rest = &buf[4..size];
    let path_end = rest.iter().position(|&b| b == 0)?;
    let args_start = path_end + rest[path_end..].iter().position(|&b| b != 0)?;
    Some(rest[args_start..].to_vec())
}

#[cfg(target_os = "macos")]
fn executable_name(pid: i32) -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: proc_name writes at most `buf.len()` bytes into `buf`.
    let n = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: i32) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    // SAFETY: an all-zero proc_vnodepathinfo is valid (plain integers and
    // arrays), and proc_pidinfo writes at most `size` bytes into it.
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as i32;
    let n = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            (&raw mut info).cast(),
            size,
        )
    };
    if n != size {
        return None;
    }
    let bytes: Vec<u8> = info
        .pvi_cdir
        .vip_path
        .as_flattened()
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    (!bytes.is_empty()).then(|| PathBuf::from(std::ffi::OsStr::from_bytes(&bytes)))
}

#[cfg(not(target_os = "macos"))]
fn process_cwd(pid: i32) -> Option<PathBuf> {
    fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(not(target_os = "macos"))]
fn process_name(pid: i32) -> Option<String> {
    let name = fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    Some(name.trim_end().to_string())
}

/// Random enough that a session saved in a layout never matches a later one.
fn new_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    format!("t{:012x}", hasher.finish() >> 16)
}

fn failed(e: impl std::fmt::Display) -> RemoteError {
    RemoteError::new(ErrorCode::Failed, e.to_string())
}

fn json(value: impl Serialize) -> Result<Value, RemoteError> {
    serde_json::to_value(value).map_err(failed)
}

fn encode(message: &ServerMessage) -> String {
    serde_json::to_string(message).expect("messages serialize")
}
