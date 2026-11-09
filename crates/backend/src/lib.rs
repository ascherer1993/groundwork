//! Request dispatch shared by every Groundwork API host.
//!
//! The Tauri app and the browser dev server both own one [`Backend`], pass
//! every request through [`Backend::handle_value`], and forward the events it
//! emits, so the UI behaves the same in either.

mod agents;
#[cfg(feature = "dev-server")]
pub mod dev_server;
mod page_server;
mod terminals;
mod window;

pub use page_server::PageFile;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::NaiveDate;
use groundwork_core::command_log::CommandLog;
use groundwork_core::crypt;
use groundwork_core::inbox::{InboxKind, NewItem};
use groundwork_core::pages;
use groundwork_core::qmd;
use groundwork_core::search;
use groundwork_core::settings::Settings;
use groundwork_core::setup::{self, SetupEnv, SetupStatus};
use groundwork_core::watch::{self, VaultWatcher};
use groundwork_core::workspaces::{self, WorkspaceChange};
use groundwork_core::{FileChange, RecentVaults, Session, Vault};
use groundwork_protocol::{
    ApiError, AppInfo, CreatedNote, ErrorCode, Event, Host, QuickAdded, RenderedTemplate, Request,
    UiCommand, WriteResult,
};
use serde::Serialize;
use serde_json::Value;

/// An existing absolute folder (or `~/…`), as a string.
fn absolute_folder(cwd: &str) -> Result<String, ApiError> {
    let path = workspaces::expand_home(cwd.trim());
    if !path.is_absolute() || !path.is_dir() {
        return Err(ApiError::new(
            ErrorCode::BadRequest,
            format!("not an absolute folder: {cwd}"),
        ));
    }
    Ok(path.display().to_string())
}

/// Receives events for the UI. Hosts forward them over their transport.
pub type EventSink = Arc<dyn Fn(Event) + Send + Sync>;

struct OpenVault {
    session: Arc<Session>,
    /// Keeps smart search's index up to date.
    qmd: Arc<qmd::Updater>,
    _watcher: Option<VaultWatcher>,
}

pub struct Backend {
    host: Host,
    data_dir: PathBuf,
    recent: RecentVaults,
    settings: Settings,
    open: Mutex<Option<OpenVault>>,
    events: EventSink,
    /// See [`page_server`].
    page_token: String,
    terminals: terminals::Terminals,
    agents: agents::Agents,
    window: window::Window,
    /// The keys of unlocked encrypted notes, by path. Only in memory: they
    /// go when the note is locked, the vault closes or the app quits.
    keys: Mutex<HashMap<String, crypt::Key>>,
}

impl Backend {
    pub fn new(host: Host, data_dir: PathBuf, events: EventSink) -> Self {
        Self {
            host,
            recent: RecentVaults::new(&data_dir),
            settings: Settings::new(&data_dir),
            terminals: terminals::Terminals::new(&data_dir, events.clone()),
            agents: agents::Agents::new(&data_dir, events.clone()),
            window: window::Window::new(events.clone()),
            data_dir,
            open: Mutex::new(None),
            keys: Mutex::new(HashMap::new()),
            events,
            page_token: page_server::new_token(),
        }
    }

    /// Starts answering the `groundwork` CLI on the app socket
    /// (`GROUNDWORK_SOCKET` in terminals).
    pub fn listen(self: &Arc<Self>) -> std::io::Result<()> {
        agents::listen(self, self.socket())
    }

