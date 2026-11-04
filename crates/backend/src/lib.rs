//! Request dispatch shared by every Groundwork API host.
//!
//! The Tauri app and the browser dev server both own one [`Backend`], pass
//! every request through [`Backend::handle_value`], and forward the events it
//! emits, so the UI behaves the same in either.

#[cfg(feature = "dev-server")]
pub mod dev_server;
mod page_server;
mod terminals;

pub use page_server::PageFile;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::NaiveDate;
use groundwork_core::pages;
use groundwork_core::search;
use groundwork_core::setup::{self, SetupEnv, SetupStatus};
use groundwork_core::watch::{self, VaultWatcher};
use groundwork_core::{FileChange, RecentVaults, Session, Vault};
use groundwork_protocol::{
    ApiError, AppInfo, CreatedNote, ErrorCode, Event, Host, RenderedTemplate, Request, WriteResult,
};
use serde::Serialize;
use serde_json::Value;

/// Receives events for the UI. Hosts forward them over their transport.
pub type EventSink = Arc<dyn Fn(Event) + Send + Sync>;

struct OpenVault {
    session: Arc<Session>,
    _watcher: Option<VaultWatcher>,
}

pub struct Backend {
    host: Host,
    data_dir: PathBuf,
    recent: RecentVaults,
    open: Mutex<Option<OpenVault>>,
    events: EventSink,
    /// See [`page_server`].
    page_token: String,
    terminals: terminals::Terminals,
}

impl Backend {
    pub fn new(host: Host, data_dir: PathBuf, events: EventSink) -> Self {
        Self {
            host,
            recent: RecentVaults::new(&data_dir),
            terminals: terminals::Terminals::new(&data_dir, events.clone()),
            data_dir,
            open: Mutex::new(None),
            events,
            page_token: page_server::new_token(),
        }
    }

    /// Parses and handles a raw JSON request.
    pub fn handle_value(&self, request: Value) -> Result<Value, ApiError> {
        let request: Request = serde_json::from_value(request)
            .map_err(|e| ApiError::new(ErrorCode::BadRequest, e.to_string()))?;
        self.handle(request)
    }

