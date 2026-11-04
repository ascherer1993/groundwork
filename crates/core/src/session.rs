//! An open vault: the index plus every operation that changes files.
//!
//! All writes go through here so the index, the activity log and the undo
//! history stay consistent. Mutating operations are serialized by one lock.

use std::collections::HashMap;
use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock, RwLockReadGuard};
use std::time::{Duration, Instant, UNIX_EPOCH};

use chrono::{Local, NaiveDate};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::activity::{ActivityKind, ActivityLog, ActivitySource, machine_id};
use crate::daily::DailySettings;
use crate::index::{FileEntry, Index, NewFileLocation, Upsert, hash, link_name};
use crate::pages;
use crate::parse::{self, LinkKind, Task};
use crate::template::{self, Rendered, TemplateSettings};
use crate::todos::{self, TaskChange};
use crate::tree::{NodeKind, classify, is_hidden};
use crate::{CoreError, Result, Vault};

const MAX_UNDO: usize = 20;
const SNAPSHOT_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ChangeKind {
    Created,
    Modified,
    Removed,
    /// `from` holds the old path.
    Moved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileChange {
    pub path: String,
    pub kind: ChangeKind,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub from: Option<String>,
    /// Made outside Groundwork (seen by the file watcher).
    pub external: bool,
}

impl FileChange {
    fn new(path: &str, kind: ChangeKind, external: bool) -> Self {
        Self {
            path: path.to_string(),
            kind,
            from: None,
            external,
        }
    }

    fn moved(from: &str, to: &str) -> Self {
        Self {
            path: to.to_string(),
            kind: ChangeKind::Moved,
            from: Some(from.to_string()),
            external: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RenameOutcome {
    pub from: String,
    pub to: String,
    /// Notes whose links were rewritten.
    pub updated_notes: Vec<String>,
    pub updated_links: u32,
    /// Notes that changed on disk mid-rename and were left alone.
    pub skipped_notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UndoEdit {
    path: String,
    before: String,
    after_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UndoOp {
    label: String,
    created: String,
    /// The path that was moved (a file, bundle or folder).
    from: String,
    to: String,
    /// Index entries moved with it (one for a file; every descendant for a folder).
    entries: Vec<(String, String)>,
    edits: Vec<UndoEdit>,
}

pub struct Session {
    vault: Vault,
    index: RwLock<Index>,
    activity: ActivityLog,
    state_dir: PathBuf,
    workspaces: crate::workspaces::Workspaces,
    repos: crate::repos::RepoLocations,
    write_lock: Mutex<()>,
    snapshot_saved: Mutex<Instant>,
    /// Who changes made through this session are logged as.
    source: ActivitySource,
    /// Whether this session keeps the change-detection snapshot.
    snapshots: bool,
    /// Task events found while reindexing, logged by `log_changes`.
    pending_tasks: Mutex<Vec<(String, ActivityKind, Task)>>,
}

impl Session {
    pub fn open(vault: Vault, data_dir: &Path) -> Result<Self> {
        let session = Self::build(vault, data_dir, ActivitySource::App, true)?;
        session.reconcile_snapshot();
        Ok(session)
    }

    /// A session for a one-off tool such as the CLI, which may run while the
    /// app is open. It logs changes as `source` and leaves the startup
    /// snapshot (used to detect changes made while Groundwork was closed) to
    /// the app.
    pub fn open_for_tool(vault: Vault, data_dir: &Path, source: ActivitySource) -> Result<Self> {
        Self::build(vault, data_dir, source, false)
    }

    fn build(
        vault: Vault,
        data_dir: &Path,
        source: ActivitySource,
        snapshots: bool,
    ) -> Result<Self> {
        let index = Index::build(vault.root())?;
        let key = &blake3::hash(vault.root().to_string_lossy().as_bytes()).to_hex()[..16];
        let session = Self {
            activity: ActivityLog::new(vault.root(), &machine_id(data_dir)),
            state_dir: data_dir.join("vaults").join(key),
            workspaces: crate::workspaces::Workspaces::new(&data_dir.join("vaults").join(key)),
            repos: crate::repos::RepoLocations::new(&data_dir.join("vaults").join(key)),
            vault,
            index: RwLock::new(index),
            write_lock: Mutex::new(()),
            snapshot_saved: Mutex::new(Instant::now()),
            source,
            snapshots,
            pending_tasks: Mutex::new(Vec::new()),
        };
        Ok(session)
    }

    /// Logs changes made through this session as `source` (the CLI uses `Cli`).
    pub fn with_source(mut self, source: ActivitySource) -> Self {
        self.source = source;
        self
    }

    pub fn vault(&self) -> &Vault {
        &self.vault
    }

    /// This vault's workspaces (machine-local).
    pub fn workspaces(&self) -> &crate::workspaces::Workspaces {
        &self.workspaces
    }

    /// Where this vault's repos are on this machine.
    pub fn repos(&self) -> &crate::repos::RepoLocations {
        &self.repos
    }

    pub fn index(&self) -> RwLockReadGuard<'_, Index> {
        self.index.read().unwrap()
    }

    // ---- Writing -------------------------------------------------------

    /// Replaces a note's text. Returns the new content hash.
    pub fn write_file(&self, path: &str, text: &str) -> Result<(String, Vec<FileChange>)> {
        let _guard = self.write_lock.lock().unwrap();
        let full = self.vault.resolve(path)?;
        if full.is_dir() {
            return Err(CoreError::InvalidPath(format!("{path} is a folder")));
        }
        atomic_write(&full, text)?;
        let changes = self.reindex(&[path], false);
        self.log_changes(&changes, self.source);
        Ok((hash(text.as_bytes()), changes))
    }

    /// Creates a file. Notes created without text get a `created:` property.
    pub fn create_file(&self, path: &str, text: Option<&str>) -> Result<Vec<FileChange>> {
        let _guard = self.write_lock.lock().unwrap();
        validate_new_path(path)?;
        let full = self.vault.root().join(path);
        if full.exists() {
            return Err(CoreError::AlreadyExists(path.to_string()));
        }
        self.ensure_parent(path)?;
        let default;
        let text = match text {
            Some(t) => t,
            None if classify(path, false) == NodeKind::Note => {
                default = format!(
                    "---\ncreated: {}\n---\n",
                    Local::now().format("%Y-%m-%dT%H:%M")
                );
                &default
            }
            None if classify(path, false) == NodeKind::Page => {
                default = starter_page(file_name(path));
                &default
            }
            None => "",
        };
        atomic_write(&full, text)?;
        let changes = self.reindex(&[path], false);
        self.log_changes(&changes, self.source);
        Ok(changes)
    }

    /// Creates `Untitled.md` (or `Untitled 1.md`, …) in `folder`.
    pub fn create_untitled(&self, folder: &str) -> Result<(String, Vec<FileChange>)> {
        let path = self.available_path(folder, "Untitled", ".md");
        let changes = self.create_file(&path, None)?;
        Ok((path, changes))
    }

    /// Where a note for the unresolved link `[[target]]` in `source` goes:
    /// - a daily note name (per `daily-notes.json`) → the daily notes folder
    /// - a link with a folder in it → that path from the vault root
    /// - anything else → Obsidian's "Default location for new notes"
    pub fn path_for_link(&self, source: &str, target: &str) -> String {
        let target = target.trim().trim_start_matches('/');
        let name = target.strip_suffix(".md").unwrap_or(target);
        // `[[sketch.html]]` makes a page; every other name makes a note.
        let lower = name.to_lowercase();
        let file = if lower.ends_with(".html") || lower.ends_with(".htm") {
            name.to_string()
        } else {
            format!("{name}.md")
        };
        let daily = DailySettings::read(self.vault.root());
        if let Some(date) = daily.date_of(name) {
            return daily.path_for(date);
        }
        if name.contains('/') {
            return file;
        }
        let settings = self.index().settings().clone();
        let folder = match settings.new_file_location {
            NewFileLocation::Root => "",
            NewFileLocation::Current => source.rsplit_once('/').map_or("", |(dir, _)| dir),
            NewFileLocation::Folder => settings.new_file_folder.as_str(),
        };
        if folder.is_empty() {
            file
        } else {
            format!("{folder}/{file}")
        }
    }

    /// Creates the note an unresolved link points to (see [`Self::path_for_link`]).
    /// Daily notes get the daily template. If the note already exists,
    /// returns its path without changes.
    pub fn create_from_link(
        &self,
        source: &str,
        target: &str,
    ) -> Result<(String, Vec<FileChange>)> {
        let path = self.path_for_link(source, target);
        let daily = DailySettings::read(self.vault.root());
        if let Some(date) = daily.date_of(target.trim().trim_start_matches('/'))
            && daily.path_for(date) == path
        {
            return self.daily_note(date);
        }
        match self.create_file(&path, None) {
            Ok(changes) => Ok((path, changes)),
            Err(CoreError::AlreadyExists(_)) => Ok((path, Vec::new())),
            Err(err) => Err(err),
        }
    }

    // ---- Templates & daily notes --------------------------------------

    /// The notes in the templates folder, sorted.
    pub fn templates(&self) -> Vec<String> {
        let prefix = format!("{}/", TemplateSettings::read(self.vault.root()).folder);
        let index = self.index();
        let mut paths: Vec<String> = index
            .paths()
            .filter(|p| p.starts_with(&prefix) && p.ends_with(".md"))
            .map(str::to_string)
            .collect();
        paths.sort_by_key(|p| p.to_lowercase());
        paths
    }

    fn read_template(&self, template: &str) -> Result<String> {
        let full = self.vault.resolve(template)?;
        if !full.is_file() {
            return Err(CoreError::NotFound(template.to_string()));
        }
        Ok(fs::read_to_string(full)?)
    }

    /// The `{{prompt:…}}` labels the template will ask for.
    pub fn template_prompts(&self, template: &str) -> Result<Vec<String>> {
        Ok(template::prompts(&self.read_template(template)?))
    }

    /// The date `{{date}}` means for a note: a daily note's day, otherwise today.
    pub fn note_date(&self, path: &str) -> NaiveDate {
        let daily = DailySettings::read(self.vault.root());
        let in_folder = match daily.folder.as_str() {
            "" => Some(path),
            folder => path.strip_prefix(folder).and_then(|p| p.strip_prefix('/')),
        };
        in_folder
            .and_then(|p| daily.date_of(p))
            .unwrap_or_else(|| Local::now().date_naive())
    }

    fn template_context(
        &self,
        path: &str,
        date: Option<NaiveDate>,
        answers: HashMap<String, String>,
    ) -> template::Context {
        template::Context {
            date: date.unwrap_or_else(|| self.note_date(path)),
            now: Local::now().naive_local(),
            path: path.to_string(),
            answers,
            vars: HashMap::new(),
            settings: TemplateSettings::read(self.vault.root()),
        }
    }

    /// Renders a template as if written into the note at `path`, for
    /// inserting into an existing note.
    pub fn render_template(
        &self,
        template: &str,
        path: &str,
        answers: HashMap<String, String>,
    ) -> Result<Rendered> {
        let text = self.read_template(template)?;
        Ok(template::render(
            &text,
            &self.template_context(path, None, answers),
        ))
    }

    /// Creates a note at `path` from a template. Returns the byte offset of
    /// `{{cursor}}` in the new note, if the template has one.
    pub fn create_from_template(
        &self,
        template: &str,
        path: &str,
        date: Option<NaiveDate>,
        answers: HashMap<String, String>,
    ) -> Result<(Option<usize>, Vec<FileChange>)> {
        let source = self.read_template(template)?;
        let ctx = self.template_context(path, date, answers);
        let rendered = template::render(&source, &ctx);
        let (text, cursor) = with_created(rendered, ctx.now);
        let changes = self.create_file(path, Some(&text))?;
        Ok((cursor, changes))
    }

    /// Creates a note from a template with context tags (`ticket.key`, …).
    pub(crate) fn create_from_template_with(
        &self,
        template: &str,
        path: &str,
        vars: HashMap<String, String>,
    ) -> Result<(Option<usize>, Vec<FileChange>)> {
        let source = self.read_template(template)?;
        let mut ctx = self.template_context(path, None, HashMap::new());
        ctx.vars = vars;
        let rendered = template::render(&source, &ctx);
        let (text, cursor) = with_created(rendered, ctx.now);
        let changes = self.create_file(path, Some(&text))?;
        Ok((cursor, changes))
    }

    /// The daily note for `date`, created (from the daily template, if one
    /// is set) when it doesn't exist yet.
    pub fn daily_note(&self, date: NaiveDate) -> Result<(String, Vec<FileChange>)> {
        let daily = DailySettings::read(self.vault.root());
        let path = daily.path_for(date);
        if self.vault.root().join(&path).exists() {
            return Ok((path, Vec::new()));
        }
        let template = daily
            .template
            .map(|t| {
                if t.ends_with(".md") {
                    t
                } else {
                    format!("{t}.md")
                }
            })
            .filter(|t| self.vault.root().join(t).is_file());
        let created = match template {
            Some(t) => self
                .create_from_template(&t, &path, Some(date), HashMap::new())
                .map(|(_, changes)| changes),
            None => self.create_file(&path, None),
        };
        match created {
            Ok(changes) => Ok((path, changes)),
            Err(CoreError::AlreadyExists(_)) => Ok((path, Vec::new())),
            Err(err) => Err(err),
        }
    }

    pub fn create_folder(&self, path: &str) -> Result<()> {
        let _guard = self.write_lock.lock().unwrap();
        validate_new_path(path)?;
        let full = self.vault.root().join(path);
        if full.exists() {
            return Err(CoreError::AlreadyExists(path.to_string()));
        }
        self.ensure_parent(path)?;
        fs::create_dir(full)?;
        Ok(())
    }

    /// First free `folder/base{ext}`, `folder/base 1{ext}`, …
    pub fn available_path(&self, folder: &str, base: &str, ext: &str) -> String {
        let prefix = if folder.is_empty() {
            String::new()
        } else {
            format!("{folder}/")
        };
        (0..)
            .map(|n| {
                if n == 0 {
                    format!("{prefix}{base}{ext}")
                } else {
                    format!("{prefix}{base} {n}{ext}")
                }
            })
            .find(|p| !self.vault.root().join(p).exists())
            .unwrap()
    }

    /// Moves a file to the system Trash.
    pub fn delete(&self, path: &str) -> Result<Vec<FileChange>> {
        let _guard = self.write_lock.lock().unwrap();
        if path.is_empty() {
            return Err(CoreError::InvalidPath("can't delete the vault root".into()));
        }
        let full = self.vault.resolve(path)?;
        move_to_trash(&full)?;
        let removed = self.index.write().unwrap().remove(path);
        let changes: Vec<FileChange> = removed
            .iter()
            .map(|p| FileChange::new(p, ChangeKind::Removed, false))
            .collect();
        self.log_changes(&changes, self.source);
        Ok(changes)
    }

    // ---- Rename / move -------------------------------------------------

    /// Renames or moves a file, bundle or folder, rewriting every link that
    /// would otherwise break or point somewhere else.
    pub fn rename(&self, from: &str, to: &str) -> Result<(RenameOutcome, Vec<FileChange>)> {
        let _guard = self.write_lock.lock().unwrap();
        let from_full = self.vault.resolve(from)?;
        if from.is_empty() {
            return Err(CoreError::InvalidPath("can't move the vault root".into()));
        }
        validate_new_path(to)?;
        if to == from {
            return Err(CoreError::InvalidPath(
                "the new path is the same as the old one".into(),
            ));
        }
        if to.starts_with(&format!("{from}/")) {
            return Err(CoreError::InvalidPath(
                "can't move a folder into itself".into(),
            ));
        }
        let to_full = self.vault.root().join(to);
        let case_only = to.to_lowercase() == from.to_lowercase();
        if to_full.exists() && !case_only {
            return Err(CoreError::AlreadyExists(to.to_string()));
        }

        let mut index = self.index.write().unwrap();
        index.refresh_stale()?;

        // Which index entries move, and where to.
        let prefix = format!("{from}/");
        let entries: Vec<(String, String)> = index
            .paths()
            .filter(|p| *p == from || p.starts_with(&prefix))
            .map(|p| (p.to_string(), format!("{to}{}", &p[from.len()..])))
            .collect();
        let mapping: HashMap<&str, &str> = entries
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        let map_path = |p: &str| {
            mapping
                .get(p)
                .map_or_else(|| p.to_string(), |n| n.to_string())
        };

        // Where every resolved link points before the move.
        struct Before {
            source: String,
            hash: Option<String>,
            links: Vec<(parse::Link, String)>,
        }
        let before: Vec<Before> = index
            .notes()
            .map(|(source, note)| Before {
                source: source.to_string(),
                hash: index.get(source).and_then(|f| f.hash.clone()),
                links: note
                    .links
                    .iter()
                    .filter_map(|l| index.resolve_link(l, source).map(|t| (l.clone(), t)))
                    .collect(),
            })
            .collect();

        self.ensure_parent(to)?;
        fs::rename(&from_full, &to_full)?;
        for (old, new) in &entries {
            pages::move_state(self.vault.root(), old, new);
        }

        let moved_entries: Vec<FileEntry> = entries
            .iter()
            .filter_map(|(old, _)| index.get(old).cloned())
            .collect();
        for (old, _) in &entries {
            index.remove(old);
        }
        for (entry, (_, new)) in moved_entries.into_iter().zip(&entries) {
            let mut entry = entry;
            entry.path = new.clone();
            index.insert_entry(entry);
        }

        // Rewrite links whose resolution changed.
        let mut outcome = RenameOutcome {
            from: from.to_string(),
            to: to.to_string(),
            updated_notes: Vec::new(),
            updated_links: 0,
            skipped_notes: Vec::new(),
        };
        let mut edits = Vec::new();
        for b in before {
            let source = map_path(&b.source);
            let mut replacements: Vec<(Range<usize>, String)> = Vec::new();
            for (link, target) in &b.links {
                let expected = map_path(target);
                if index.resolve_link(link, &source).as_deref() == Some(expected.as_str()) {
                    continue;
                }
                // A same-note link (`[[#Heading]]`) still works after a move.
                if link.target.is_empty() {
                    continue;
                }
                let kind = link.kind;
                let new_link = index.format_link(
                    &expected,
                    &source,
                    kind,
                    link.subpath.as_deref(),
                    link.alias.as_deref(),
                    link.embed,
                );
                replacements.push((link.range.clone(), new_link));
            }
            if replacements.is_empty() {
                continue;
            }
            let full = self.vault.root().join(&source);
            let text = fs::read_to_string(&full)?;
            if b.hash.as_deref() != Some(hash(text.as_bytes()).as_str()) {
                outcome.skipped_notes.push(source);
                continue;
            }
            let mut updated = text.clone();
            replacements.sort_by_key(|(r, _)| std::cmp::Reverse(r.start));
            for (range, replacement) in &replacements {
                updated.replace_range(range.clone(), replacement);
            }
            atomic_write(&full, &updated)?;
            outcome.updated_links += replacements.len() as u32;
            outcome.updated_notes.push(source.clone());
            edits.push(UndoEdit {
                path: source,
                before: text,
                after_hash: hash(updated.as_bytes()),
            });
        }
        for path in &outcome.updated_notes {
            let _ = index.upsert(path);
        }
        drop(index);

        let mut changes: Vec<FileChange> = entries
            .iter()
            .map(|(old, new)| FileChange::moved(old, new))
            .collect();
        changes.extend(
            outcome
                .updated_notes
                .iter()
                .filter(|p| !mapping.values().any(|n| n == p))
                .map(|p| FileChange::new(p, ChangeKind::Modified, false)),
        );
        self.log_changes(&changes, self.source);

        let label = if parent_of(from) == parent_of(to) {
            format!("Rename {} to {}", file_name(from), file_name(to))
        } else {
            format!("Move {} to {}", file_name(from), parent_label(to))
        };
        self.push_undo(UndoOp {
            label,
            created: Local::now().to_rfc3339(),
            from: from.to_string(),
            to: to.to_string(),
            entries,
            edits,
        });
        Ok((outcome, changes))
    }

    /// Label of the operation `undo` would revert.
    pub fn undo_label(&self) -> Option<String> {
        self.load_undo().last().map(|op| op.label.clone())
    }

    /// Reverts the last rename/move, including its link rewrites. Refuses if
    /// any affected file changed since.
    pub fn undo(&self) -> Result<(String, Vec<FileChange>)> {
        let _guard = self.write_lock.lock().unwrap();
        let mut ops = self.load_undo();
        let op = ops
            .pop()
            .ok_or_else(|| CoreError::Conflict("nothing to undo".into()))?;
        let root = self.vault.root();

        let changed: Vec<&str> = op
            .edits
            .iter()
            .filter(|e| {
                fs::read(root.join(&e.path))
                    .map(|b| hash(&b))
                    .ok()
                    .as_deref()
                    != Some(e.after_hash.as_str())
            })
            .map(|e| e.path.as_str())
            .collect();
        if !changed.is_empty() {
            return Err(CoreError::Conflict(format!(
                "can't undo: changed since: {}",
                changed.join(", ")
            )));
        }
        let case_only = op.from.to_lowercase() == op.to.to_lowercase();
        if !root.join(&op.to).exists() || (root.join(&op.from).exists() && !case_only) {
            return Err(CoreError::Conflict(format!(
                "can't undo: {} or {} has moved since",
                op.from, op.to
            )));
        }

        for edit in &op.edits {
            atomic_write(&root.join(&edit.path), &edit.before)?;
        }
        self.ensure_parent(&op.from)?;
        fs::rename(root.join(&op.to), root.join(&op.from))?;
        for (old, new) in &op.entries {
            pages::move_state(root, new, old);
        }

        let mut index = self.index.write().unwrap();
        for (_, new) in &op.entries {
            index.remove(new);
        }
        let reverse: HashMap<&str, &str> = op
            .entries
            .iter()
            .map(|(old, new)| (new.as_str(), old.as_str()))
            .collect();
        let mut changes: Vec<FileChange> = op
            .entries
            .iter()
            .map(|(old, new)| FileChange::moved(new, old))
            .collect();
        let _ = index.upsert(&op.from);
        for edit in &op.edits {
            let path = reverse
                .get(edit.path.as_str())
                .copied()
                .unwrap_or(&edit.path);
            let _ = index.upsert(path);
            if !reverse.contains_key(edit.path.as_str()) {
                changes.push(FileChange::new(path, ChangeKind::Modified, false));
            }
        }
        drop(index);
        self.save_undo(&ops);
        self.log_changes(&changes, self.source);
        Ok((op.label, changes))
    }

    // ---- Small edits ---------------------------------------------------

    /// Turns the plain-text mention at `range` in `source` into a link to `target`.
    pub fn link_mention(
        &self,
        source: &str,
        range: Range<usize>,
        expected: &str,
        target: &str,
    ) -> Result<Vec<FileChange>> {
        let text = fs::read_to_string(self.vault.resolve(source)?)?;
        let current = text.get(range.clone()).unwrap_or_default();
        if current.to_lowercase() != expected.to_lowercase() {
            return Err(CoreError::Conflict(format!(
                "{source} changed; mention not found"
            )));
        }
        let link = {
            let index = self.index();
            let kind = if index.settings().markdown_links {
                LinkKind::Markdown
            } else {
                LinkKind::Wiki
            };
            let target_kind = index.get(target).map_or(NodeKind::Note, |f| f.kind);
            let name = link_name(target, target_kind);
            let path = index.link_path(target, source, kind);
            let alias = (current != name || path != name).then_some(current);
            index.format_link(target, source, kind, None, alias, false)
        };
        let mut updated = text.clone();
        updated.replace_range(range, &link);
        Ok(self.write_file(source, &updated)?.1)
    }

    /// Checks or unchecks the task on `line` (zero-based).
    pub fn toggle_task(&self, path: &str, line: u32) -> Result<Vec<FileChange>> {
        let today = Local::now().format("%Y-%m-%d").to_string();
        self.edit_line(path, line, |content| {
            parse::toggle_task_line(content, &today).ok_or_else(|| {
                CoreError::Conflict(format!("line {} of {path} isn't a task", line + 1))
            })
        })
    }

    /// Replaces one line of a note (zero-based), keeping its line ending.
    fn edit_line(
        &self,
        path: &str,
        line: u32,
        edit: impl FnOnce(&str) -> Result<String>,
    ) -> Result<Vec<FileChange>> {
        let text = fs::read_to_string(self.vault.resolve(path)?)?;
        let mut lines: Vec<&str> = text.split_inclusive('\n').collect();
        let original = lines
            .get(line as usize)
            .ok_or_else(|| CoreError::Conflict(format!("{path} has no line {}", line + 1)))?;
        let (content, newline) = match original.strip_suffix("\r\n") {
            Some(c) => (c, "\r\n"),
            None => original
                .strip_suffix('\n')
                .map_or((*original, ""), |c| (c, "\n")),
        };
        let replacement = format!("{}{newline}", edit(content)?);
        lines[line as usize] = &replacement;
        Ok(self.write_file(path, &lines.concat())?.1)
    }

    // ---- Todos ----------------------------------------------------------

    /// Todos matching `filter`, most urgent first.
    pub fn todos(&self, filter: &todos::TodoFilter) -> Vec<todos::Todo> {
        let daily = DailySettings::read(self.vault.root());
        todos::list(&self.index(), &daily, filter, Local::now().date_naive())
    }

    /// The `todos` day view for the note at `path`, for that note's date.
    pub fn todo_day(&self, path: &str) -> todos::DayView {
        let daily = DailySettings::read(self.vault.root());
        todos::day(&self.index(), &daily, self.note_date(path), path)
    }

    /// Changes the task with `id` (see [`todos::todo_id`]). Fails with a
    /// conflict if the line no longer holds that task.
    pub fn update_task(&self, id: &str, change: &TaskChange) -> Result<Vec<FileChange>> {
        let (path, line, hash_prefix) = todos::split_id(id)
            .ok_or_else(|| CoreError::InvalidPath(format!("not a todo id: {id}")))?;
        let today = Local::now().format("%Y-%m-%d").to_string();
        self.edit_line(path, line, |content| {
            let stale = || {
                CoreError::Conflict(format!(
                    "the task at {path}:{} changed since it was listed",
                    line + 1
                ))
            };
            let task = parse::parse_task_line(content).ok_or_else(stale)?;
            if !hash(task.text.as_bytes()).starts_with(hash_prefix) {
                return Err(stale());
            }
            let edited = match change {
                TaskChange::Done => parse::set_task_status(content, 'x', &today),
                TaskChange::Cancel => parse::set_task_status(content, '-', &today),
                TaskChange::Reopen => parse::set_task_status(content, ' ', &today),
                TaskChange::Due { date } => {
                    if let Some(d) = date {
                        NaiveDate::parse_from_str(d, "%Y-%m-%d").map_err(|_| {
                            CoreError::InvalidPath(format!("not a YYYY-MM-DD date: {d}"))
                        })?;
                    }
                    parse::set_task_date(content, "📅", date.as_deref())
                }
                TaskChange::Priority { priority } if *priority <= 5 => {
                    parse::set_task_priority(content, *priority)
                }
                TaskChange::Priority { priority } => {
                    return Err(CoreError::InvalidPath(format!(
                        "priority must be 0–5, not {priority}"
                    )));
                }
            };
            edited.ok_or_else(stale)
        })
    }

    /// Adds a task to `path` (by default today's daily note, created if
    /// needed), under its `## Todos` heading. Returns the new task's id.
    pub fn add_task(
        &self,
        path: Option<&str>,
        text: &str,
        due: Option<NaiveDate>,
        priority: u8,
    ) -> Result<(String, Vec<FileChange>)> {
        let text = text.trim();
        if text.is_empty() || text.contains('\n') {
            return Err(CoreError::InvalidPath(
                "a todo needs one line of text".into(),
            ));
        }
        let mut changes = Vec::new();
        let path = match path {
            Some(p) => p.to_string(),
            None => {
                let (p, created) = self.daily_note(Local::now().date_naive())?;
                changes.extend(created);
                p
            }
        };
        let full = self.vault.resolve(&path)?;
        let original = fs::read_to_string(&full).map_err(|_| CoreError::NotFound(path.clone()))?;
        let today = Local::now().format("%Y-%m-%d").to_string();
        let due = due.map(|d| d.to_string());
        let task = parse::new_task_line(text, priority.min(5), due.as_deref(), &today);
        let (updated, line) = insert_under_heading(&original, TODO_HEADING, &task);
        changes.extend(self.write_file(&path, &updated)?.1);
        let parsed = parse::parse_task_line(&task).expect("a task line");
        let id = format!("{path}:{line}:{}", &hash(parsed.text.as_bytes())[..8]);
        Ok((id, changes))
    }

    // ---- Page state ----------------------------------------------------

    /// The state a page saved through the bridge; `null` if none.
    pub fn page_state(&self, page: &str) -> Result<serde_json::Value> {
        let page = self.page(page)?;
        pages::read_state(self.vault.root(), &page)
    }

    /// Replaces a page's saved state.
    pub fn set_page_state(&self, page: &str, state: &serde_json::Value) -> Result<()> {
        let _guard = self.write_lock.lock().unwrap();
        let page = self.page(page)?;
        pages::write_state(self.vault.root(), &page, state)
    }

    /// Checks that `path` is a page in the vault.
    fn page(&self, path: &str) -> Result<String> {
        self.vault.resolve(path)?;
        let path = path.trim_matches('/');
        if pages::page_of(path).as_deref() != Some(path) {
            return Err(CoreError::InvalidPath(format!("{path} isn't a page")));
        }
        if !self.vault.root().join(path).exists() {
            return Err(CoreError::NotFound(path.to_string()));
        }
        Ok(path.to_string())
    }

    // ---- File watcher --------------------------------------------------

    /// Applies changes seen by the file watcher (vault-relative paths).
    pub fn apply_external(&self, paths: &[String]) -> Vec<FileChange> {
        let _guard = self.write_lock.lock().unwrap();
        let mut refs: Vec<&str> = Vec::new();
        for path in paths {
            if path == ".obsidian/app.json" {
                self.index.write().unwrap().reload_settings();
            } else {
                refs.push(path);
            }
        }
        let changes = self.reindex(&refs, true);
        self.log_changes(&changes, ActivitySource::External);
        changes
    }

    /// Re-reads paths from disk and reports what changed.
    fn reindex(&self, paths: &[&str], external: bool) -> Vec<FileChange> {
        let mut index = self.index.write().unwrap();
        let mut changes = Vec::new();
        for path in paths {
            let old_tasks = index
                .note(path)
                .map(|n| n.tasks.clone())
                .unwrap_or_default();
            if self.vault.root().join(path).exists() {
                let upserted = index.upsert(path).unwrap_or_default();
                if let Some(note) = index.note(path) {
                    let events = todos::task_events(&old_tasks, &note.tasks, external);
                    self.pending_tasks
                        .lock()
                        .unwrap()
                        .extend(events.into_iter().map(|(k, t)| (path.to_string(), k, t)));
                }
                for (p, change) in upserted {
                    let kind = match change {
                        Upsert::Created => ChangeKind::Created,
                        Upsert::Modified => ChangeKind::Modified,
                        Upsert::Unchanged => continue,
                    };
                    changes.push(FileChange::new(&p, kind, external));
                }
            } else {
                changes.extend(
                    index
                        .remove(path)
                        .iter()
                        .map(|p| FileChange::new(p, ChangeKind::Removed, external)),
                );
            }
        }
        drop(index);
        self.maybe_save_snapshot();
        changes
    }

    fn log_changes(&self, changes: &[FileChange], source: ActivitySource) {
        for c in changes {
            let kind = match c.kind {
                ChangeKind::Created => ActivityKind::Created,
                ChangeKind::Modified => ActivityKind::Modified,
                ChangeKind::Removed => ActivityKind::Deleted,
                ChangeKind::Moved => ActivityKind::Moved,
            };
            self.activity
                .record(kind, &c.path, c.from.as_deref(), source);
        }
        for (path, kind, task) in self.pending_tasks.lock().unwrap().drain(..) {
            self.activity
                .record_task(kind, &path, &task.text, task.due.as_deref(), source);
        }
    }

    fn ensure_parent(&self, path: &str) -> Result<()> {
        if let Some(parent) = self.vault.root().join(path).parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    // ---- Undo history (machine-local) ---------------------------------

    fn undo_file(&self) -> PathBuf {
        self.state_dir.join("undo.json")
    }

    fn load_undo(&self) -> Vec<UndoOp> {
        fs::read(self.undo_file())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save_undo(&self, ops: &[UndoOp]) {
        let _ = fs::create_dir_all(&self.state_dir);
        let _ = fs::write(
            self.undo_file(),
            serde_json::to_vec(ops).unwrap_or_default(),
        );
    }

    fn push_undo(&self, op: UndoOp) {
        let mut ops = self.load_undo();
        ops.push(op);
        let excess = ops.len().saturating_sub(MAX_UNDO);
        ops.drain(..excess);
        self.save_undo(&ops);
    }

    // ---- Snapshot: detects edits made while Groundwork was closed ------

    fn snapshot_file(&self) -> PathBuf {
        self.state_dir.join("snapshot.json")
    }

    fn signatures(&self) -> HashMap<String, String> {
        let index = self.index();
        index
            .paths()
            .filter_map(|p| index.get(p))
            .map(|f| {
                let sig = f.hash.clone().unwrap_or_else(|| {
                    let mtime = f
                        .mtime
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map_or(0, |d| d.as_secs());
                    format!("{}:{mtime}", f.size)
                });
                (f.path.clone(), sig)
            })
            .collect()
    }

    fn reconcile_snapshot(&self) {
        let previous: Option<HashMap<String, String>> = fs::read(self.snapshot_file())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok());
        if let Some(previous) = previous {
            let current = self.signatures();
            let detected = ActivitySource::Detected;
            for (path, sig) in &current {
                match previous.get(path) {
                    None => self
                        .activity
                        .record(ActivityKind::Created, path, None, detected),
                    Some(old) if old != sig => {
                        self.activity
                            .record(ActivityKind::Modified, path, None, detected)
                    }
                    _ => {}
                }
            }
            for path in previous.keys().filter(|p| !current.contains_key(*p)) {
                self.activity
                    .record(ActivityKind::Deleted, path, None, detected);
            }
        }
        self.save_snapshot();
    }

    pub fn save_snapshot(&self) {
        if !self.snapshots {
            return;
        }
        let _ = fs::create_dir_all(&self.state_dir);
        let _ = fs::write(
            self.snapshot_file(),
            serde_json::to_vec(&self.signatures()).unwrap_or_default(),
        );
        *self.snapshot_saved.lock().unwrap() = Instant::now();
    }

    fn maybe_save_snapshot(&self) {
        if self.snapshot_saved.lock().unwrap().elapsed() >= SNAPSHOT_INTERVAL {
            self.save_snapshot();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.save_snapshot();
    }
}

/// A new page: an empty document that follows light and dark mode.
fn starter_page(name: &str) -> String {
    let title = name.rsplit_once('.').map_or(name, |(base, _)| base);
    let title = title
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{title}</title>
    <style>
      :root {{ color-scheme: light dark; font-family: system-ui, sans-serif; }}
    </style>
  </head>
  <body>
    <h1>{title}</h1>
  </body>
</html>
"#
    )
}

/// Writes via a hidden temp file and a rename, so a crash never leaves a
/// half-written note.
pub(crate) fn atomic_write(path: &Path, text: &str) -> Result<()> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.groundwork-tmp"));
    fs::write(&tmp, text)?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn move_to_trash(path: &Path) -> Result<()> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    // NSFileManager needs no Automation permission (Finder's method does).
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(path)
        .map_err(|e| CoreError::Io(std::io::Error::other(e.to_string())))
}

#[cfg(not(target_os = "macos"))]
fn move_to_trash(path: &Path) -> Result<()> {
    trash::delete(path).map_err(|e| CoreError::Io(std::io::Error::other(e.to_string())))
}

/// Characters that break links or aren't allowed in file names on some platforms.
const FORBIDDEN: &[char] = &['\\', ':', '*', '?', '"', '<', '>', '|', '[', ']', '#', '^'];

/// The heading new todos go under.
const TODO_HEADING: &str = "Todos";

/// Inserts `line` as the last item of the list under the `## heading`
/// section (appending the section if missing). Returns the new text and the
/// zero-based line number of the inserted line.
fn insert_under_heading(text: &str, heading: &str, line: &str) -> (String, u32) {
    let mut lines: Vec<&str> = text.lines().collect();
    let is_heading = |l: &str| {
        let t = l.trim_start_matches('#');
        t.len() < l.len() && t.starts_with(' ') && t.trim().eq_ignore_ascii_case(heading)
    };
    let is_item = |l: &str| {
        let t = l.trim_start();
        t.starts_with("- ") || t.starts_with("* ") || t.starts_with("+ ")
    };
    let at = match lines.iter().position(|l| is_heading(l)) {
        Some(h) => {
            let mut i = h + 1;
            while i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }
            let first = i;
            while i < lines.len() && (is_item(lines[i]) || lines[i].starts_with("  ")) {
                i += 1;
            }
            if i == first {
                // No list yet: replace the blank lines after the heading with
                // a blank, the task and (if anything follows) another blank.
                let mut insert = vec!["", line];
                if first < lines.len() {
                    insert.push("");
                }
                lines.splice(h + 1..first, insert);
                return (with_newline(&lines, text), (h + 2) as u32);
            }
            i
        }
        None => {
            while lines.last().is_some_and(|l| l.trim().is_empty()) {
                lines.pop();
            }
            if !lines.is_empty() {
                lines.push("");
            }
            let heading_line = format!("## {heading}");
            let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
            out.extend([heading_line, String::new(), line.to_string()]);
            let line_no = out.len() - 1;
            return (out.join("\n") + "\n", line_no as u32);
        }
    };
    lines.insert(at, line);
    (with_newline(&lines, text), at as u32)
}

fn with_newline(lines: &[&str], original: &str) -> String {
    let mut out = lines.join("\n");
    if original.ends_with('\n') || !original.contains('\n') {
        out.push('\n');
    }
    out
}

/// Adds a `created: now` property to a new note's text unless it has one.
pub fn with_created_property(text: &str) -> String {
    let rendered = Rendered {
        text: text.to_string(),
        cursor: None,
    };
    with_created(rendered, Local::now().naive_local()).0
}

/// Adds a `created:` property to a new note unless its template set one,
/// keeping the cursor offset in step.
fn with_created(rendered: Rendered, now: chrono::NaiveDateTime) -> (String, Option<usize>) {
    let Rendered { text, cursor } = rendered;
    let line = format!("created: {}\n", now.format("%Y-%m-%dT%H:%M"));
    let frontmatter_end = text
        .strip_prefix("---\n")
        .and_then(|rest| match rest.find("\n---") {
            Some(i) => Some(i + "---\n".len() + 1),
            None => rest.starts_with("---").then_some("---\n".len()),
        });
    let at = match frontmatter_end {
        Some(end) if text[..end].lines().any(|l| l.starts_with("created:")) => {
            return (text, cursor);
        }
        Some(end) => end,
        None => 0,
    };
    let insert = if frontmatter_end.is_some() {
        line
    } else {
        format!("---\n{line}---\n")
    };
    let cursor = cursor.map(|c| if c >= at { c + insert.len() } else { c });
    let mut text = text;
    text.insert_str(at, &insert);
    (text, cursor)
}

fn validate_new_path(path: &str) -> Result<()> {
    if path.is_empty() || path.starts_with('/') {
        return Err(CoreError::InvalidPath(format!("invalid path: {path:?}")));
    }
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(CoreError::InvalidPath(format!("invalid path: {path:?}")));
        }
        if is_hidden(part) {
            return Err(CoreError::InvalidPath(format!(
                "names can't start with a dot: {part}"
            )));
        }
        if let Some(c) = part
            .chars()
            .find(|c| FORBIDDEN.contains(c) || c.is_control())
        {
            return Err(CoreError::InvalidPath(format!(
                "names can't contain {c:?}: {part}"
            )));
        }
        if part.ends_with(' ') || part.ends_with('.') {
            return Err(CoreError::InvalidPath(format!(
                "names can't end with a space or dot: {part:?}"
            )));
        }
    }
    Ok(())
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn parent_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(p, _)| p)
}

fn parent_label(path: &str) -> String {
    match parent_of(path) {
        "" => "the vault root".to_string(),
        p => p.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestVault {
        dir: tempfile::TempDir,
        _data: tempfile::TempDir,
        session: Session,
    }

    impl TestVault {
        fn new(files: &[(&str, &str)]) -> Self {
            let dir = tempfile::tempdir().unwrap();
            for (path, text) in files {
                let full = dir.path().join(path);
                fs::create_dir_all(full.parent().unwrap()).unwrap();
                fs::write(full, text).unwrap();
            }
            let data = tempfile::tempdir().unwrap();
            let session = Session::open(Vault::open(dir.path()).unwrap(), data.path()).unwrap();
            Self {
                dir,
                _data: data,
                session,
            }
        }

        fn read(&self, path: &str) -> String {
            fs::read_to_string(self.dir.path().join(path)).unwrap()
        }

        fn exists(&self, path: &str) -> bool {
            self.dir.path().join(path).exists()
        }
    }

    #[test]
    fn rename_rewrites_links_everywhere() {
        let v = TestVault::new(&[
            ("Old Name.md", "# Old\n\n## Part\n"),
            (
                "A.md",
                "See [[Old Name]], [[Old Name#Part|the part]], ![[Old Name]] and [md](Old%20Name.md#Part).\n`[[Old Name]]` stays.",
            ),
            (
                "B/C.md",
                "---\nrelated: [\"[[Old Name]]\"]\n---\n[[old name]]",
            ),
            ("Unrelated.md", "[[Something Else]]"),
        ]);
        let (outcome, _) = v.session.rename("Old Name.md", "New Name.md").unwrap();
        assert_eq!(outcome.updated_links, 6);
        assert_eq!(
            v.read("A.md"),
            "See [[New Name]], [[New Name#Part|the part]], ![[New Name]] and [md](New%20Name.md#Part).\n`[[Old Name]]` stays."
        );
        assert_eq!(
            v.read("B/C.md"),
            "---\nrelated: [\"[[New Name]]\"]\n---\n[[New Name]]"
        );
        assert_eq!(v.read("Unrelated.md"), "[[Something Else]]");
        assert!(v.exists("New Name.md") && !v.exists("Old Name.md"));
        assert_eq!(v.session.index().backlinks("New Name.md").len(), 2);
    }

    #[test]
    fn rename_leaves_pages_alone() {
        let page = r#"<a href="Old.md">old</a> <a href="[[Old]]">old</a>"#;
        let v = TestVault::new(&[("Old.md", "# Old\n"), ("Demo.page/index.html", page)]);
        assert_eq!(v.session.index().backlinks("Old.md").len(), 1);
        let (outcome, _) = v.session.rename("Old.md", "New.md").unwrap();
        assert_eq!(outcome.updated_links, 0);
        assert_eq!(v.read("Demo.page/index.html"), page);
    }

    #[test]
    fn moving_into_a_duplicate_name_uses_paths() {
        // After the move there are two "Note"s, so links must become explicit.
        let v = TestVault::new(&[
            ("A/Note.md", ""),
            ("Elsewhere/Note.md", ""),
            ("Link.md", "[[A/Note]]"),
            ("Inbox/Note.md", "inbox note"),
            ("Links to inbox.md", "[[Inbox/Note]]"),
        ]);
        // Move Inbox/Note into B: still ambiguous → full path.
        v.session.rename("Inbox/Note.md", "B/Note.md").unwrap();
        assert_eq!(v.read("Links to inbox.md"), "[[B/Note]]");
        assert_eq!(v.read("Link.md"), "[[A/Note]]");
    }

    #[test]
    fn shortest_links_survive_a_move_untouched() {
        let v = TestVault::new(&[("Inbox/Idea.md", ""), ("Index.md", "[[Idea]]")]);
        let (outcome, _) = v
            .session
            .rename("Inbox/Idea.md", "Projects/Idea.md")
            .unwrap();
        assert_eq!(outcome.updated_links, 0);
        assert_eq!(v.read("Index.md"), "[[Idea]]");
    }

    #[test]
    fn moving_a_note_fixes_its_own_relative_links() {
        let v = TestVault::new(&[
            ("Notes/Mover.md", "[sib](Sibling.md) and [[Sibling]]"),
            ("Notes/Sibling.md", ""),
            ("Alpha/Sibling.md", ""),
        ]);
        v.session
            .rename("Notes/Mover.md", "Archive/Mover.md")
            .unwrap();
        // Both links meant Notes/Sibling; from Archive they'd resolve to Alpha/Sibling.
        assert_eq!(
            v.read("Archive/Mover.md"),
            "[sib](Notes/Sibling.md) and [[Notes/Sibling]]"
        );
    }

    #[test]
    fn folder_moves_rewrite_links_to_everything_inside() {
        let v = TestVault::new(&[
            ("Projects/Acme/Plan.md", ""),
            ("Projects/Acme/demo.page/index.html", "<html>"),
            ("Projects/Beta/Plan.md", ""),
            ("Home.md", "[[Projects/Acme/Plan]] [[demo.page]]"),
        ]);
        let (outcome, changes) = v.session.rename("Projects/Acme", "Archive/Acme").unwrap();
        assert_eq!(v.read("Home.md"), "[[Archive/Acme/Plan]] [[demo.page]]");
        assert_eq!(outcome.updated_links, 1);
        assert!(changes.iter().any(|c| c.kind == ChangeKind::Moved
            && c.path == "Archive/Acme/demo.page"
            && c.from.as_deref() == Some("Projects/Acme/demo.page")));
        assert!(v.exists("Archive/Acme/demo.page/index.html"));
    }

    #[test]
    fn undo_restores_files_and_links() {
        let v = TestVault::new(&[("Old.md", ""), ("A.md", "[[Old]]")]);
        v.session.rename("Old.md", "Sub/New.md").unwrap();
        assert_eq!(v.read("A.md"), "[[New]]");
        assert_eq!(
            v.session.undo_label().as_deref(),
            Some("Move Old.md to Sub")
        );

        let (label, _) = v.session.undo().unwrap();
        assert_eq!(label, "Move Old.md to Sub");
        assert_eq!(v.read("A.md"), "[[Old]]");
        assert!(v.exists("Old.md") && !v.exists("Sub/New.md"));
        assert_eq!(v.session.index().backlinks("Old.md").len(), 1);
        assert!(v.session.undo_label().is_none());
    }

    #[test]
    fn page_state_is_saved_and_follows_renames() {
        let v = TestVault::new(&[
            ("Pages/sketch.html", "<p>hi</p>"),
            ("Pages/x.page/index.html", "<p>x</p>"),
            ("Note.md", "text"),
        ]);
        let s = &v.session;
        assert_eq!(
            s.page_state("Pages/sketch.html").unwrap(),
            serde_json::Value::Null
        );
        s.set_page_state("Pages/sketch.html", &serde_json::json!({ "n": 1 }))
            .unwrap();
        s.set_page_state("Pages/x.page", &serde_json::json!({ "n": 2 }))
            .unwrap();
        assert!(v.exists(".groundwork/page-state/Pages/sketch.html.json"));
        assert!(v.exists("Pages/x.page/state.json"));
        assert!(matches!(
            s.set_page_state("Note.md", &serde_json::Value::Null),
            Err(CoreError::InvalidPath(_))
        ));
        assert!(matches!(
            s.page_state("Pages/missing.html"),
            Err(CoreError::NotFound(_))
        ));

        // A folder move carries the single-file page's state along; undo brings it back.
        s.rename("Pages", "Archive/Pages").unwrap();
        assert_eq!(
            s.page_state("Archive/Pages/sketch.html").unwrap(),
            serde_json::json!({ "n": 1 })
        );
        assert_eq!(
            s.page_state("Archive/Pages/x.page").unwrap(),
            serde_json::json!({ "n": 2 })
        );
        s.undo().unwrap();
        assert_eq!(
            s.page_state("Pages/sketch.html").unwrap(),
            serde_json::json!({ "n": 1 })
        );
    }

    #[test]
    fn new_pages_start_from_a_skeleton() {
        let v = TestVault::new(&[]);
        let (path, _) = v
            .session
            .create_from_link("Home.md", "Board & plans.html")
            .unwrap();
        assert_eq!(path, "Board & plans.html");
        let text = v.read(&path);
        assert!(text.starts_with("<!doctype html>"));
        assert!(text.contains("<title>Board &amp; plans</title>"));
        assert!(text.contains("color-scheme: light dark"));
    }

    #[test]
    fn undo_refuses_when_files_changed_since() {
        let v = TestVault::new(&[("Old.md", ""), ("A.md", "[[Old]]")]);
        v.session.rename("Old.md", "New.md").unwrap();
        fs::write(v.dir.path().join("A.md"), "[[New]] edited").unwrap();
        assert!(matches!(v.session.undo(), Err(CoreError::Conflict(_))));
        assert!(v.exists("New.md"));
    }

    #[test]
    fn rename_validates_targets() {
        let v = TestVault::new(&[("A.md", ""), ("B.md", ""), ("F/x.md", "")]);
        let err = |from: &str, to: &str| v.session.rename(from, to).unwrap_err();
        assert!(matches!(err("A.md", "B.md"), CoreError::AlreadyExists(_)));
        assert!(matches!(err("A.md", "../A.md"), CoreError::InvalidPath(_)));
        assert!(matches!(
            err("A.md", "Bad#Name.md"),
            CoreError::InvalidPath(_)
        ));
        assert!(matches!(
            err("A.md", ".hidden.md"),
            CoreError::InvalidPath(_)
        ));
        assert!(matches!(err("F", "F/Inner"), CoreError::InvalidPath(_)));
        assert!(matches!(err("Missing.md", "C.md"), CoreError::NotFound(_)));
    }

    #[test]
    fn case_only_rename() {
        let v = TestVault::new(&[("note.md", ""), ("A.md", "[[note]]")]);
        v.session.rename("note.md", "Note.md").unwrap();
        let names: Vec<String> = fs::read_dir(v.dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"Note.md".to_string()), "{names:?}");
        // Links are case-insensitive, so nothing needed rewriting.
        assert_eq!(v.read("A.md"), "[[note]]");
    }

    #[test]
    fn links_to_missing_notes_follow_obsidian_settings() {
        let daily = r#"{"folder": "Daily", "format": "YYYY-MM-DD"}"#;
        let v = TestVault::new(&[
            (".obsidian/daily-notes.json", daily),
            ("Projects/Acme/Acme.md", ""),
        ]);
        let p = |target| v.session.path_for_link("Projects/Acme/Acme.md", target);
        // Daily note names go to the daily folder, wherever the link is.
        assert_eq!(p("2026-11-02"), "Daily/2026-11-02.md");
        assert_eq!(p("2026-11-02.md"), "Daily/2026-11-02.md");
        // Not quite a daily name: the default location (vault root).
        assert_eq!(p("2026-11-02 Kickoff"), "2026-11-02 Kickoff.md");
        // Explicit folders are kept.
        assert_eq!(p("Notes/Idea"), "Notes/Idea.md");
        assert_eq!(p("Daily/2026-11-02"), "Daily/2026-11-02.md");
        // Names with dots are still notes; HTML names make pages.
        assert_eq!(p("Mr. Smith"), "Mr. Smith.md");
        assert_eq!(p("sketch.html"), "sketch.html");

        fs::create_dir_all(v.dir.path().join(".obsidian")).unwrap();
        fs::write(
            v.dir.path().join(".obsidian/app.json"),
            r#"{"newFileLocation": "current"}"#,
        )
        .unwrap();
        v.session.index.write().unwrap().reload_settings();
        assert_eq!(p("Idea"), "Projects/Acme/Idea.md");

        fs::write(
            v.dir.path().join(".obsidian/app.json"),
            r#"{"newFileLocation": "folder", "newFileFolderPath": "Inbox/"}"#,
        )
        .unwrap();
        v.session.index.write().unwrap().reload_settings();
        assert_eq!(p("Idea"), "Inbox/Idea.md");
        assert_eq!(p("2026-11-02"), "Daily/2026-11-02.md");
    }

    #[test]
    fn create_from_link_creates_once() {
        let v = TestVault::new(&[(".obsidian/daily-notes.json", r#"{"folder": "Daily"}"#)]);
        let (path, changes) = v.session.create_from_link("A.md", "2026-11-02").unwrap();
        assert_eq!(path, "Daily/2026-11-02.md");
        assert_eq!(changes.len(), 1);
        assert!(v.read(&path).starts_with("---\ncreated: "));
        let (again, changes) = v.session.create_from_link("A.md", "2026-11-02").unwrap();
        assert_eq!(again, path);
        assert!(changes.is_empty());
    }

    #[test]
    fn create_untitled_adds_created_property() {
        let v = TestVault::new(&[("Untitled.md", "")]);
        let (path, changes) = v.session.create_untitled("").unwrap();
        assert_eq!(path, "Untitled 1.md");
        assert_eq!(changes[0].kind, ChangeKind::Created);
        assert!(v.read(&path).starts_with("---\ncreated: 20"));
        let (nested, _) = v.session.create_untitled("New Folder").unwrap();
        assert_eq!(nested, "New Folder/Untitled.md");
    }

    #[test]
    fn write_reports_changes_once() {
        let v = TestVault::new(&[("A.md", "one")]);
        let (_, changes) = v.session.write_file("A.md", "two").unwrap();
        assert_eq!(changes.len(), 1);
        // The watcher then sees our own write: nothing new.
        assert!(v.session.apply_external(&["A.md".into()]).is_empty());
        fs::write(v.dir.path().join("A.md"), "three").unwrap();
        let changes = v.session.apply_external(&["A.md".into()]);
        assert_eq!(
            changes,
            [FileChange::new("A.md", ChangeKind::Modified, true)]
        );
    }

    #[test]
    fn link_mention_writes_a_link() {
        let v = TestVault::new(&[("Jane Doe.md", ""), ("N.md", "met jane doe and Jane Doe")]);
        v.session
            .link_mention("N.md", 4..12, "jane doe", "Jane Doe.md")
            .unwrap();
        assert_eq!(v.read("N.md"), "met [[Jane Doe|jane doe]] and Jane Doe");
        let at = v.read("N.md").rfind("Jane Doe").unwrap();
        v.session
            .link_mention("N.md", at..at + 8, "Jane Doe", "Jane Doe.md")
            .unwrap();
        assert_eq!(v.read("N.md"), "met [[Jane Doe|jane doe]] and [[Jane Doe]]");
    }

    #[test]
    fn toggle_task_stamps_completion() {
        let v = TestVault::new(&[("T.md", "- [ ] one ^b1\r\n- [x] two ✅ 2026-01-01\n")]);
        v.session.toggle_task("T.md", 0).unwrap();
        v.session.toggle_task("T.md", 1).unwrap();
        let today = Local::now().format("%Y-%m-%d").to_string();
        assert_eq!(
            v.read("T.md"),
            format!("- [x] one ✅ {today} ^b1\r\n- [ ] two\n")
        );
    }

    #[test]
    fn activity_is_logged_for_app_changes() {
        let v = TestVault::new(&[("A.md", "")]);
        v.session.rename("A.md", "B.md").unwrap();
        let dir = v.dir.path().join(".groundwork/activity");
        let machine = fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();
        let log = fs::read_dir(machine)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let text = fs::read_to_string(log).unwrap();
        assert!(
            text.contains(r#""kind":"moved","path":"B.md","from":"A.md","source":"app""#),
            "{text}"
        );
    }

    const DAILY_SETTINGS: (&str, &str) = (
        ".obsidian/daily-notes.json",
        r#"{"folder": "Daily", "template": "Templates/Daily"}"#,
    );

    #[test]
    fn creates_notes_from_templates() {
        let v = TestVault::new(&[(
            "Templates/Meeting.md",
            "---\ntags: [meeting]\n---\n# {{title}}\n\nWith {{prompt:Who}} on {{date:ddd D MMM}}\n\n{{cursor}}\n",
        )]);
        assert_eq!(v.session.templates(), ["Templates/Meeting.md"]);
        assert_eq!(
            v.session.template_prompts("Templates/Meeting.md").unwrap(),
            ["Who"]
        );
        let date = NaiveDate::from_ymd_opt(2026, 11, 3).unwrap();
        let (cursor, changes) = v
            .session
            .create_from_template(
                "Templates/Meeting.md",
                "Notes/Kickoff.md",
                Some(date),
                HashMap::from([("Who".into(), "Jane".into())]),
            )
            .unwrap();
        assert_eq!(changes.len(), 1);
        let text = v.read("Notes/Kickoff.md");
        let created = text.lines().nth(2).unwrap();
        assert!(created.starts_with("created: 20"), "{text}");
        assert_eq!(
            text.replace(&format!("{created}\n"), ""),
            "---\ntags: [meeting]\n---\n# Kickoff\n\nWith Jane on Tue 3 Nov\n\n\n"
        );
        assert_eq!(&text[cursor.unwrap()..], "\n");
        assert!(text[..cursor.unwrap()].ends_with("Nov\n\n"));
    }

    #[test]
    fn keeps_a_templates_own_created_and_adds_one_without_frontmatter() {
        let r = |text: &str, cursor| Rendered {
            text: text.into(),
            cursor,
        };
        let now = NaiveDate::from_ymd_opt(2026, 11, 3)
            .unwrap()
            .and_hms_opt(9, 5, 0)
            .unwrap();
        let own = "---\ncreated: 2020-01-01\n---\nx";
        assert_eq!(with_created(r(own, None), now).0, own);
        assert_eq!(
            with_created(r("# Hi\n", Some(5)), now),
            (
                "---\ncreated: 2026-11-03T09:05\n---\n# Hi\n".into(),
                Some(39)
            )
        );
        assert_eq!(
            with_created(r("---\n---\nBody", None), now).0,
            "---\ncreated: 2026-11-03T09:05\n---\nBody"
        );
    }

    #[test]
    fn daily_notes_use_the_daily_template_and_their_own_date() {
        let v = TestVault::new(&[
            DAILY_SETTINGS,
            (
                "Templates/Daily.md",
                "# {{date:dddd, MMMM D}}\n\n[[{{date-1d}}]] · [[{{date+1d}}]]\n",
            ),
        ]);
        let date = NaiveDate::from_ymd_opt(2026, 11, 2).unwrap();
        let (path, changes) = v.session.daily_note(date).unwrap();
        assert_eq!(path, "Daily/2026-11-02.md");
        assert_eq!(changes.len(), 1);
        assert!(
            v.read(&path)
                .ends_with("---\n# Monday, November 2\n\n[[2026-11-01]] · [[2026-11-03]]\n")
        );
        // Opening it again changes nothing.
        let (again, changes) = v.session.daily_note(date).unwrap();
        assert_eq!((again.as_str(), changes.len()), (path.as_str(), 0));

        // Following a link to a missing day uses the template, dated that day.
        let (path, _) = v
            .session
            .create_from_link("Daily/2026-11-02.md", "2026-11-03")
            .unwrap();
        assert_eq!(path, "Daily/2026-11-03.md");
        assert!(v.read(&path).contains("# Tuesday, November 3"));
        assert_eq!(
            v.session.note_date("Daily/2026-11-03.md"),
            NaiveDate::from_ymd_opt(2026, 11, 3).unwrap()
        );
    }

    #[test]
    fn daily_notes_without_a_template_are_plain() {
        let v = TestVault::new(&[(".obsidian/daily-notes.json", r#"{"folder": "Journal"}"#)]);
        let (path, _) = v
            .session
            .daily_note(NaiveDate::from_ymd_opt(2026, 1, 5).unwrap())
            .unwrap();
        assert_eq!(path, "Journal/2026-01-05.md");
        assert!(v.read(&path).starts_with("---\ncreated: "));
    }

    #[test]
    fn inserts_todos_under_the_heading() {
        let ins = |text: &str| insert_under_heading(text, "Todos", "- [ ] New");
        assert_eq!(
            ins("# Day\n\n## Todos\n\n- [ ] A\n  - sub\n- [x] B\n\n## Notes\n"),
            (
                "# Day\n\n## Todos\n\n- [ ] A\n  - sub\n- [x] B\n- [ ] New\n\n## Notes\n".into(),
                7
            )
        );
        assert_eq!(
            ins("## Todos\n\n```todos\nday\n```\n"),
            ("## Todos\n\n- [ ] New\n\n```todos\nday\n```\n".into(), 2)
        );
        assert_eq!(ins("## todos\n"), ("## todos\n\n- [ ] New\n".into(), 2));
        assert_eq!(
            ins("# Note\nText\n\n"),
            ("# Note\nText\n\n## Todos\n\n- [ ] New\n".into(), 5)
        );
        assert_eq!(ins(""), ("## Todos\n\n- [ ] New\n".into(), 2));
    }

    #[test]
    fn updates_and_adds_todos_by_id() {
        let v = TestVault::new(&[
            DAILY_SETTINGS,
            (
                "Templates/Daily.md",
                "# {{date}}\n\n## Todos\n\n```todos\nday\n```\n",
            ),
            ("Work.md", "# Work\n- [ ] Ship it 📅 2026-11-05\n"),
        ]);
        let todos = todos::all(&v.session.index(), &DailySettings::read(v.dir.path()));
        let id = todos[0].id.clone();
        v.session
            .update_task(
                &id,
                &TaskChange::Due {
                    date: Some("2026-11-09".into()),
                },
            )
            .unwrap();
        assert_eq!(v.read("Work.md"), "# Work\n- [ ] Ship it 📅 2026-11-09\n");
        // The text is unchanged, so the id still works.
        v.session
            .update_task(&id, &TaskChange::Priority { priority: 1 })
            .unwrap();
        v.session.update_task(&id, &TaskChange::Done).unwrap();
        assert!(
            v.read("Work.md")
                .starts_with("# Work\n- [x] Ship it 📅 2026-11-09 ⏫ ✅ 20")
        );
        // A stale id is refused rather than editing whatever is on that line now.
        fs::write(
            v.dir.path().join("Work.md"),
            "# Work\n- [ ] Something else\n",
        )
        .unwrap();
        v.session.apply_external(&["Work.md".into()]);
        assert!(matches!(
            v.session.update_task(&id, &TaskChange::Done),
            Err(CoreError::Conflict(_))
        ));

        // With no note given, todos go into today's daily note.
        let due = NaiveDate::from_ymd_opt(2026, 11, 6);
        let (id, _) = v.session.add_task(None, "Call Bob", due, 2).unwrap();
        let today = Local::now().format("%Y-%m-%d").to_string();
        let path = format!("Daily/{today}.md");
        assert_eq!(id.split(':').next(), Some(path.as_str()));
        assert_eq!(
            v.read(&path).split("## Todos").nth(1).unwrap(),
            format!("\n\n- [ ] Call Bob 🔼 📅 2026-11-06 ➕ {today}\n\n```todos\nday\n```\n")
        );
        v.session.update_task(&id, &TaskChange::Cancel).unwrap();
        assert!(v.read(&path).contains("- [-] Call Bob"));

        // Each change was logged with the task's text.
        let log = fs::read_dir(v.dir.path().join(".groundwork/activity"))
            .unwrap()
            .flat_map(|d| fs::read_dir(d.unwrap().path()).unwrap())
            .map(|f| fs::read_to_string(f.unwrap().path()).unwrap())
            .collect::<String>();
        for kind in ["taskRescheduled", "taskDone", "taskAdded", "taskCancelled"] {
            assert!(
                log.contains(&format!("\"kind\":\"{kind}\"")),
                "{kind} missing:\n{log}"
            );
        }
        assert!(log.contains("\"task\":\"Call Bob\""));
    }
}