    fn socket(&self) -> PathBuf {
        self.data_dir.join(agents::SOCKET_NAME)
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
            Request::SettingsGet => to_value(self.settings.get()),
            Request::SettingsSet { settings } => {
                self.settings.set(&settings)?;
                Ok(Value::Null)
            }
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
            Request::SearchSmart { query, limit } => {
                to_value(self.session()?.smart_search(&query, limit.unwrap_or(30))?)
            }
            Request::QmdStatus => to_value(self.qmd_status()?),
            Request::QmdSetup => {
                self.session()?.qmd().setup()?;
                self.qmd_updater()?.refresh();
                to_value(self.qmd_status()?)
            }
            Request::QmdUpdate => {
                self.qmd_updater()?.refresh();
                to_value(self.qmd_status()?)
            }
            Request::QmdRemove => {
                self.session()?.qmd().remove()?;
                to_value(self.qmd_status()?)
            }
            Request::QmdSetAutoUpdate { on } => {
                self.session()?.qmd().set_auto_update(on)?;
                to_value(self.qmd_status()?)
            }
            Request::WhoKnows { topic, limit } => {
                to_value(self.session()?.who_knows(&topic, limit.unwrap_or(10))?)
            }

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
            Request::QuickAddList => to_value(self.session()?.quick_add_choices()?),
            Request::QuickAddSave { choices } => {
                self.session()?.save_quick_add_choices(&choices)?;
                Ok(Value::Null)
            }
            Request::QuickAddForm { choice, note } => {
                to_value(self.session()?.quick_add_form(&choice, note.as_deref())?)
            }
            Request::QuickAddRun {
                choice,
                answers,
                date,
                project,
            } => {
                let date = date.as_deref().map(parse_date).transpose()?;
                let session = self.session()?;
                let added = session.quick_add(&choice, answers, date, project.as_deref())?;
                self.emit(added.changes);
                let cursor = match added.cursor {
                    Some(byte) => {
                        let text = std::fs::read_to_string(session.vault().resolve(&added.path)?)
                            .map_err(groundwork_core::CoreError::from)?;
                        Some(utf16_offset(&text, byte))
                    }
                    None => None,
                };
                to_value(QuickAdded {
                    path: added.path,
                    cursor,
                    created: added.created,
                })
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
            Request::CryptEncrypt {
                path,
                password,
                hint,
            } => {
                let (_, changes) = self.session()?.encrypt_note(&path, &password, &hint)?;
                self.keys.lock().unwrap().remove(&path);
                self.emit(changes);
                Ok(Value::Null)
            }
            Request::CryptUnlock { path, password } => {
                let (text, key) = self.session()?.unlock_note(&path, &password)?;
                self.keys.lock().unwrap().insert(path, key);
                to_value(text)
            }
            Request::CryptRead { path } => {
                let session = self.session()?;
                let keys = self.keys.lock().unwrap();
                let key = keys.get(&path).ok_or_else(|| locked(&path))?;
                to_value(session.read_encrypted(&path, key)?)
            }
            Request::CryptWrite { path, text } => {
                let session = self.session()?;
                let (hash, changes) = {
                    let keys = self.keys.lock().unwrap();
                    let key = keys.get(&path).ok_or_else(|| locked(&path))?;
                    session.write_encrypted(&path, key, &text)?
                };
                self.emit(changes);
                to_value(WriteResult { hash })
            }
            Request::CryptLock { path } => {
                let mut keys = self.keys.lock().unwrap();
                match path {
                    Some(path) => {
                        keys.remove(&path);
                    }
                    None => keys.clear(),
                }
                Ok(Value::Null)
            }
            Request::CryptDecrypt { path, password } => {
                let changes = self.session()?.decrypt_note(&path, &password)?;
                self.keys.lock().unwrap().remove(&path);
                self.emit(changes);
                Ok(Value::Null)
            }
            Request::CryptChangePassword {
                path,
                old_password,
                password,
                hint,
            } => {
                let (key, changes) =
                    self.session()?
                        .change_note_password(&path, &old_password, &password, &hint)?;
                let mut keys = self.keys.lock().unwrap();
                if keys.contains_key(&path) {
                    keys.insert(path, key);
                }
                drop(keys);
                self.emit(changes);
                Ok(Value::Null)
            }
            Request::FolderCreate { path } => {
                let changes = self.session()?.create_folder(&path)?;
                self.emit(changes);
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
            Request::TodoDay { path, own } => to_value(self.session()?.todo_day(&path, own)),
            Request::TodoBoard { from, days, filter } => {
                let from = from.parse().map_err(|_| {
                    ApiError::new(ErrorCode::BadRequest, format!("not a date: {from}"))
                })?;
                to_value(
                    self.session()?
                        .todo_board(from, days, &filter.unwrap_or_default()),
                )
            }
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
                let cwd = match cwd.map(|cwd| workspaces::expand_home(cwd.trim())) {
                    Some(cwd) if cwd.is_absolute() => cwd,
                    Some(cwd) => {
                        return Err(ApiError::new(
                            ErrorCode::BadRequest,
                            format!("not an absolute folder: {}", cwd.display()),
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
            Request::TerminalRead { id, lines } => to_value(self.terminals.read(id, lines)?),

            Request::AppOpen { target, line } => {
                let path = self.find_file(&target)?;
                self.window.call(UiCommand::Open {
                    path: path.clone(),
                    line,
                })?;
                to_value(path)
            }
            Request::AppShowWorkspace { workspace } => {
                let workspace = self.find_workspace(&workspace)?;
                self.window.call(UiCommand::ShowWorkspace {
                    id: workspace.id.clone(),
                })?;
                to_value(workspace)
            }
            Request::AppNewTab {
                workspace,
                beside,
                cwd,
                run,
                background,
            } => {
                let workspace = match workspace {
                    Some(w) => Some(self.find_workspace(&w)?.id),
                    None => None,
                };
                let cwd = cwd.map(|cwd| absolute_folder(&cwd)).transpose()?;
                self.window.call(UiCommand::NewTab {
                    workspace,
                    beside,
                    cwd,
                    run,
                    background,
                })
            }
            Request::AppTabs => self.window.call(UiCommand::Tabs),
            Request::AppCloseTab { tab } => self.window.call(UiCommand::CloseTab { terminal: tab }),
            Request::UiReply { id, result, error } => {
                self.window
                    .reply(id, error.map_or(Ok(result.unwrap_or(Value::Null)), Err));
                Ok(Value::Null)
            }

            Request::WorkspaceList => to_value(self.session()?.workspaces().list()),
            Request::WorkspaceCreate { name, cwd } => {
                let session = self.session()?;
                let root = session.vault().root().display().to_string();
                let workspace = session
                    .workspaces()
                    .create(&name, cwd.as_deref().unwrap_or(&root))?;
                (self.events)(Event::WorkspacesChanged);
                to_value(workspace)
            }
            Request::WorkspaceUpdate {
                id,
                name,
                cwd,
                color,
                pinned,
            } => {
                let change = WorkspaceChange {
                    name: name.as_deref(),
                    cwd: cwd.as_deref(),
                    color: color.as_deref(),
                    pinned,
                };
                let workspace = self.session()?.workspaces().update(&id, &change)?;
                (self.events)(Event::WorkspacesChanged);
                to_value(workspace)
            }
            Request::WorkspaceMove { id, before } => {
                let list = self
                    .session()?
                    .workspaces()
                    .move_before(&id, before.as_deref())?;
                (self.events)(Event::WorkspacesChanged);
                to_value(list)
            }
            Request::WorkspaceSaveLayout { id, layout } => {
                self.session()?.workspaces().save_layout(&id, layout)?;
                Ok(Value::Null)
            }
            Request::WorkspaceDelete { id } => {
                let changes = self.session()?.delete_workspace(&id)?;
                self.emit(changes);
                (self.events)(Event::WorkspacesChanged);
                Ok(Value::Null)
            }
            Request::WorkspaceForNote { path } => {
                let (workspace, changes) = self.session()?.note_workspace(&path)?;
                self.emit(changes);
                to_value(workspace)
            }

            Request::RepoList => to_value(self.session()?.repo_list()?),
            Request::RepoLocate {
                id,
                path,
                worktrees,
            } => {
                let session = self.session()?;
                session.config()?.repo(&id)?;
                to_value(session.repos().locate(&id, &path, worktrees.as_deref())?)
            }
            Request::InboxList => to_value(self.agents.open()),
            Request::InboxHistory => to_value(self.agents.history()),
            Request::InboxAsk {
                text,
                choices,
                link,
                tab,
            } => to_value(self.agents.add(
                InboxKind::Ask,
                NewItem {
                    text,
                    choices,
                    link,
                    tab,
                    vault: self.vault_root(),
                    ..Default::default()
                },
            )?),
            Request::InboxNotify {
                text,
                link,
                tab,
                done,
            } => to_value(self.agents.add(
                InboxKind::Notify,
                NewItem {
                    text,
                    link,
                    tab,
                    vault: self.vault_root(),
                    done,
                    ..Default::default()
                },
            )?),
            Request::InboxWait { id, timeout_ms } => to_value(self.agents.wait(
                &id,
                std::time::Duration::from_millis(timeout_ms.unwrap_or(30_000)),
            )?),
            Request::InboxAnswer { id, answer } => {
                self.agents.answer(&id, answer)?;
                Ok(Value::Null)
            }
            Request::AgentHook {
                tab,
                event,
                session,
                message,
            } => {
                self.agents
                    .hook(tab, &event, session, message, self.vault_root())?;
                Ok(Value::Null)
            }
            Request::AgentList => to_value(self.agents.list()),
            Request::AgentFork { tab, background } => {
                let session = self
                    .agents
                    .list()
                    .into_iter()
                    .find(|a| a.tab == tab)
                    .and_then(|a| a.session)
                    .ok_or_else(|| {
                        ApiError::new(
                            ErrorCode::NotFound,
                            "no Claude Code session is known in that terminal",
                        )
                    })?;
                // It came from a hook; it's typed into a shell.
                if !session
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                {
                    return Err(ApiError::new(
                        ErrorCode::BadRequest,
                        format!("not a session id: {session}"),
                    ));
                }
                let cwd = self.terminals.cwd_of(&tab);
                self.window.call(UiCommand::NewTab {
                    workspace: None,
                    beside: Some(tab),
                    cwd,
                    run: Some(format!("claude --resume {session} --fork-session")),
                    background,
                })
            }
            Request::ProjectList => to_value(self.session()?.project_list()?),
            Request::ProjectCreate { folder } => {
                let (project, changes) = self.session()?.create_project(&folder)?;
                self.emit(changes);
                to_value(project)
            }

            Request::ProjectView { project } => to_value(self.session()?.project_view(&project)?),

            Request::TicketList { filter } => to_value(self.session()?.tickets(&filter)?),
            Request::TicketGit { path } => to_value(self.session()?.ticket_git(&path)?),
            Request::TicketCreate { ticket } => {
                let created = self.session()?.create_ticket(&ticket)?;
                self.emit(created.changes.clone());
                to_value(created)
            }
            Request::TicketClose { path, force } => {
                let session = self.session()?;
                let worktree = session.ticket(&path)?.worktree_path;
                let (ticket, _, changes) = session.close_ticket(&path, force.unwrap_or(false))?;
                self.emit(changes);
                if let Some(wt) = worktree {
                    self.terminals.kill_inside(Path::new(&wt));
                }
                to_value(ticket)
            }
            Request::TicketRestore { path } => {
                let created = self.session()?.restore_ticket(&path)?;
                self.emit(created.changes.clone());
                to_value(created)
            }
            Request::TicketStrays => to_value(self.session()?.stray_worktrees()?),

            Request::ContextGet { note, cwd } => to_value(
                self.session()?
                    .context(note.as_deref(), cwd.as_deref().map(Path::new))?,
            ),
            Request::AgentCommand { prompt, name, vars } => {
                let session = self.session()?;
                let prompt = match (prompt, name) {
                    (Some(p), _) => p,
                    (None, Some(name)) => session.agent_prompt(&name)?,
                    (None, None) => {
                        return Err(ApiError::new(
                            ErrorCode::BadRequest,
                            "give a prompt or a prompt's name",
                        ));
                    }
                };
                to_value(session.agent_command(&prompt, &vars)?)
            }
            Request::BarCommand {
                prompt,
                context,
                shown,
            } => to_value(self.session()?.bar_command(&prompt, &context, shown)?),
            Request::CommandLogList { limit } => {
                to_value(CommandLog::new(self.session()?.vault().root()).list(limit.unwrap_or(200)))
            }
            Request::ActionRun { id, note, cwd } => {
                let context = self
                    .session()?
                    .context(note.as_deref(), cwd.as_deref().map(Path::new))?;
                let action = context
                    .actions
                    .into_iter()
                    .find(|a| a.id == id)
                    .ok_or_else(|| ApiError::new(ErrorCode::NotFound, format!("no action {id}")))?;
                if action.kind != "shell" {
                    return Err(ApiError::new(
                        ErrorCode::BadRequest,
                        format!("{} runs in the app, not the backend", action.label),
                    ));
                }
                // A login shell, so PATH has what the user's terminals have
                // (apps opened from the Finder get a minimal one).
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
                let mut child = std::process::Command::new(shell)
                    .args(["-l", "-c"])
                    .arg(&action.run)
                    .current_dir(&action.cwd)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|e| {
                        ApiError::new(ErrorCode::Internal, format!("{}: {e}", action.label))
                    })?;
                std::thread::spawn(move || child.wait());
                Ok(Value::Null)
            }
        }
    }

    /// What every terminal gets on top of the daemon's environment: the
    /// vault, and the `groundwork` CLI on PATH, so Claude Code sessions in
    /// them work without "Set up Claude Code…".
    fn terminal_env(&self, vault: Option<&Path>) -> Vec<(String, String)> {
        let mut env = vec![(
            "GROUNDWORK_SOCKET".to_string(),
            self.socket().display().to_string(),
        )];
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
        let qmd = Arc::new(qmd::Updater::start(session.qmd()));
        let updater = Arc::downgrade(&qmd);
        let watcher = watch::watch(session.vault().root(), move |paths| {
            if paths.iter().any(|p| p.ends_with(".md"))
                && let Some(updater) = updater.upgrade()
            {
                updater.changed();
            }
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
            qmd,
            _watcher: watcher,
        });
        Ok(info)
    }

    fn close_vault(&self) {
        // Dropping the session saves its snapshot.
        self.open.lock().unwrap().take();
        self.keys.lock().unwrap().clear();
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

    /// A vault file named the way a link or the CLI names it: a vault path,
    /// an absolute path inside the vault, or a link target (`[[Note]]`).
    fn find_file(&self, target: &str) -> Result<String, ApiError> {
        let session = self.session()?;
        let root = session.vault().root();
        let target = target.trim();
        let name = target
            .strip_prefix("[[")
            .and_then(|t| t.strip_suffix("]]"))
            .unwrap_or(target);
        // `[[Note|alias]]` and `[[Note#heading]]` name the note.
        let name = name.split(['|', '#']).next().unwrap_or(name);
        let relative = Path::new(name)
            .strip_prefix(root)
            .ok()
            .and_then(|p| p.to_str())
            .unwrap_or(name);
        if let Some(found) = session.index().resolve(relative, "") {
            return Ok(found);
        }
        let full = session.vault().resolve(relative)?;
        if full.is_file() {
            return Ok(relative.to_string());
        }
        Err(ApiError::new(
            ErrorCode::NotFound,
            format!("no note or file called {target} in the vault"),
        ))
    }

    /// A workspace of the open vault, by id or (any case) name.
    fn find_workspace(&self, name: &str) -> Result<workspaces::Workspace, ApiError> {
        let list = self.session()?.workspaces().list();
        list.iter()
            .find(|w| w.id == name)
            .or_else(|| {
                list.iter()
                    .find(|w| w.name.eq_ignore_ascii_case(name.trim()))
            })
            .cloned()
            .ok_or_else(|| ApiError::new(ErrorCode::NotFound, format!("no workspace {name}")))
    }

    /// The open vault's folder, if one is open.
    fn vault_root(&self) -> Option<String> {
        self.session()
            .ok()
            .map(|s| s.vault().root().display().to_string())
    }

    fn session(&self) -> Result<Arc<Session>, ApiError> {
        self.open
            .lock()
            .unwrap()
            .as_ref()
            .map(|o| o.session.clone())
            .ok_or_else(|| ApiError::new(ErrorCode::NoVault, "no vault is open"))
    }

    fn qmd_updater(&self) -> Result<Arc<qmd::Updater>, ApiError> {
        self.open
            .lock()
            .unwrap()
            .as_ref()
            .map(|o| o.qmd.clone())
            .ok_or_else(|| ApiError::new(ErrorCode::NoVault, "no vault is open"))
    }

    fn qmd_status(&self) -> Result<qmd::QmdStatus, ApiError> {
        let busy = self.qmd_updater()?.busy();
        Ok(self.session()?.qmd().status(busy))
    }

    fn emit(&self, changes: Vec<FileChange>) {
        self.follow_keys(&changes);
        if !changes.is_empty() {
            (self.events)(Event::VaultChanged { changes });
        }
    }
}

impl Backend {
    /// Keeps unlocked notes unlocked as they move; forgets deleted ones.
    fn follow_keys(&self, changes: &[FileChange]) {
        let mut keys = self.keys.lock().unwrap();
        if keys.is_empty() {
            return;
        }
        for c in changes {
            match (&c.kind, &c.from) {
                (groundwork_core::ChangeKind::Moved, Some(from)) => {
                    if let Some(key) = keys.remove(from) {
                        keys.insert(c.path.clone(), key);
                    }
                }
                (groundwork_core::ChangeKind::Removed, _) => {
                    keys.remove(&c.path);
                }
                _ => {}
            }
        }
    }
}

/// The error for an encrypted note that isn't unlocked.
fn locked(path: &str) -> ApiError {
    ApiError::new(ErrorCode::Encrypted, format!("{path} is locked"))
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
    fn encrypted_notes_unlock_until_locked_and_never_over_the_socket() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixStream;

        let h = harness();
        let backend = Arc::new(h.backend);
        let call = |request: Value| backend.handle_value(request);
        call(json!({ "method": "crypt.encrypt",
            "params": { "path": "Welcome.md", "password": "pw", "hint": "h" } }))
        .unwrap();
        let file =
            call(json!({ "method": "file.read", "params": { "path": "Welcome.md" } })).unwrap();
        assert_eq!(file["encrypted"], json!({ "hint": "h" }));
        assert!(!file["text"].as_str().unwrap().contains("Welcome"));
        // Locked: it can't be read or written.
        let err = call(json!({ "method": "crypt.read", "params": { "path": "Welcome.md" } }))
            .unwrap_err();
        assert!(matches!(err.code, ErrorCode::Encrypted));
        let err = call(json!({ "method": "file.write",
            "params": { "path": "Welcome.md", "text": "plain" } }))
        .unwrap_err();
        assert!(matches!(err.code, ErrorCode::Encrypted));
        let err = call(json!({ "method": "crypt.unlock",
            "params": { "path": "Welcome.md", "password": "nope" } }))
        .unwrap_err();
        assert!(matches!(err.code, ErrorCode::WrongPassword));

        let text = call(json!({ "method": "crypt.unlock",
            "params": { "path": "Welcome.md", "password": "pw" } }))
        .unwrap();
        assert!(text.as_str().unwrap().contains("Welcome"));
        call(json!({ "method": "crypt.write",
            "params": { "path": "Welcome.md", "text": "edited" } }))
        .unwrap();
        // It stays unlocked as it moves.
        call(json!({ "method": "file.rename",
            "params": { "from": "Welcome.md", "to": "Hello.md" } }))
        .unwrap();
        assert_eq!(
            call(json!({ "method": "crypt.read", "params": { "path": "Hello.md" } })).unwrap(),
            json!("edited")
        );

        // The CLI's socket can't reach it, even unlocked, but can lock it.
        backend.listen().unwrap();
        let socket = h.data.path().join(agents::SOCKET_NAME);
        let over_socket = |request: Value| -> Value {
            let mut stream = UnixStream::connect(&socket).unwrap();
            writeln!(stream, "{request}").unwrap();
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        };
        for request in [
            json!({ "method": "crypt.read", "params": { "path": "Hello.md" } }),
            json!({ "method": "crypt.unlock", "params": { "path": "Hello.md", "password": "pw" } }),
            json!({ "method": "crypt.write", "params": { "path": "Hello.md", "text": "x" } }),
            json!({ "method": "crypt.decrypt", "params": { "path": "Hello.md", "password": "pw" } }),
        ] {
            assert_eq!(over_socket(request)["error"]["code"], json!("forbidden"));
        }
        assert_eq!(
            over_socket(json!({ "method": "crypt.lock", "params": { "path": "Hello.md" } })),
            json!({ "ok": null })
        );
        let err =
            call(json!({ "method": "crypt.read", "params": { "path": "Hello.md" } })).unwrap_err();
        assert!(matches!(err.code, ErrorCode::Encrypted));

        call(json!({ "method": "crypt.decrypt",
            "params": { "path": "Hello.md", "password": "pw" } }))
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(h.vault.path().join("Hello.md")).unwrap(),
            "edited"
        );
    }

    #[test]
    fn the_window_does_what_the_cli_asks() {
        let h = harness();
        let backend = Arc::new(h.backend);
        // A stand-in for the window: does nothing, answers as the UI would.
        let (seen_tx, seen) = mpsc::channel();
        let window = {
            let backend = backend.clone();
            let events = h.events;
            std::thread::spawn(move || {
                for event in events {
                    if matches!(event, Event::WorkspacesChanged) {
                        let _ = seen_tx.send(json!("workspaces changed"));
                    }
                    let Event::UiCommand { id, command } = event else {
                        continue;
                    };
                    let command = serde_json::to_value(&command).unwrap();
                    let (result, error) = match command["kind"].as_str().unwrap() {
                        "newTab" => (
                            Some(json!({ "terminal": "t9", "workspace": command["workspace"],
                                "title": "zsh", "shown": true })),
                            None,
                        ),
                        "tabs" => (None, Some("no tabs today")),
                        _ => (None, None),
                    };
                    let _ = seen_tx.send(command);
                    backend
                        .handle(Request::UiReply {
                            id,
                            result,
                            error: error.map(String::from),
                        })
                        .unwrap();
                }
            })
        };
        let call = |request: Value| backend.handle_value(request);

        // Open: by name, link or path; a missing one never reaches the window.
        let opened = call(json!({ "method": "app.open", "params": { "target": "[[Welcome]]" } }));
        assert_eq!(opened.unwrap(), json!("Welcome.md"));
        assert_eq!(
            seen.recv().unwrap(),
            json!({ "kind": "open", "path": "Welcome.md" })
        );
        let root = h.vault.path().canonicalize().unwrap();
        let absolute = root.join("Welcome.md").display().to_string();
        let opened = call(json!({ "method": "app.open",
            "params": { "target": absolute, "line": 3 } }));
        assert_eq!(opened.unwrap(), json!("Welcome.md"));
        assert_eq!(seen.recv().unwrap()["line"], 3);
        let missing = call(json!({ "method": "app.open", "params": { "target": "Nope" } }));
        assert_eq!(missing.unwrap_err().code, ErrorCode::NotFound);

        // Workspaces: made (the window hears), then shown by name.
        let made =
            call(json!({ "method": "workspace.create", "params": { "name": "Docs" } })).unwrap();
        assert_eq!(seen.recv().unwrap(), json!("workspaces changed"));
        let shown = call(json!({ "method": "app.showWorkspace",
            "params": { "workspace": "docs" } }))
        .unwrap();
        assert_eq!(shown["id"], made["id"]);
        assert_eq!(seen.recv().unwrap()["id"], made["id"]);

        // A new tab, in a workspace named or by id.
        let tab = call(json!({ "method": "app.newTab", "params": {
            "workspace": "Docs", "cwd": "~", "run": "ls" } }))
        .unwrap();
        assert_eq!(tab["terminal"], "t9");
        let sent = seen.recv().unwrap();
        assert_eq!(sent["workspace"], made["id"]);
        assert_eq!(sent["run"], "ls");
        assert_eq!(sent["background"], false);
        let relative = call(json!({ "method": "app.newTab", "params": { "cwd": "src" } }));
        assert_eq!(relative.unwrap_err().code, ErrorCode::BadRequest);

        // The window's errors come back as they are.
        let err = call(json!({ "method": "app.tabs" })).unwrap_err();
        assert_eq!(err.message, "no tabs today");
        seen.recv().unwrap();

        // Forking needs the session the hooks reported.
        let fork = call(json!({ "method": "agent.fork", "params": { "tab": "t1" } }));
        assert_eq!(fork.unwrap_err().code, ErrorCode::NotFound);
        call(json!({ "method": "agent.hook", "params": {
            "tab": "t1", "event": "prompt", "session": "0b9e-41" } }))
        .unwrap();
        call(json!({ "method": "agent.fork", "params": { "tab": "t1", "background": true } }))
            .unwrap();
        let sent = loop {
            let c = seen.recv().unwrap();
            if c["kind"] == "newTab" {
                break c;
            }
        };
        assert_eq!(sent["beside"], "t1");
        assert_eq!(sent["run"], "claude --resume 0b9e-41 --fork-session");
        assert_eq!(sent["background"], true);
        call(json!({ "method": "agent.hook", "params": {
            "tab": "t2", "event": "prompt", "session": "x; rm -rf ~" } }))
        .unwrap();
        let fork = call(json!({ "method": "agent.fork", "params": { "tab": "t2" } }));
        assert_eq!(fork.unwrap_err().code, ErrorCode::BadRequest);

        // A reply nobody waits for is dropped.
        call(json!({ "method": "ui.reply", "params": { "id": 999 } })).unwrap();
        drop(backend);
        drop(window);
    }

    #[test]
    fn the_cli_asks_through_the_socket_and_hooks_report_states() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixStream;

        let h = harness();
        let backend = Arc::new(h.backend);
        backend.listen().unwrap();
        let socket = h.data.path().join(agents::SOCKET_NAME);
        let call = |request: Value| -> Value {
            let mut stream = UnixStream::connect(&socket).unwrap();
            writeln!(stream, "{request}").unwrap();
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        };

        // A question waits for its answer.
        let asked = call(json!({ "method": "inbox.ask",
            "params": { "text": "Which env?", "choices": ["staging", "prod"], "tab": "t1" } }));
        let id = asked["ok"]["id"].as_str().unwrap().to_string();
        let root = h.vault.path().canonicalize().unwrap();
        assert_eq!(asked["ok"]["vault"], json!(root.display().to_string()));
        let waiting = {
            let socket = socket.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                let mut stream = UnixStream::connect(&socket).unwrap();
                writeln!(
                    stream,
                    "{}",
                    json!({ "method": "inbox.wait", "params": { "id": id } })
                )
                .unwrap();
                let mut line = String::new();
                BufReader::new(stream).read_line(&mut line).unwrap();
                serde_json::from_str::<Value>(&line).unwrap()
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(100));
        backend
            .handle_value(
                json!({ "method": "inbox.answer", "params": { "id": id, "answer": "staging" } }),
            )
            .unwrap();
        let answered = waiting.join().unwrap();
        assert_eq!(answered["ok"]["answer"], "staging");
        assert_eq!(answered["ok"]["done"], true);
        // A wait that times out returns the item as it is.
        let n = call(json!({ "method": "inbox.notify", "params": { "text": "Done" } }));
        let nid = n["ok"]["id"].as_str().unwrap();
        let same =
            call(json!({ "method": "inbox.wait", "params": { "id": nid, "timeoutMs": 10 } }));
        assert_eq!(same["ok"]["done"], false);
        let err = call(json!({ "method": "inbox.answer", "params": { "id": id } }));
        assert_eq!(err["error"]["code"], "conflict");

        // A finished request's summary is announced (a notification), but
        // only to the history: nothing waits in the inbox.
        while h.events.try_recv().is_ok() {}
        let fin = call(json!({ "method": "inbox.notify",
            "params": { "text": "Added a todo", "done": true } }));
        let fid = fin["ok"]["id"].as_str().unwrap().to_string();
        assert!(h.events.try_iter().any(|e| matches!(&e,
            Event::InboxChanged { added: Some(item) } if item.id == fid && item.done)));
        let open = call(json!({ "method": "inbox.list" }))["ok"].clone();
        assert!(
            open.as_array()
                .unwrap()
                .iter()
                .all(|i| i["id"] != fid.as_str())
        );
        let history = call(json!({ "method": "inbox.history" }))["ok"].clone();
        assert!(
            history
                .as_array()
                .unwrap()
                .iter()
                .any(|i| i["id"] == fid.as_str())
        );

        // Hooks: a permission prompt posts one attention item; the next
        // prompt clears it.
        let hook = |event: &str, message: Option<&str>| {
            let reply = call(json!({ "method": "agent.hook", "params": {
                "tab": "t1", "event": event, "session": "s-1", "message": message } }));
            assert!(reply.get("ok").is_some(), "{reply}");
        };
        hook("session-start", None);
        hook(
            "notification",
            Some("Claude needs your permission to use Bash"),
        );
        hook("notification", Some("Claude is waiting for your input"));
        let open = call(json!({ "method": "inbox.list" }))["ok"].clone();
        let attention: Vec<_> = open
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["kind"] == "attention")
            .collect();
        assert_eq!(attention.len(), 1);
        assert_eq!(attention[0]["text"], "Claude is waiting for your input");
        let agents = call(json!({ "method": "agent.list" }))["ok"].clone();
        assert_eq!(agents[0]["state"], "waiting");
        assert_eq!(agents[0]["session"], "s-1");
        hook("prompt", None);
        let open = call(json!({ "method": "inbox.list" }))["ok"].clone();
        assert!(
            open.as_array()
                .unwrap()
                .iter()
                .all(|i| i["kind"] != "attention")
        );
        assert_eq!(
            call(json!({ "method": "agent.list" }))["ok"][0]["state"],
            "working"
        );
        let bad =
            call(json!({ "method": "agent.hook", "params": { "tab": "t1", "event": "nope" } }));
        assert_eq!(bad["error"]["code"], "bad_request");

        // The UI hears about it.
        let events: Vec<Event> = h.events.try_iter().collect();
        assert!(
            events
                .iter()
                .any(|e| matches!(e, Event::AgentChanged { .. }))
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, Event::InboxChanged { added: Some(_) }))
        );
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
        assert_eq!(outcome["updatedNotes"].as_array().unwrap().len(), 7);
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