    pub fn handle(&self, request: Request) -> Result<Value, ApiError> {
        match request {
            Request::AppInfo => to_value(AppInfo {
                version: env!("CARGO_PKG_VERSION").to_string(),
                host: self.host,
                page_token: self.page_token.clone(),
            }),

            Request::VaultRecent => to_value(self.recent.list()),
            Request::VaultForget { path } => {
                self.recent.remove(&path)?;
                Ok(Value::Null)
            }
            Request::VaultOpen { path } => to_value(self.open_vault(&path)?),
            Request::VaultCurrent => {
                let open = self.open.lock().unwrap();
                to_value(open.as_ref().map(|o| o.session.vault().info()))
            }
            Request::VaultClose => {
                self.close_vault();
                Ok(Value::Null)
            }
            Request::VaultTree => to_value(self.session()?.vault().tree()?),

            Request::IndexFiles => to_value(self.session()?.index().summaries()),
            Request::IndexNote { path } => {
                let session = self.session()?;
                let index = session.index();
                to_value(index.note(&path))
            }
            Request::IndexSettings => to_value(self.session()?.index().settings()),
            Request::SetupStatus => to_value(self.setup_status()),
            Request::SetupInstallCli => {
                self.setup_env().install_cli()?;
                to_value(self.setup_status())
            }
            Request::SetupInstallPlugin => {
                self.setup_env().install_plugin()?;
                to_value(self.setup_status())
            }
            Request::SetupUseVault => {
                let session = self.session()?;
                setup::set_default_vault(&self.data_dir, session.vault().root())?;
                to_value(self.setup_status())
            }
            Request::IndexTags => to_value(search::tags(&self.session()?.index())),
            Request::SearchQuery { query, limit } => to_value(search::search(
                &self.session()?.index(),
                &query,
                limit.unwrap_or(100),
            )),

            Request::LinksResolve { source, targets } => {
                let session = self.session()?;
                let index = session.index();
                let resolved: Vec<Option<String>> =
                    targets.iter().map(|t| index.resolve(t, &source)).collect();
                to_value(resolved)
            }
            Request::LinksBacklinks { path } => to_value(self.session()?.index().backlinks(&path)),
            Request::LinksOutgoing { path } => to_value(self.session()?.index().outgoing(&path)),
            Request::LinksUnlinked { path } => {
                to_value(self.session()?.index().unlinked_mentions(&path))
            }
            Request::LinksLinkMention {
                source,
                start,
                end,
                text,
                target,
            } => {
                let changes = self
                    .session()?
                    .link_mention(&source, start..end, &text, &target)?;
                self.emit(changes);
                Ok(Value::Null)
            }
            Request::LinksFormat {
                source,
                target,
                subpath,
                alias,
                embed,
            } => {
                let session = self.session()?;
                let index = session.index();
                let kind = if index.settings().markdown_links {
                    groundwork_core::parse::LinkKind::Markdown
                } else {
                    groundwork_core::parse::LinkKind::Wiki
                };
                to_value(index.format_link(
                    &target,
                    &source,
                    kind,
                    subpath.as_deref(),
                    alias.as_deref(),
                    embed.unwrap_or(false),
                ))
            }

            Request::PageState { path } => Ok(self.session()?.page_state(&path)?),
            Request::PageSetState { path, state } => {
                self.session()?.set_page_state(&path, &state)?;
                (self.events)(Event::PageStateChanged { path });
                Ok(Value::Null)
            }

            Request::FileRead { path } => to_value(self.session()?.vault().read_file(&path)?),
            Request::FileWrite { path, text } => {
                let (hash, changes) = self.session()?.write_file(&path, &text)?;
                self.emit(changes);
                to_value(WriteResult { hash })
            }
            Request::FileCreate { path, text } => {
                let changes = self.session()?.create_file(&path, text.as_deref())?;
                self.emit(changes);
                to_value(path)
            }
            Request::FileCreateUntitled { folder } => {
                let (path, changes) = self.session()?.create_untitled(&folder)?;
                self.emit(changes);
                to_value(path)
            }
            Request::FileCreateFromLink { source, target } => {
                let (path, changes) = self.session()?.create_from_link(&source, &target)?;
                self.emit(changes);
                to_value(path)
            }
            Request::FileCreateFromTemplate {
                template,
                path,
                answers,
                date,
            } => {
                let date = date.as_deref().map(parse_date).transpose()?;
                let session = self.session()?;
                let (cursor, changes) =
                    session.create_from_template(&template, &path, date, answers)?;
                self.emit(changes);
                let cursor = match cursor {
                    Some(byte) => {
                        let text = std::fs::read_to_string(session.vault().resolve(&path)?)
                            .map_err(groundwork_core::CoreError::from)?;
                        Some(utf16_offset(&text, byte))
                    }
                    None => None,
                };
                to_value(CreatedNote { path, cursor })
            }
            Request::FileRename { from, to } => {
                let (outcome, changes) = self.session()?.rename(&from, &to)?;
                self.emit(changes);
                to_value(outcome)
            }
            Request::FileDelete { path } => {
                let changes = self.session()?.delete(&path)?;
                self.emit(changes);
                Ok(Value::Null)
            }
            Request::FolderCreate { path } => {
                self.session()?.create_folder(&path)?;
                Ok(Value::Null)
            }

            Request::HistoryPeek => to_value(self.session()?.undo_label()),
            Request::HistoryUndo => {
                let (label, changes) = self.session()?.undo()?;
                self.emit(changes);
                to_value(label)
            }

            Request::TemplateList => to_value(self.session()?.templates()),
            Request::TemplatePrompts { template } => {
                to_value(self.session()?.template_prompts(&template)?)
            }
            Request::TemplateRender {
                template,
                path,
                answers,
            } => {
                let rendered = self.session()?.render_template(&template, &path, answers)?;
                to_value(RenderedTemplate {
                    cursor: rendered.cursor.map(|b| utf16_offset(&rendered.text, b)),
                    text: rendered.text,
                })
            }

            Request::DailyOpen { date } => {
                let date = match date {
                    Some(d) => parse_date(&d)?,
                    None => chrono::Local::now().date_naive(),
                };
                let (path, changes) = self.session()?.daily_note(date)?;
                self.emit(changes);
                to_value(path)
            }

            Request::TodoList { filter } => to_value(self.session()?.todos(&filter)),
            Request::TodoDay { path } => to_value(self.session()?.todo_day(&path)),
            Request::TodoUpdate { id, change } => {
                let changes = self.session()?.update_task(&id, &change)?;
                self.emit(changes);
                Ok(Value::Null)
            }
            Request::TodoAdd {
                path,
                text,
                due,
                priority,
            } => {
                let today = chrono::Local::now().date_naive();
                let due = match due {
                    Some(text) => Some(
                        groundwork_core::dates::parse_natural(&text, today).ok_or_else(|| {
                            ApiError::new(ErrorCode::BadRequest, format!("not a date: {text}"))
                        })?,
                    ),
                    None => None,
                };
                let (id, changes) =
                    self.session()?
                        .add_task(path.as_deref(), &text, due, priority.unwrap_or(3))?;
                self.emit(changes);
                to_value(id)
            }

            Request::TaskToggle { path, line } => {
                let changes = self.session()?.toggle_task(&path, line)?;
                self.emit(changes);
                Ok(Value::Null)
            }

            Request::OsReveal { path } => {
                let full = self.session()?.vault().resolve(&path)?;
                open_with_system(&["-R".into(), full.into_os_string()])?;
                Ok(Value::Null)
            }
            Request::OsOpen { path } => {
                let full = self.session()?.vault().resolve(&path)?;
                open_with_system(&[full.into_os_string()])?;
                Ok(Value::Null)
            }

            Request::TerminalCreate {
                cwd,
                command,
                workspace,
                cols,
                rows,
            } => {
                let vault = self.session().ok().map(|s| s.vault().root().to_path_buf());
                let cwd = match cwd {
                    Some(cwd) if Path::new(&cwd).is_absolute() => PathBuf::from(cwd),
                    Some(cwd) => {
                        return Err(ApiError::new(
                            ErrorCode::BadRequest,
                            format!("not an absolute folder: {cwd}"),
                        ));
                    }
                    None => vault
                        .clone()
                        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
                        .unwrap_or_else(|| "/".into()),
                };
                let mut env = self.terminal_env(vault.as_deref());
                if let Some(workspace) = workspace {
                    env.push(("GROUNDWORK_WORKSPACE_ID".into(), workspace));
                }
                to_value(self.terminals.create(
                    cwd,
                    command.unwrap_or_default(),
                    env,
                    cols,
                    rows,
                )?)
            }
            Request::TerminalList => to_value(self.terminals.list()?),
            Request::TerminalAttach { id, cols, rows } => {
                to_value(self.terminals.attach(id, cols, rows)?)
            }
            Request::TerminalInput { id, data } => {
                self.terminals.input(id, data)?;
                Ok(Value::Null)
            }
            Request::TerminalResize { id, cols, rows } => {
                self.terminals.resize(id, cols, rows)?;
                Ok(Value::Null)
            }
            Request::TerminalKill { id } => {
                self.terminals.kill(id)?;
                Ok(Value::Null)
            }

            Request::WorkspaceList => to_value(self.session()?.workspaces().list()),
            Request::WorkspaceCreate { name, cwd } => {
                let session = self.session()?;
                let root = session.vault().root().display().to_string();
                to_value(
                    session
                        .workspaces()
                        .create(&name, cwd.as_deref().unwrap_or(&root))?,
                )
            }
            Request::WorkspaceUpdate { id, name, cwd } => to_value(
                self.session()?
                    .workspaces()
                    .update(&id, name.as_deref(), cwd.as_deref())?,
            ),
            Request::WorkspaceSaveLayout { id, layout } => {
                self.session()?.workspaces().save_layout(&id, layout)?;
                Ok(Value::Null)
            }
            Request::WorkspaceDelete { id } => {
                self.session()?.workspaces().delete(&id)?;
                Ok(Value::Null)
            }
        }
    }

