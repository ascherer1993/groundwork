//! In-memory index of every file in a vault: parsed notes, link resolution,
//! backlinks and unlinked mentions.
//!
//! Link resolution follows Obsidian (case-insensitive throughout):
//! 1. the path relative to the linking note's folder (`./` and `../` allowed),
//! 2. the path from the vault root,
//! 3. any file whose path ends with the link path. Ties go to a file in the
//!    linking note's folder, then the shallowest path, then alphabetical.
//!
//! `.md` may be omitted for notes; other files need their extension. Aliases
//! are not link targets (Obsidian doesn't resolve them either).

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use regex::Regex;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::parse::{self, Link, LinkKind, ParsedNote};
use crate::tree::{NodeKind, classify, is_hidden};
use crate::{CoreError, Result};

#[derive(Debug, Clone)]
pub struct FileEntry {
    pub path: String,
    pub kind: NodeKind,
    pub mtime: Option<SystemTime>,
    pub size: u64,
    /// Content hash, for notes only.
    pub hash: Option<String>,
    pub note: Option<ParsedNote>,
}

/// How new links are written, from `.obsidian/app.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum LinkFormat {
    #[default]
    Shortest,
    Relative,
    Absolute,
}

/// Obsidian's "Default location for new notes".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NewFileLocation {
    #[default]
    Root,
    /// The folder of the note being edited.
    Current,
    /// `LinkSettings::new_file_folder`.
    Folder,
}

/// Link and new-note preferences from `.obsidian/app.json`.
#[derive(Debug, Clone, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LinkSettings {
    pub format: LinkFormat,
    pub markdown_links: bool,
    pub new_file_location: NewFileLocation,
    pub new_file_folder: String,
}

