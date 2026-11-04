//! The Groundwork API: one request enum, one error type.
//!
//! The same JSON shapes travel over Tauri IPC (the desktop app), the dev
//! WebSocket (browser mode, used for Playwright), and later the CLI socket.
//! `cargo test` exports TypeScript versions of these types to
//! `app/src/api/generated/`.

use std::collections::HashMap;

use groundwork_core::inbox::InboxItem;
use groundwork_core::settings::AppSettings;
use groundwork_core::tickets::{NewTicket, TicketFilter};
use groundwork_core::todos::{TaskChange, TodoFilter};
use groundwork_core::{CoreError, FileChange};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A call into the backend, serialized as `{ "method": "...", "params": {...} }`.
/// Each variant's doc comment names its result type.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "method", content = "params")]
#[ts(export)]
pub enum Request {
    /// → `AppInfo`
    #[serde(rename = "app.info")]
    AppInfo,

    /// → `RecentVault[]`
    #[serde(rename = "vault.recent")]
    VaultRecent,
    /// → `AppSettings`: this machine's app settings (not the vault's).
    #[serde(rename = "settings.get")]
    SettingsGet,
    /// → `null`
    #[serde(rename = "settings.set")]
    SettingsSet { settings: AppSettings },
    /// → `null`
    #[serde(rename = "vault.forget")]
    VaultForget { path: String },
    /// → `VaultInfo`
    #[serde(rename = "vault.open")]
    VaultOpen { path: String },
    /// → `VaultInfo | null`
    #[serde(rename = "vault.current")]
    VaultCurrent,
    /// → `null`
    #[serde(rename = "vault.close")]
    VaultClose,
    /// → `TreeNode`
    #[serde(rename = "vault.tree")]
    VaultTree,

    /// → `FileSummary[]`: every linkable file, for the quick switcher and autocomplete.
    #[serde(rename = "index.files")]
    IndexFiles,
    /// → `ParsedNote | null`
    #[serde(rename = "index.note")]
    IndexNote { path: String },
    /// → `LinkSettings`
    #[serde(rename = "index.settings")]
    IndexSettings,

    /// → `SetupStatus`: whether the `groundwork` command, the Claude Code
    /// plugin and the CLI's default vault are set up and current.
    #[serde(rename = "setup.status")]
    SetupStatus,

    /// → `SetupStatus`: links the `groundwork` command to this build.
    #[serde(rename = "setup.installCli")]
    SetupInstallCli,

    /// → `SetupStatus`: installs the Claude Code plugin from this copy of
    /// Groundwork, or repairs or updates it.
    #[serde(rename = "setup.installPlugin")]
    SetupInstallPlugin,

    /// → `SetupStatus`: makes the open vault the CLI's default.
    #[serde(rename = "setup.useVault")]
    SetupUseVault,

    /// → `TagCount[]`: every tag and how many notes use it.
    #[serde(rename = "index.tags")]
    IndexTags,

    /// → `SearchResult[]`: notes matching a query. Words must all appear;
    /// `"quoted text"`, `-exclude`, `path:` and `tag:`/`#tag` are supported.
    #[serde(rename = "search.query")]
    SearchQuery {
        query: String,
        #[ts(optional)]
        limit: Option<usize>,
    },

    /// → `(string | null)[]`: the vault path each link target resolves to.
    #[serde(rename = "links.resolve")]
    LinksResolve {
        source: String,
        targets: Vec<String>,
    },
    /// → `Backlinks[]`
    #[serde(rename = "links.backlinks")]
    LinksBacklinks { path: String },
    /// → `OutgoingLink[]`
    #[serde(rename = "links.outgoing")]
    LinksOutgoing { path: String },
    /// → `Mention[]`
    #[serde(rename = "links.unlinked")]
    LinksUnlinked { path: String },
    /// → `null`: replaces the mention at `start..end` in `source` with a link.
    #[serde(rename = "links.linkMention")]
    LinksLinkMention {
        source: String,
        start: usize,
        end: usize,
        text: String,
        target: String,
    },
    /// → `string`: a link to `target` written from `source` in the vault's style.
    #[serde(rename = "links.format")]
    LinksFormat {
        source: String,
        target: String,
        #[ts(optional)]
        subpath: Option<String>,
        #[ts(optional)]
        alias: Option<String>,
        #[serde(default)]
        #[ts(optional)]
        embed: Option<bool>,
    },

