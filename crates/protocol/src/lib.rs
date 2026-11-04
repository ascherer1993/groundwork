//! The Groundwork API: one request enum, one error type.
//!
//! The same JSON shapes travel over Tauri IPC (the desktop app), the dev
//! WebSocket (browser mode, used for Playwright), and later the CLI socket.
//! `cargo test` exports TypeScript versions of these types to
//! `app/src/api/generated/`.

use std::collections::HashMap;

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
}

/// Pushed from the backend to the UI, serialized as `{ "event": "...", "payload": {...} }`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "event", content = "payload")]
#[ts(export)]
pub enum Event {
    /// Files changed, through Groundwork or outside it.
    #[serde(rename = "vault.changed")]
    VaultChanged { changes: Vec<FileChange> },
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
            CoreError::InvalidPath(_) => ErrorCode::BadRequest,
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