/// Change detected by [`Index::upsert`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Upsert {
    Created,
    Modified,
    Unchanged,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileSummary {
    pub path: String,
    pub kind: NodeKind,
    /// What `[[...]]` matches: the note's file name without `.md`, or the full
    /// file name for anything else.
    pub title: String,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LinkRef {
    pub line: u32,
    #[ts(type = "{ start: number, end: number }")]
    pub range: std::ops::Range<usize>,
    pub embed: bool,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subpath: Option<String>,
    /// The line containing the link, trimmed.
    pub context: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Backlinks {
    pub source: String,
    pub links: Vec<LinkRef>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OutgoingLink {
    pub link: Link,
    /// Vault path the link resolves to; absent if unresolved.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Mention {
    pub source: String,
    pub line: u32,
    #[ts(type = "{ start: number, end: number }")]
    pub range: std::ops::Range<usize>,
    /// The matched text as written.
    pub text: String,
    pub context: String,
}

#[derive(Debug, Default)]
pub struct Index {
    root: PathBuf,
    files: BTreeMap<String, FileEntry>,
    /// Lowercased path → path.
    by_lower_path: HashMap<String, String>,
    /// Lowercased link name (note stem, or full file name) → paths.
    by_name: HashMap<String, Vec<String>>,
    settings: LinkSettings,
}

impl Index {
    pub fn build(root: &Path) -> Result<Self> {
        let mut index = Self {
            root: root.to_path_buf(),
            settings: read_link_settings(root),
            ..Default::default()
        };
        let mut paths = Vec::new();
        collect(root, "", &mut paths)?;
        for (path, kind) in paths {
            if let Some(entry) = index.load(&path, kind)? {
                index.insert(entry);
            }
        }
        Ok(index)
    }

    pub fn settings(&self) -> &LinkSettings {
        &self.settings
    }

    pub fn reload_settings(&mut self) {
        self.settings = read_link_settings(&self.root);
    }

    pub fn get(&self, path: &str) -> Option<&FileEntry> {
        self.files.get(path)
    }

    pub fn note(&self, path: &str) -> Option<&ParsedNote> {
        self.files.get(path).and_then(|f| f.note.as_ref())
    }

    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.files.keys().map(String::as_str)
    }

    /// Notes in path order.
    pub fn notes(&self) -> impl Iterator<Item = (&str, &ParsedNote)> {
        self.files
            .iter()
            .filter_map(|(p, f)| f.note.as_ref().map(|n| (p.as_str(), n)))
    }

    pub fn summaries(&self) -> Vec<FileSummary> {
        self.files
            .values()
            .map(|f| FileSummary {
                path: f.path.clone(),
                kind: f.kind,
                title: link_name(&f.path, f.kind).to_string(),
                aliases: f
                    .note
                    .as_ref()
                    .map(|n| n.aliases.clone())
                    .unwrap_or_default(),
            })
            .collect()
    }

    /// (Re)loads one path from disk. Folders are expanded to their contents;
    /// anything hidden or inside a `.page` bundle is ignored.
    pub fn upsert(&mut self, path: &str) -> Result<Vec<(String, Upsert)>> {
        if path.is_empty() || !self.is_indexable(path) {
            return Ok(Vec::new());
        }
        let full = self.root.join(path);
        let Ok(meta) = fs::metadata(&full) else {
            return Ok(Vec::new());
        };
        let name = path.rsplit('/').next().unwrap_or(path);
        let kind = classify(name, meta.is_dir());
        if kind == NodeKind::Folder {
            let mut paths = Vec::new();
            collect(&full, path, &mut paths)?;
            let mut changes = Vec::new();
            for (p, k) in paths {
                if let Some(change) = self.upsert_one(&p, k)? {
                    changes.push(change);
                }
            }
            return Ok(changes);
        }
        Ok(self.upsert_one(path, kind)?.into_iter().collect())
    }

    fn upsert_one(&mut self, path: &str, kind: NodeKind) -> Result<Option<(String, Upsert)>> {
        let Some(entry) = self.load(path, kind)? else {
            return Ok(None);
        };
        let change = match self.files.get(path) {
            None => Upsert::Created,
            Some(old) if old.hash.is_some() && old.hash == entry.hash => Upsert::Unchanged,
            Some(old)
                if old.hash.is_none() && old.size == entry.size && old.mtime == entry.mtime =>
            {
                Upsert::Unchanged
            }
            Some(_) => Upsert::Modified,
        };
        if change != Upsert::Unchanged {
            self.remove_entry(path);
            self.insert(entry);
        }
        Ok(Some((path.to_string(), change)))
    }

    /// Removes a path and, if it was a folder, everything under it.
    pub fn remove(&mut self, path: &str) -> Vec<String> {
        let prefix = format!("{path}/");
        let removed: Vec<String> = self
            .files
            .keys()
            .filter(|p| *p == path || p.starts_with(&prefix))
            .cloned()
            .collect();
        for p in &removed {
            self.remove_entry(p);
        }
        removed
    }

    /// Re-reads files whose size or mtime changed since they were indexed,
    /// and drops files that no longer exist. Used before rewriting links.
    pub fn refresh_stale(&mut self) -> Result<()> {
        let stale: Vec<(String, NodeKind, bool)> = self
            .files
            .values()
            .filter_map(|f| match fs::metadata(self.root.join(&f.path)) {
                Err(_) => Some((f.path.clone(), f.kind, false)),
                Ok(m) if m.len() != f.size || m.modified().ok() != f.mtime => {
                    Some((f.path.clone(), f.kind, true))
                }
                Ok(_) => None,
            })
            .collect();
        for (path, kind, exists) in stale {
            if exists {
                self.upsert_one(&path, kind)?;
            } else {
                self.remove_entry(&path);
            }
        }
        Ok(())
    }

    fn is_indexable(&self, path: &str) -> bool {
        let parts: Vec<&str> = path.split('/').collect();
        !parts.iter().any(|p| is_hidden(p))
            && !parts[..parts.len() - 1]
                .iter()
                .any(|p| p.to_ascii_lowercase().ends_with(".page"))
    }

    fn load(&self, path: &str, kind: NodeKind) -> Result<Option<FileEntry>> {
        let full = self.root.join(path);
        let Ok(meta) = fs::metadata(&full) else {
            return Ok(None);
        };
        let (hash, note) = if kind == NodeKind::Note {
            let bytes = fs::read(&full)?;
            let text = String::from_utf8_lossy(&bytes);
            (Some(hash(&bytes)), Some(parse::parse(&text)))
        } else {
            (None, None)
        };
        Ok(Some(FileEntry {
            path: path.to_string(),
            kind,
            mtime: meta.modified().ok(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            hash,
            note,
        }))
    }

    pub(crate) fn insert_entry(&mut self, entry: FileEntry) {
        self.insert(entry);
    }

    fn insert(&mut self, entry: FileEntry) {
        let path = entry.path.clone();
        self.by_lower_path.insert(path.to_lowercase(), path.clone());
        self.by_name
            .entry(link_name(&path, entry.kind).to_lowercase())
            .or_default()
            .push(path.clone());
        self.files.insert(path, entry);
    }

    fn remove_entry(&mut self, path: &str) {
        if let Some(entry) = self.files.remove(path) {
            self.by_lower_path.remove(&path.to_lowercase());
            let key = link_name(path, entry.kind).to_lowercase();
            if let Some(paths) = self.by_name.get_mut(&key) {
                paths.retain(|p| p != path);
                if paths.is_empty() {
                    self.by_name.remove(&key);
                }
            }
        }
    }

    // ---- Resolution ----------------------------------------------------

    /// Resolves a link path (no subpath) written in `source`.
    pub fn resolve(&self, linkpath: &str, source: &str) -> Option<String> {
        let lp = linkpath.trim().replace('\\', "/");
        if lp.is_empty() {
            return self.files.contains_key(source).then(|| source.to_string());
        }
        let lp = lp.trim_start_matches('/');
        let src_dir = parent(source);

        // 1. Relative to the linking note, 2. from the vault root.
        for base in [src_dir, ""] {
            if let Some(joined) = join_normalized(base, lp)
                && let Some(found) = self.lookup_exact(&joined)
            {
                return Some(found);
            }
        }

        // 3. Any file whose path ends with the link path.
        let lp_lower = lp.to_lowercase();
        let lp_lower = lp_lower.strip_suffix(".md").unwrap_or(&lp_lower);
        let name = lp_lower.rsplit('/').next().unwrap_or(lp_lower);
        let candidates = self.by_name.get(name)?;
        candidates
            .iter()
            .filter(|p| {
                let comparable = self.comparable(p);
                comparable == lp_lower || comparable.ends_with(&format!("/{lp_lower}"))
            })
            .min_by_key(|p| (parent(p) != src_dir, p.matches('/').count(), p.as_str()))
            .cloned()
    }

    pub fn resolve_link(&self, link: &Link, source: &str) -> Option<String> {
        self.resolve(&link.target, source)
    }

    /// Lowercased path, without `.md` for notes.
    fn comparable(&self, path: &str) -> String {
        let lower = path.to_lowercase();
        match self.files.get(path).map(|f| f.kind) {
            Some(NodeKind::Note) => lower.strip_suffix(".md").unwrap_or(&lower).to_string(),
            _ => lower,
        }
    }

    fn lookup_exact(&self, path: &str) -> Option<String> {
        let mut options = vec![path.to_string()];
        if !path.to_lowercase().ends_with(".md") {
            options.push(format!("{path}.md"));
        }
        for option in options {
            if self.files.contains_key(&option) {
                return Some(option);
            }
            if let Some(found) = self.by_lower_path.get(&option.to_lowercase()) {
                return Some(found.clone());
            }
        }
        None
    }

    // ---- Queries -------------------------------------------------------

    pub fn outgoing(&self, source: &str) -> Vec<OutgoingLink> {
        self.note(source)
            .map(|note| {
                note.links
                    .iter()
                    .map(|link| OutgoingLink {
                        link: link.clone(),
                        resolved: self.resolve_link(link, source),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Every note linking to `target`, with the line each link is on.
    pub fn backlinks(&self, target: &str) -> Vec<Backlinks> {
        let mut out = Vec::new();
        for (source, note) in self.notes() {
            let refs: Vec<&Link> = note
                .links
                .iter()
                .filter(|l| !(source == target && l.target.is_empty()))
                .filter(|l| self.resolve_link(l, source).as_deref() == Some(target))
                .collect();
            if refs.is_empty() {
                continue;
            }
            let text = self.read_text(source).unwrap_or_default();
            out.push(Backlinks {
                source: source.to_string(),
                links: refs
                    .into_iter()
                    .map(|l| LinkRef {
                        line: l.line,
                        range: l.range.clone(),
                        embed: l.embed,
                        subpath: l.subpath.clone(),
                        context: line_context(&text, l.range.start),
                    })
                    .collect(),
            });
        }
        out
    }

    /// Plain-text mentions of `target`'s title or aliases in other notes that
    /// aren't already links. Terms shorter than 3 characters are skipped.
    pub fn unlinked_mentions(&self, target: &str) -> Vec<Mention> {
        let Some(entry) = self.files.get(target) else {
            return Vec::new();
        };
        let mut terms = vec![link_name(target, entry.kind).to_string()];
        if let Some(note) = &entry.note {
            terms.extend(note.aliases.iter().cloned());
        }
        terms.retain(|t| t.chars().count() >= 3);
        if terms.is_empty() {
            return Vec::new();
        }
        terms.sort_by_key(|t| std::cmp::Reverse(t.len()));
        let alternation = terms
            .iter()
            .map(|t| regex::escape(t))
            .collect::<Vec<_>>()
            .join("|");
        let Ok(pattern) = Regex::new(&format!(
            r"(?i)(?:^|[^\p{{L}}\p{{N}}])({alternation})(?:$|[^\p{{L}}\p{{N}}])"
        )) else {
            return Vec::new();
        };

        let mut out = Vec::new();
        for (source, note) in self.notes() {
            if source == target {
                continue;
            }
            let Some(text) = self.read_text(source) else {
                continue;
            };
            let lines = parse::LineIndex::new(&text);
            let mut at = 0;
            while let Some(caps) = pattern.captures_at(&text, at) {
                let m = caps.get(1).unwrap();
                at = m.end();
                let range = m.range();
                if note
                    .excluded
                    .iter()
                    .any(|e| range.start < e.end && e.start < range.end)
                {
                    continue;
                }
                out.push(Mention {
                    source: source.to_string(),
                    line: lines.line_of(range.start),
                    text: m.as_str().to_string(),
                    context: line_context(&text, range.start),
                    range,
                });
            }
        }
        out
    }

    // ---- Writing links -------------------------------------------------

    /// The link path to write for `target` from `source`, following the
    /// vault's link format. Wikilinks drop `.md`; Markdown links keep it and
    /// are percent-encoded.
    pub fn link_path(&self, target: &str, source: &str, kind: LinkKind) -> String {
        let is_note = self.files.get(target).map(|f| f.kind) == Some(NodeKind::Note)
            || target.to_lowercase().ends_with(".md");
        let path = match self.settings.format {
            LinkFormat::Shortest => {
                let name = file_name(target);
                let key = link_name(
                    target,
                    if is_note {
                        NodeKind::Note
                    } else {
                        NodeKind::Asset
                    },
                );
                let unique = self
                    .by_name
                    .get(&key.to_lowercase())
                    .is_none_or(|paths| paths.len() <= 1 && paths.iter().all(|p| p == target));
                if unique {
                    name.to_string()
                } else {
                    target.to_string()
                }
            }
            LinkFormat::Relative => relative_path(parent(source), target),
            LinkFormat::Absolute => target.to_string(),
        };
        match kind {
            LinkKind::Wiki if is_note => path.strip_suffix(".md").unwrap_or(&path).to_string(),
            LinkKind::Wiki => path,
            LinkKind::Markdown => encode_markdown_path(&path),
        }
    }

    /// Formats a complete link to `target` in the vault's preferred style.
    pub fn format_link(
        &self,
        target: &str,
        source: &str,
        kind: LinkKind,
        subpath: Option<&str>,
        alias: Option<&str>,
        embed: bool,
    ) -> String {
        let path = self.link_path(target, source, kind);
        let bang = if embed { "!" } else { "" };
        match kind {
            LinkKind::Wiki => {
                let sub = subpath.map(|s| format!("#{s}")).unwrap_or_default();
                let alias = alias.map(|a| format!("|{a}")).unwrap_or_default();
                format!("{bang}[[{path}{sub}{alias}]]")
            }
            LinkKind::Markdown => {
                let sub = subpath
                    .map(|s| format!("#{}", encode_markdown_path(s)))
                    .unwrap_or_default();
                let text = alias.map_or_else(
                    || link_name(target, NodeKind::Note).to_string(),
                    str::to_string,
                );
                format!("{bang}[{text}]({path}{sub})")
            }
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn read_text(&self, path: &str) -> Option<String> {
        fs::read(self.root.join(path))
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    }
}

pub(crate) fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex()[..16].to_string()
}

/// The name a wikilink uses for a file: note stem, or full file name.
pub fn link_name(path: &str, kind: NodeKind) -> &str {
    let name = file_name(path);
    if kind == NodeKind::Note {
        name.strip_suffix(".md")
            .or_else(|| name.strip_suffix(".MD"))
            .unwrap_or(name)
    } else {
        name
    }
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub(crate) fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(p, _)| p)
}

/// Joins `base` and `rel`, resolving `.` and `..`. `None` if it escapes the root.
fn join_normalized(base: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = base.split('/').filter(|p| !p.is_empty()).collect();
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    Some(parts.join("/"))
}

fn relative_path(from_dir: &str, to: &str) -> String {
    let from: Vec<&str> = from_dir.split('/').filter(|p| !p.is_empty()).collect();
    let to_parts: Vec<&str> = to.split('/').collect();
    let common = from
        .iter()
        .zip(&to_parts)
        .take_while(|(a, b)| a == b)
        .count();
    let mut out: Vec<&str> = vec![".."; from.len() - common];
    out.extend(&to_parts[common..]);
    out.join("/")
}

fn encode_markdown_path(path: &str) -> String {
    const SET: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS
        .add(b' ')
        .add(b'(')
        .add(b')')
        .add(b'<')
        .add(b'>')
        .add(b'[')
        .add(b']')
        .add(b'%')
        .add(b'^');
    percent_encoding::utf8_percent_encode(path, SET).to_string()
}

fn line_context(text: &str, offset: usize) -> String {
    let start = text[..offset].rfind('\n').map_or(0, |i| i + 1);
    let end = text[offset..].find('\n').map_or(text.len(), |i| offset + i);
    let line = text[start..end].trim();
    if line.chars().count() > 240 {
        let truncated: String = line.chars().take(240).collect();
        format!("{truncated}…")
    } else {
        line.to_string()
    }
}

fn read_link_settings(root: &Path) -> LinkSettings {
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct AppJson {
        new_link_format: Option<String>,
        use_markdown_links: Option<bool>,
        new_file_location: Option<String>,
        new_file_folder_path: Option<String>,
    }
    let app: AppJson = fs::read(root.join(".obsidian/app.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    LinkSettings {
        format: match app.new_link_format.as_deref() {
            Some("relative") => LinkFormat::Relative,
            Some("absolute") => LinkFormat::Absolute,
            _ => LinkFormat::Shortest,
        },
        markdown_links: app.use_markdown_links.unwrap_or(false),
        new_file_location: match app.new_file_location.as_deref() {
            Some("current") => NewFileLocation::Current,
            Some("folder") => NewFileLocation::Folder,
            _ => NewFileLocation::Root,
        },
        new_file_folder: app
            .new_file_folder_path
            .unwrap_or_default()
            .trim_matches('/')
            .to_string(),
    }
}

/// Collects indexable files under `dir`: notes, pages, assets and `.page`
/// bundles (as single entries). Hidden entries are skipped.
fn collect(dir: &Path, rel: &str, out: &mut Vec<(String, NodeKind)>) -> Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(CoreError::Io(e)),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        let Ok(meta) = fs::metadata(entry.path()) else {
            continue;
        };
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        match classify(&name, meta.is_dir()) {
            NodeKind::Folder => collect(&entry.path(), &path, out)?,
            kind => out.push((path, kind)),
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/vault");

    fn fixture() -> Index {
        Index::build(Path::new(FIXTURE)).unwrap()
    }

    /// A temporary vault from `(path, contents)` pairs.
    pub(crate) fn temp_vault(files: &[(&str, &str)]) -> (tempfile::TempDir, Index) {
        let dir = tempfile::tempdir().unwrap();
        for (path, text) in files {
            let full = dir.path().join(path);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, text).unwrap();
        }
        let index = Index::build(dir.path()).unwrap();
        (dir, index)
    }

    #[test]
    fn indexes_files_but_not_hidden_or_bundle_internals() {
        let index = fixture();
        assert!(index.get("Welcome.md").is_some());
        assert_eq!(
            index
                .get("Projects/Acme/demos/login-flow.page")
                .unwrap()
                .kind,
            NodeKind::PageBundle
        );
        assert!(
            index
                .get("Projects/Acme/demos/login-flow.page/index.html")
                .is_none()
        );
        assert!(index.paths().all(|p| !p.contains(".obsidian")));
        assert!(index.paths().all(|p| !p.contains(".groundwork")));
    }

    #[test]
    fn resolves_like_obsidian() {
        let (_dir, index) = temp_vault(&[
            ("Root.md", ""),
            ("A/Note.md", ""),
            ("A/Sub/Deep.md", ""),
            ("B/Note.md", ""),
            ("B/Other.md", ""),
            ("C/pic.png", ""),
            ("Same Name.md", ""),
            ("Folder/Same Name.md", ""),
        ]);
        let r = |lp: &str, src: &str| index.resolve(lp, src);
        // Unique names resolve anywhere, case-insensitively, with or without .md.
        assert_eq!(r("Root", "A/Note.md").as_deref(), Some("Root.md"));
        assert_eq!(r("root.md", "A/Note.md").as_deref(), Some("Root.md"));
        assert_eq!(r("Deep", "B/Other.md").as_deref(), Some("A/Sub/Deep.md"));
        // Duplicate names prefer the linking note's folder.
        assert_eq!(r("Note", "B/Other.md").as_deref(), Some("B/Note.md"));
        assert_eq!(r("Note", "A/Sub/Deep.md").as_deref(), Some("A/Note.md"));
        // Explicit paths win.
        assert_eq!(r("B/Note", "A/Sub/Deep.md").as_deref(), Some("B/Note.md"));
        assert_eq!(r("../Note", "A/Sub/Deep.md").as_deref(), Some("A/Note.md"));
        assert_eq!(r("Sub/Deep", "Root.md").as_deref(), Some("A/Sub/Deep.md"));
        // Root beats deeper suffix matches.
        assert_eq!(
            r("Same Name", "B/Other.md").as_deref(),
            Some("Same Name.md")
        );
        assert_eq!(
            r("Folder/Same Name", "B/Other.md").as_deref(),
            Some("Folder/Same Name.md")
        );
        // Non-notes need their extension.
        assert_eq!(r("pic.png", "Root.md").as_deref(), Some("C/pic.png"));
        assert_eq!(r("pic", "Root.md"), None);
        // Same-note links and misses.
        assert_eq!(r("", "Root.md").as_deref(), Some("Root.md"));
        assert_eq!(r("Missing", "Root.md"), None);
        assert_eq!(r("../../../Root", "A/Note.md"), None);
    }

    #[test]
    fn fixture_backlinks() {
        let index = fixture();
        let sources: Vec<String> = index
            .backlinks("Contacts/Jane Doe.md")
            .into_iter()
            .map(|b| b.source)
            .collect();
        assert_eq!(
            sources,
            [
                "Daily/2026-11-03.md",
                "Projects/Acme/Acme.md",
                "Projects/Acme/Meetings/2026-11-02 Kickoff.md",
                "Projects/Acme/Work/TEAM-123 Fix login.md",
                "Welcome.md",
            ]
        );
        let ticket = index.backlinks("Projects/Acme/Work/TEAM-123 Fix login.md");
        let welcome = ticket.iter().find(|b| b.source == "Welcome.md").unwrap();
        assert_eq!(welcome.links[0].subpath.as_deref(), Some("Plan"));
        assert!(
            welcome.links[0]
                .context
                .contains("[[TEAM-123 Fix login#Plan]]")
        );
    }

    #[test]
    fn outgoing_marks_unresolved() {
        let index = fixture();
        let out = index.outgoing("Daily/2026-11-03.md");
        let yesterday = out.iter().find(|o| o.link.target == "2026-11-02").unwrap();
        assert!(yesterday.resolved.is_none());
        let jane = out.iter().find(|o| o.link.target == "Jane Doe").unwrap();
        assert_eq!(jane.resolved.as_deref(), Some("Contacts/Jane Doe.md"));
    }

    #[test]
    fn pages_and_bundles_are_link_targets() {
        let index = fixture();
        let out = index.outgoing("Projects/Acme/Acme.md");
        let resolved: Vec<_> = out.iter().filter_map(|o| o.resolved.as_deref()).collect();
        assert!(resolved.contains(&"Projects/Acme/demos/login-flow.page"));
        assert!(resolved.contains(&"Projects/Acme/demos/sketch.html"));
    }

    #[test]
    fn unlinked_mentions_skip_links_and_code() {
        let (_dir, index) = temp_vault(&[
            ("Jane Doe.md", "---\naliases: [JD]\n---\n"),
            (
                "Notes.md",
                "Talked to jane doe today.\n[[Jane Doe]] again.\n`Jane Doe` in code.\nJane Doers is a different word.",
            ),
        ]);
        let mentions = index.unlinked_mentions("Jane Doe.md");
        let found: Vec<_> = mentions.iter().map(|m| (m.line, m.text.as_str())).collect();
        assert_eq!(found, [(0, "jane doe")]);
    }

    #[test]
    fn link_paths_follow_settings() {
        let (_dir, mut index) = temp_vault(&[
            ("A/Unique Note.md", ""),
            ("A/Dup.md", ""),
            ("B/Dup.md", ""),
            ("C/pic.png", ""),
        ]);
        let w = LinkKind::Wiki;
        assert_eq!(
            index.link_path("A/Unique Note.md", "B/Dup.md", w),
            "Unique Note"
        );
        assert_eq!(index.link_path("A/Dup.md", "B/Dup.md", w), "A/Dup");
        assert_eq!(index.link_path("C/pic.png", "B/Dup.md", w), "pic.png");
        assert_eq!(
            index.link_path("A/Unique Note.md", "B/Dup.md", LinkKind::Markdown),
            "Unique%20Note.md"
        );
        index.settings.format = LinkFormat::Relative;
        assert_eq!(
            index.link_path("A/Unique Note.md", "B/Dup.md", w),
            "../A/Unique Note"
        );
        index.settings.format = LinkFormat::Absolute;
        assert_eq!(
            index.link_path("A/Unique Note.md", "B/Dup.md", w),
            "A/Unique Note"
        );
    }

    #[test]
    fn upsert_and_remove_track_changes() {
        let (dir, mut index) = temp_vault(&[("A.md", "one")]);
        fs::write(dir.path().join("A.md"), "two [[B]]").unwrap();
        fs::write(dir.path().join("B.md"), "").unwrap();
        assert_eq!(
            index.upsert("A.md").unwrap(),
            [("A.md".into(), Upsert::Modified)]
        );
        assert_eq!(
            index.upsert("B.md").unwrap(),
            [("B.md".into(), Upsert::Created)]
        );
        assert_eq!(
            index.upsert("B.md").unwrap(),
            [("B.md".into(), Upsert::Unchanged)]
        );
        assert_eq!(index.backlinks("B.md").len(), 1);
        assert_eq!(index.remove("B.md"), ["B.md"]);
        assert!(index.resolve("B", "A.md").is_none());
    }
}