    /// → `unknown`: the state a page saved through `groundwork.state`
    /// (`null` if none).
    #[serde(rename = "page.state")]
    PageState { path: String },
    /// → `null`: replaces a page's saved state.
    #[serde(rename = "page.setState")]
    PageSetState {
        path: String,
        #[ts(type = "unknown")]
        state: serde_json::Value,
    },

    /// → `FileContent`
    #[serde(rename = "file.read")]
    FileRead { path: String },
    /// → `WriteResult`
    #[serde(rename = "file.write")]
    FileWrite { path: String, text: String },
    /// → `string` (the path). Notes created without text get a `created:` property.
    #[serde(rename = "file.create")]
    FileCreate {
        path: String,
        #[ts(optional)]
        text: Option<String>,
    },
    /// → `string`: creates `Untitled.md` (or `Untitled 1.md`…) in `folder`.
    #[serde(rename = "file.createUntitled")]
    FileCreateUntitled { folder: String },
    /// → `string`: creates the note an unresolved `[[target]]` in `source`
    /// points to: daily note names in the daily folder, otherwise where
    /// Obsidian's new-note setting says. Returns the path (existing or new).
    #[serde(rename = "file.createFromLink")]
    FileCreateFromLink { source: String, target: String },
    /// → `CreatedNote`: creates `path` from a template. `date` (`YYYY-MM-DD`)
    /// is what `{{date}}` means; by default the note's own date.
    #[serde(rename = "file.createFromTemplate")]
    FileCreateFromTemplate {
        template: String,
        path: String,
        #[serde(default)]
        answers: HashMap<String, String>,
        #[ts(optional)]
        date: Option<String>,
    },
    /// → `RenameOutcome`: renames or moves, rewriting links.
    #[serde(rename = "file.rename")]
    FileRename { from: String, to: String },
    /// → `null`: moves to the system Trash.
    #[serde(rename = "file.delete")]
    FileDelete { path: String },
    /// → `null`
    #[serde(rename = "folder.create")]
    FolderCreate { path: String },

    /// → `string[]`: the notes in the templates folder.
    #[serde(rename = "template.list")]
    TemplateList,
    /// → `string[]`: the `{{prompt:…}}` labels a template asks for.
    #[serde(rename = "template.prompts")]
    TemplatePrompts { template: String },
    /// → `RenderedTemplate`: a template rendered for inserting into `path`.
    #[serde(rename = "template.render")]
    TemplateRender {
        template: String,
        path: String,
        #[serde(default)]
        answers: HashMap<String, String>,
    },

    /// → `string`: the daily note for `date` (`YYYY-MM-DD`, default today),
    /// created from the daily template if it doesn't exist.
    #[serde(rename = "daily.open")]
    DailyOpen {
        #[ts(optional)]
        date: Option<String>,
    },

    /// → `string | null`: what `history.undo` would revert.
    #[serde(rename = "history.peek")]
    HistoryPeek,
    /// → `string`: the label of the reverted operation.
    #[serde(rename = "history.undo")]
    HistoryUndo,

    /// → `Todo[]`: todos matching the filter (open ones by default).
    #[serde(rename = "todo.list")]
    TodoList {
        #[serde(default)]
        filter: TodoFilter,
    },
    /// → `DayView`: what a daily note's `todos` block shows, for its date.
    #[serde(rename = "todo.day")]
    TodoDay { path: String },
    /// → `null`: changes a todo where it lives. Conflict if it changed since listing.
    #[serde(rename = "todo.update")]
    TodoUpdate { id: String, change: TaskChange },
    /// → `string` (the new todo's id): adds a todo under `## Todos` in `path`,
    /// by default today's daily note. `due` takes `fri`, `tomorrow`,
    /// `+3d`, `nov 12` or `YYYY-MM-DD`; `priority` is 0–5.
    #[serde(rename = "todo.add")]
    TodoAdd {
        #[ts(optional)]
        path: Option<String>,
        text: String,
        #[ts(optional)]
        due: Option<String>,
        #[ts(optional)]
        priority: Option<u8>,
    },