    /// What every terminal gets on top of the daemon's environment: the
    /// vault, and the `groundwork` CLI on PATH, so Claude Code sessions in
    /// them work without "Set up Claude Code…".
    fn terminal_env(&self, vault: Option<&Path>) -> Vec<(String, String)> {
        let mut env = Vec::new();
        if let Some(vault) = vault {
            env.push(("GROUNDWORK_VAULT".into(), vault.display().to_string()));
        }
        if let Some(dir) = self.setup_env().cli.parent() {
            let path = match std::env::var("PATH") {
                Ok(path) if !path.is_empty() => format!("{}:{path}", dir.display()),
                _ => dir.display().to_string(),
            };
            env.push(("PATH".into(), path));
        }
        env
    }

    /// Raw bytes of a vault file (a bundle serves its `index.html`), with a
    /// MIME type. Hosts use this to serve images and pages to the UI.
    pub fn read_bytes(&self, path: &str) -> Result<(Vec<u8>, String), ApiError> {
        let session = self.session()?;
        let mut full = session.vault().resolve(path)?;
        if full.is_dir() {
            full = full.join("index.html");
        }
        let bytes = std::fs::read(&full)
            .map_err(|_| ApiError::new(ErrorCode::NotFound, format!("not found: {path}")))?;
        let mime = mime_guess::from_path(&full)
            .first_or_octet_stream()
            .essence_str()
            .to_string();
        Ok((bytes, mime))
    }