    /// → `null`: checks or unchecks the task on a zero-based line.
    #[serde(rename = "task.toggle")]
    TaskToggle { path: String, line: u32 },

    /// → `null`: shows the file in Finder.
    #[serde(rename = "os.reveal")]
    OsReveal { path: String },
    /// → `null`: opens the file in its default app.
    #[serde(rename = "os.open")]
    OsOpen { path: String },

    /// → `TerminalInfo`: starts `command` (the user's login shell by
    /// default) in `cwd`, an absolute folder or `~/…` (the vault root by
    /// default).
    #[serde(rename = "terminal.create")]
    TerminalCreate {
        #[ts(optional)]
        cwd: Option<String>,
        #[ts(optional)]
        command: Option<Vec<String>>,
        /// The workspace it's in, as `GROUNDWORK_WORKSPACE_ID`.
        #[ts(optional)]
        workspace: Option<String>,
        cols: u16,
        rows: u16,
    },
    /// → `TerminalInfo[]`: every running terminal, oldest first.
    #[serde(rename = "terminal.list")]
    TerminalList,
    /// → `TerminalSnapshot`: resizes the terminal (not if 0×0: a view that
    /// isn't on screen yet), returns what's on screen, and starts its events.
    #[serde(rename = "terminal.attach")]
    TerminalAttach { id: String, cols: u16, rows: u16 },
    /// → `null`: types into the terminal.
    #[serde(rename = "terminal.input")]
    TerminalInput { id: String, data: String },
    /// → `null`
    #[serde(rename = "terminal.resize")]
    TerminalResize { id: String, cols: u16, rows: u16 },
    /// → `null`: hangs up the terminal's processes, as closing a terminal
    /// window does.
    #[serde(rename = "terminal.kill")]
    TerminalKill { id: String },

    /// → `Workspace[]`: the open vault's workspaces.
    #[serde(rename = "workspace.list")]
    WorkspaceList,
    /// → `Workspace`: `cwd` is an absolute folder or `~/…` (the vault root by
    /// default).
    #[serde(rename = "workspace.create")]
    WorkspaceCreate {
        name: String,
        #[ts(optional)]
        cwd: Option<String>,
    },
    /// → `Workspace`
    #[serde(rename = "workspace.update")]
    WorkspaceUpdate {
        id: String,
        #[ts(optional)]
        name: Option<String>,
        #[ts(optional)]
        cwd: Option<String>,
    },
    /// → `null`: saves a workspace's tabs and splits.
    #[serde(rename = "workspace.saveLayout")]
    WorkspaceSaveLayout {
        id: String,
        #[ts(type = "unknown")]
        layout: serde_json::Value,
    },
    /// → `null`: forgets a workspace. Its terminals keep running; the app
    /// ends them first.
    #[serde(rename = "workspace.delete")]
    WorkspaceDelete { id: String },
    /// → `Workspace`: the note's workspace, made (and linked from the note's
    /// `workspace:` property) if it hasn't one.
    #[serde(rename = "workspace.forNote")]
    WorkspaceForNote { path: String },

    /// → `RepoInfo[]`: the repos in `repos.yml`, with where each is on this machine.
    #[serde(rename = "repo.list")]
    RepoList,
    /// → `RepoLocation`: records where a repo is checked out on this
    /// machine (`path` may be any folder in it, or start with `~`).
    /// `worktrees` defaults to `<repo>-worktrees` beside it.
    #[serde(rename = "repo.locate")]
    RepoLocate {
        id: String,
        path: String,
        #[ts(optional)]
        worktrees: Option<String>,
    },
    /// → `InboxItem[]`: what's open in the inbox, oldest first.
    #[serde(rename = "inbox.list")]
    InboxList,
    /// → `InboxItem`: posts a question. `inbox.wait` waits for the answer.
    #[serde(rename = "inbox.ask")]
    InboxAsk {
        text: String,
        #[serde(default)]
        choices: Vec<String>,
        #[ts(optional)]
        link: Option<String>,
        #[ts(optional)]
        tab: Option<String>,
    },
    /// → `InboxItem`: posts something to know; nothing waits.
    #[serde(rename = "inbox.notify")]
    InboxNotify {
        text: String,
        #[ts(optional)]
        link: Option<String>,
        #[ts(optional)]
        tab: Option<String>,
    },
    /// → `InboxItem`: once it's answered or dismissed, or as it is after
    /// `timeoutMs` (at most a minute).
    #[serde(rename = "inbox.wait", rename_all = "camelCase")]
    InboxWait {
        id: String,
        #[ts(optional, type = "number")]
        timeout_ms: Option<u64>,
    },
    /// → `null`: answers a question, or (with no answer) dismisses an item.
    #[serde(rename = "inbox.answer")]
    InboxAnswer {
        id: String,
        #[ts(optional)]
        answer: Option<String>,
    },
    /// → `null`: from Claude Code's hooks in a terminal (`groundwork hook`).
    /// `event` is `session-start`, `prompt`, `notification` or `stop`.
    #[serde(rename = "agent.hook")]
    AgentHook {
        tab: String,
        event: String,
        #[ts(optional)]
        session: Option<String>,
        #[ts(optional)]
        message: Option<String>,
    },
    /// → `AgentInfo[]`: what the hooks have said about each terminal.
    #[serde(rename = "agent.list")]
    AgentList,

    /// → `ProjectInfo[]`
    #[serde(rename = "project.list")]
    ProjectList,
    /// → `ProjectInfo`: makes a folder (made if it doesn't exist) a project.
    #[serde(rename = "project.create")]
    ProjectCreate { folder: String },

    /// → `Ticket[]`
    #[serde(rename = "ticket.list")]
    TicketList { filter: TicketFilter },
    /// → `GitState`: the ticket's worktree.
    #[serde(rename = "ticket.git")]
    TicketGit { path: String },
    /// → `CreatedTicket`: makes the worktree, the note and a workspace.
    /// Setup isn't run; the app runs it in the workspace's first terminal.
    #[serde(rename = "ticket.create")]
    TicketCreate { ticket: NewTicket },
    /// → `Ticket`: refuses, unless `force`, when removing the worktree would
    /// lose work. Ends terminals working in the worktree.
    #[serde(rename = "ticket.close")]
    TicketClose {
        path: String,
        #[serde(default)]
        #[ts(optional)]
        force: Option<bool>,
    },
    /// → `CreatedTicket`
    #[serde(rename = "ticket.restore")]
    TicketRestore { path: String },
    /// → `StrayWorktree[]`: worktrees with no ticket note.
    #[serde(rename = "ticket.strays")]
    TicketStrays,

    /// → `Context`: for a note, or an absolute folder.
    #[serde(rename = "context.get")]
    ContextGet {
        #[ts(optional)]
        note: Option<String>,
        #[ts(optional)]
        cwd: Option<String>,
    },
    /// → `null`: runs a `shell` action from the note's (or folder's) context,
    /// in the background. Terminal and URL actions are run by the app.
    #[serde(rename = "action.run")]
    ActionRun {
        id: String,
        #[ts(optional)]
        note: Option<String>,
        #[ts(optional)]
        cwd: Option<String>,
    },
}