    /// Saves state before the host exits.
    pub fn shutdown(&self) {
        self.close_vault();
    }

    fn open_vault(&self, path: &str) -> Result<groundwork_core::VaultInfo, ApiError> {
        let vault = Vault::open(path)?;
        let info = vault.info();
        // Drop the previous session (and its watcher) first.
        self.close_vault();
        let session = Arc::new(Session::open(vault, &self.data_dir)?);

        let weak = Arc::downgrade(&session);
        let events = self.events.clone();
        let watcher = watch::watch(session.vault().root(), move |paths| {
            if let Some(session) = weak.upgrade() {
                let changes = session.apply_external(&paths);
                if !changes.is_empty() {
                    events(Event::VaultChanged { changes });
                }
                for path in paths.iter().filter_map(|p| pages::page_for_state_path(p)) {
                    events(Event::PageStateChanged { path });
                }
            }
        })
        .map_err(|e| eprintln!("groundwork: file watching unavailable: {e}"))
        .ok();

        self.recent.touch(&info)?;
        *self.open.lock().unwrap() = Some(OpenVault {
            session,
            _watcher: watcher,
        });
        Ok(info)
    }

    fn close_vault(&self) {
        // Dropping the session saves its snapshot.
        self.open.lock().unwrap().take();
    }

    fn setup_env(&self) -> SetupEnv {
        SetupEnv {
            data_dir: self.data_dir.clone(),
            ..SetupEnv::detect()
        }
    }

    fn setup_status(&self) -> SetupStatus {
        let vault = self.session().ok();
        self.setup_env()
            .status(vault.as_ref().map(|s| s.vault().root()))
    }

    fn session(&self) -> Result<Arc<Session>, ApiError> {
        self.open
            .lock()
            .unwrap()
            .as_ref()
            .map(|o| o.session.clone())
            .ok_or_else(|| ApiError::new(ErrorCode::NoVault, "no vault is open"))
    }

    fn emit(&self, changes: Vec<FileChange>) {
        if !changes.is_empty() {
            (self.events)(Event::VaultChanged { changes });
        }
    }
}

fn parse_date(text: &str) -> Result<NaiveDate, ApiError> {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").map_err(|_| {
        ApiError::new(
            ErrorCode::BadRequest,
            format!("not a YYYY-MM-DD date: {text}"),
        )
    })
}

/// A byte offset as UTF-16 code units, the way editors count.
fn utf16_offset(text: &str, byte: usize) -> u32 {
    text[..byte.min(text.len())].encode_utf16().count() as u32
}

fn to_value(value: impl Serialize) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|e| ApiError::new(ErrorCode::Internal, e.to_string()))
}

#[cfg(target_os = "macos")]
fn open_with_system(args: &[std::ffi::OsString]) -> Result<(), ApiError> {
    let status = std::process::Command::new("open")
        .args(args)
        .status()
        .map_err(|e| ApiError::new(ErrorCode::Internal, e.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(ApiError::new(ErrorCode::Internal, "`open` failed"))
    }
}

#[cfg(not(target_os = "macos"))]
fn open_with_system(_args: &[std::ffi::OsString]) -> Result<(), ApiError> {
    Err(ApiError::new(
        ErrorCode::Internal,
        "not supported on this platform yet",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::mpsc;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/vault");

    struct Harness {
        backend: Backend,
        events: mpsc::Receiver<Event>,
        data: tempfile::TempDir,
        vault: tempfile::TempDir,
    }

    /// A backend with a copy of the fixture vault open.
    fn harness() -> Harness {
        let data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        copy_dir(std::path::Path::new(FIXTURE), vault.path());
        // Left over from using the fixture vault in the app.
        let _ = std::fs::remove_dir_all(vault.path().join(".groundwork/page-state"));
        let _ = std::fs::remove_file(
            vault
                .path()
                .join("Projects/Acme/demos/login-flow.page/state.json"),
        );
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let backend = Backend::new(
            Host::DevServer,
            data.path().to_path_buf(),
            Arc::new(move |e| {
                let _ = tx.lock().unwrap().send(e);
            }),
        );
        backend
            .handle_value(json!({ "method": "vault.open", "params": { "path": vault.path() } }))
            .unwrap();
        Harness {
            backend,
            events: rx,
            data,
            vault,
        }
    }

    #[test]
    fn terminals_start_in_the_vault_with_the_cli_on_path() {
        let h = harness();
        let socket = h.data.path().join("groundworkd.sock");
        let daemon_socket = socket.clone();
        std::thread::spawn(move || {
            groundwork_terminal_daemon::server::run(groundwork_terminal_daemon::server::Options {
                socket: daemon_socket,
                idle_exit: Some(std::time::Duration::from_secs(5)),
            })
        });
        while !socket.exists() {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        let script = r#"echo "vault=$GROUNDWORK_VAULT"; echo "first=${PATH%%:*}"; read x"#;
        let info = h.call(json!({ "method": "terminal.create", "params": {
            "command": ["/bin/sh", "-c", script], "cols": 100, "rows": 30,
        }}));
        let id = info["id"].as_str().unwrap().to_string();
        let root = std::fs::canonicalize(h.vault.path()).unwrap();
        assert_eq!(info["cwd"], root.display().to_string());
        let listed = h.call(json!({ "method": "terminal.list" }));
        assert_eq!(listed.as_array().unwrap().len(), 1);

        h.call(
            json!({ "method": "terminal.attach", "params": { "id": id, "cols": 100, "rows": 30 } }),
        );
        let cli_dir = SetupEnv::detect()
            .cli
            .parent()
            .unwrap()
            .display()
            .to_string();
        let expected = [
            format!("vault={}", root.display()),
            format!("first={cli_dir}"),
        ];
        let mut output = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !expected.iter().all(|e| output.contains(e.as_str())) {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match h.events.recv_timeout(left) {
                Ok(Event::TerminalOutput { id: from, data, .. }) if from == id => {
                    use base64::Engine;
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .unwrap();
                    output.push_str(&String::from_utf8_lossy(&bytes));
                }
                Ok(_) => {}
                Err(_) => panic!("output so far: {output:?}"),
            }
        }

        h.call(json!({ "method": "terminal.input", "params": { "id": id, "data": "\r" } }));
        loop {
            match h.events.recv_timeout(std::time::Duration::from_secs(10)) {
                Ok(Event::TerminalExit { id: from, code }) if from == id => {
                    assert_eq!(code, Some(0));
                    break;
                }
                Ok(_) => {}
                Err(_) => panic!("no exit"),
            }
        }
        let err = h
            .backend
            .handle_value(json!({ "method": "terminal.kill", "params": { "id": id } }))
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        let err = h
            .backend
            .handle_value(json!({ "method": "terminal.create", "params": {
                "cwd": "relative/path", "cols": 80, "rows": 24,
            }}))
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::BadRequest);
    }

    fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let dest = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                std::fs::create_dir_all(&dest).unwrap();
                copy_dir(&entry.path(), &dest);
            } else {
                std::fs::copy(entry.path(), dest).unwrap();
            }
        }
    }

    impl Harness {
        fn call(&self, request: Value) -> Value {
            self.backend.handle_value(request).unwrap()
        }
    }

    #[test]
    fn requires_an_open_vault() {
        let data = tempfile::tempdir().unwrap();
        let backend = Backend::new(Host::DevServer, data.path().into(), Arc::new(|_| {}));
        let err = backend
            .handle_value(json!({ "method": "vault.tree" }))
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NoVault);
    }

    #[test]
    fn rejects_unknown_methods() {
        let h = harness();
        let err = h
            .backend
            .handle_value(json!({ "method": "nope" }))
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::BadRequest);
    }

    #[test]
    fn open_read_and_index() {
        let h = harness();
        let recent = h.call(json!({ "method": "vault.recent" }));
        assert_eq!(recent[0]["exists"], true);
        let file = h.call(json!({ "method": "file.read", "params": { "path": "Welcome.md" } }));
        assert_eq!(file["kind"], "note");
        let files = h.call(json!({ "method": "index.files" }));
        assert!(
            files
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["title"] == "Jane Doe")
        );
        let resolved = h.call(json!({ "method": "links.resolve", "params": { "source": "Welcome.md", "targets": ["Acme", "Nope"] } }));
        assert_eq!(resolved, json!(["Projects/Acme/Acme.md", null]));
    }

    #[test]
    fn rename_emits_moves_and_rewrites() {
        let h = harness();
        let outcome = h.call(json!({ "method": "file.rename", "params": {
            "from": "Contacts/Jane Doe.md", "to": "Contacts/Jane Smith.md" } }));
        assert_eq!(outcome["updatedNotes"].as_array().unwrap().len(), 5);
        let Event::VaultChanged { changes } = h.events.try_recv().unwrap() else {
            panic!("expected a vault change");
        };
        assert!(
            changes
                .iter()
                .any(|c| c.from.as_deref() == Some("Contacts/Jane Doe.md"))
        );
        let welcome = std::fs::read_to_string(h.vault.path().join("Welcome.md")).unwrap();
        assert!(welcome.contains("[[Jane Smith|Jane]]"), "{welcome}");

        let label = h.call(json!({ "method": "history.undo" }));
        assert_eq!(label, "Rename Jane Doe.md to Jane Smith.md");
        let welcome = std::fs::read_to_string(h.vault.path().join("Welcome.md")).unwrap();
        assert!(welcome.contains("[[Jane Doe|Jane]]"));
    }

    #[test]
    fn serves_bytes_with_mime_types() {
        let h = harness();
        let (bytes, mime) = h
            .backend
            .read_bytes("Projects/Acme/demos/login-flow.page")
            .unwrap();
        assert_eq!(mime, "text/html");
        assert!(String::from_utf8(bytes).unwrap().contains("Login flow"));
        let (_, mime) = h
            .backend
            .read_bytes("Projects/Acme/demos/login-flow.page/app.js")
            .unwrap();
        assert!(mime.contains("javascript"), "{mime}");
        let err = h.backend.read_bytes("../secret").unwrap_err();
        assert_eq!(err.code, ErrorCode::Forbidden);
    }

    #[test]
    fn external_edits_are_pushed() {
        let h = harness();
        std::fs::write(h.vault.path().join("Welcome.md"), "changed outside").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let event = h
                .events
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .expect("no event within 5s");
            if let Event::VaultChanged { changes } = event
                && changes.iter().any(|c| c.path == "Welcome.md" && c.external)
            {
                break;
            }
        }
    }

    fn page(h: &Harness, path: &str) -> Result<PageFile, ApiError> {
        h.backend
            .page_file(&format!("{}/{path}", h.backend.page_token), "groundwork:")
    }

    fn header<'a>(file: &'a PageFile, name: &str) -> Option<&'a str> {
        file.headers
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn serves_pages_with_the_bridge() {
        let h = harness();
        let doc = page(&h, "Projects/Acme/demos/login-flow.page/").unwrap();
        let html = String::from_utf8(doc.bytes.clone()).unwrap();
        assert!(html.starts_with("<!doctype html>"));
        assert!(html.contains("<head><script>"));
        assert!(html.contains(r#""page":"Projects/Acme/demos/login-flow.page""#));
        assert!(html.contains(&format!(r#""prefix":"/page/{}/""#, h.backend.page_token)));
        assert_eq!(header(&doc, "Access-Control-Allow-Origin"), Some("*"));
        assert_eq!(header(&doc, "Content-Security-Policy"), None);

        // Scripts and other files are served as they are.
        let script = page(&h, "Projects/Acme/demos/login-flow.page/app.js").unwrap();
        let text = std::fs::read(
            h.vault
                .path()
                .join("Projects/Acme/demos/login-flow.page/app.js"),
        )
        .unwrap();
        assert_eq!(script.bytes, text);

        let wrong = h
            .backend
            .page_file("0123/Projects/Acme/demos/sketch.html", "groundwork:");
        assert_eq!(wrong.err().unwrap().code, ErrorCode::Forbidden);
        assert_eq!(
            page(&h, "../secret.html").err().unwrap().code,
            ErrorCode::Forbidden
        );

        // A vault that turns network access off gets a policy on its documents.
        std::fs::write(
            h.vault.path().join(".groundwork/config.yml"),
            "pages:\n  allow_network: false\n",
        )
        .unwrap();
        let doc = page(&h, "Projects/Acme/demos/sketch.html").unwrap();
        let policy = header(&doc, "Content-Security-Policy").unwrap();
        assert!(policy.starts_with("default-src groundwork: "), "{policy}");
    }

    #[test]
    fn page_state_round_trips_and_changes_are_pushed() {
        let h = harness();
        let path = "Projects/Acme/demos/login-flow.page";
        let get = || {
            h.backend
                .handle_value(json!({ "method": "page.state", "params": { "path": path } }))
                .unwrap()
        };
        assert_eq!(get(), Value::Null);
        h.backend
            .handle_value(json!({
                "method": "page.setState",
                "params": { "path": path, "state": { "reviewed": true } }
            }))
            .unwrap();
        assert_eq!(get(), json!({ "reviewed": true }));

        // Saving, and edits to the state file outside Groundwork, are both pushed.
        let pushed = |h: &Harness| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                let event = h
                    .events
                    .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                    .expect("no event within 5s");
                if let Event::PageStateChanged { path: p } = event {
                    assert_eq!(p, path);
                    break;
                }
            }
        };
        pushed(&h);
        std::thread::sleep(std::time::Duration::from_millis(300));
        while h.events.try_recv().is_ok() {}
        std::fs::write(
            h.vault.path().join(path).join("state.json"),
            r#"{"reviewed": false}"#,
        )
        .unwrap();
        pushed(&h);
        assert_eq!(get(), json!({ "reviewed": false }));
    }
}