/// Pushed from the backend to the UI, serialized as `{ "event": "...", "payload": {...} }`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "event", content = "payload")]
#[ts(export)]
pub enum Event {
    /// Files changed, through Groundwork or outside it.
    #[serde(rename = "vault.changed")]
    VaultChanged { changes: Vec<FileChange> },
    /// A page's saved state changed, through Groundwork or outside it.
    #[serde(rename = "page.stateChanged")]
    PageStateChanged { path: String },
    /// Output from an attached terminal, base64-encoded. `seq` is the offset
    /// of its first byte in everything the terminal has written.
    #[serde(rename = "terminal.output")]
    TerminalOutput {
        id: String,
        #[ts(type = "number")]
        seq: u64,
        data: String,
    },
    /// The program in a terminal set its title.
    #[serde(rename = "terminal.title")]
    TerminalTitle { id: String, title: String },
    #[serde(rename = "terminal.bell")]
    TerminalBell { id: String },
    /// What's in a terminal's foreground, or its shell's folder, changed.
    #[serde(rename = "terminal.process")]
    TerminalProcess {
        id: String,
        process: Option<String>,
        cwd: Option<String>,
    },
    /// A program in a terminal asked for attention (OSC 9 / OSC 777).
    #[serde(rename = "terminal.notify")]
    TerminalNotify {
        id: String,
        title: Option<String>,
        body: String,
    },
    /// A terminal's program exited; the terminal is gone.
    #[serde(rename = "terminal.exit")]
    TerminalExit { id: String, code: Option<i32> },
    /// The connection to the terminal daemon was lost; attached terminals
    /// need attaching again.
    #[serde(rename = "terminal.disconnected")]
    TerminalDisconnected,
    /// An item was added to the inbox, or answered or dismissed.
    #[serde(rename = "inbox.changed")]
    InboxChanged {
        /// The item added, if one was.
        #[ts(optional)]
        added: Option<InboxItem>,
    },
    /// An agent in a terminal changed state.
    #[serde(rename = "agent.changed")]
    AgentChanged { agent: AgentInfo },
}

/// What Claude Code in a terminal is doing, from its hooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AgentState {
    /// Started, or at its prompt.
    Idle,
    /// Working on a prompt.
    Working,
    /// Waiting on you: a permission prompt, or a question.
    Waiting,
    /// Finished what it was asked.
    Finished,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentInfo {
    /// The terminal (`GROUNDWORK_TAB_ID`).
    pub tab: String,
    /// Claude Code's session id, for resuming or forking it.
    #[ts(optional)]
    pub session: Option<String>,
    pub state: AgentState,
    /// What it said when it last asked for attention.
    #[ts(optional)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalInfo {
    pub id: String,
    /// The shell's current folder.
    pub cwd: String,
    /// The program it started (`zsh`).
    pub program: String,
    /// What's running in the foreground (`zsh`, `claude`, `vim`).
    pub process: Option<String>,
    /// Set by the program; empty if never set.
    pub title: String,
    /// Seconds since the Unix epoch.
    #[ts(type = "number")]
    pub started: u64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalSnapshot {
    /// Escape sequences that redraw the terminal on a blank one of the
    /// attached size.
    pub data: String,
    /// Output events with a lower `seq` are already part of `data`.
    #[ts(type = "number")]
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WriteResult {
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreatedNote {
    pub path: String,
    /// Where `{{cursor}}` was, in UTF-16 code units (as editors count).
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<u32>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RenderedTemplate {
    pub text: String,
    /// Where `{{cursor}}` was, in UTF-16 code units.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<u32>,
}

/// Which host is serving the API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Host {
    Desktop,
    DevServer,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppInfo {
    pub version: String,
    pub host: Host,
    /// The secret first segment of page URLs (`/page/<token>/<path>`).
    pub page_token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ErrorCode {
    BadRequest,
    NoVault,
    NotFound,
    Forbidden,
    Conflict,
    TooLarge,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

impl From<CoreError> for ApiError {
    fn from(err: CoreError) -> Self {
        let code = match &err {
            CoreError::NotFound(_) | CoreError::NotADirectory(_) => ErrorCode::NotFound,
            CoreError::OutsideVault(_) => ErrorCode::Forbidden,
            CoreError::AlreadyExists(_) | CoreError::Conflict(_) => ErrorCode::Conflict,
            CoreError::InvalidPath(_) | CoreError::Config(_) => ErrorCode::BadRequest,
            CoreError::RepoNotLocated(_) | CoreError::Git(_) => ErrorCode::Conflict,
            CoreError::TooLarge { .. } => ErrorCode::TooLarge,
            CoreError::Io(_) | CoreError::Json(_) | CoreError::Setup(_) => ErrorCode::Internal,
        };
        Self::new(code, err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn requests_use_method_and_params() {
        let req: Request =
            serde_json::from_value(json!({ "method": "file.read", "params": { "path": "a.md" } }))
                .unwrap();
        assert!(matches!(req, Request::FileRead { path } if path == "a.md"));

        let req: Request = serde_json::from_value(json!({ "method": "vault.tree" })).unwrap();
        assert!(matches!(req, Request::VaultTree));
    }
}
