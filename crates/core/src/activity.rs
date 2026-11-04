//! Append-only activity log: `.groundwork/activity/<machine-id>/YYYY-MM.jsonl`.
//!
//! One folder per machine, so syncing a vault never produces conflicting
//! writes to the same file. Edits are debounced per file and source so a burst
//! of autosaves becomes one `modified` entry.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::Local;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::Result;

/// Edits to the same file from the same source within this window are logged once.
const MODIFIED_DEBOUNCE: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ActivitySource {
    /// Made through the Groundwork UI.
    App,
    /// Made through the `groundwork` CLI.
    Cli,
    /// Seen by the file watcher while Groundwork was running (Obsidian, an editor, git…).
    External,
    /// Found at startup: the file changed while Groundwork wasn't running.
    Detected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ActivityKind {
    Created,
    Modified,
    Moved,
    Deleted,
    /// A task was added (or first given a `➕` stamp).
    TaskAdded,
    TaskDone,
    TaskCancelled,
    /// A done or cancelled task was opened again.
    TaskReopened,
    /// A task's due date changed; `due` holds the new one.
    TaskRescheduled,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ActivityEvent {
    /// Local time, RFC 3339.
    pub ts: String,
    pub kind: ActivityKind,
    pub path: String,
    /// Previous path, for moves.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub from: Option<String>,
    pub source: ActivitySource,
    /// The task's text, for task events.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub task: Option<String>,
    /// The new due date, for `taskRescheduled`.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub due: Option<String>,
}

pub struct ActivityLog {
    dir: PathBuf,
    last_modified: Mutex<HashMap<(String, ActivitySource), Instant>>,
}

impl ActivityLog {
    pub fn new(vault_root: &Path, machine_id: &str) -> Self {
        Self {
            dir: vault_root.join(".groundwork/activity").join(machine_id),
            last_modified: Mutex::new(HashMap::new()),
        }
    }

    pub fn record(
        &self,
        kind: ActivityKind,
        path: &str,
        from: Option<&str>,
        source: ActivitySource,
    ) {
        if kind == ActivityKind::Modified {
            let mut last = self.last_modified.lock().unwrap();
            let key = (path.to_string(), source);
            if last
                .get(&key)
                .is_some_and(|t| t.elapsed() < MODIFIED_DEBOUNCE)
            {
                return;
            }
            last.insert(key, Instant::now());
        }
        let event = ActivityEvent {
            ts: Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
            kind,
            path: path.to_string(),
            from: from.map(str::to_string),
            source,
            task: None,
            due: None,
        };
        // The log is best-effort: a failed write must never fail the user's action.
        if let Err(e) = self.append(&event) {
            eprintln!("groundwork: could not write activity log: {e}");
        }
    }

    /// Records something that happened to a task in `path`.
    pub fn record_task(
        &self,
        kind: ActivityKind,
        path: &str,
        task: &str,
        due: Option<&str>,
        source: ActivitySource,
    ) {
        let event = ActivityEvent {
            ts: Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
            kind,
            path: path.to_string(),
            from: None,
            source,
            task: Some(task.to_string()),
            due: due.map(str::to_string),
        };
        if let Err(e) = self.append(&event) {
            eprintln!("groundwork: could not write activity log: {e}");
        }
    }

    fn append(&self, event: &ActivityEvent) -> Result<()> {
        fs::create_dir_all(&self.dir)?;
        let file = self
            .dir
            .join(format!("{}.jsonl", Local::now().format("%Y-%m")));
        let mut f = OpenOptions::new().create(true).append(true).open(file)?;
        writeln!(f, "{}", serde_json::to_string(event)?)?;
        Ok(())
    }
}

/// Every logged event in the vault, from all machines, oldest first.
pub fn read_events(vault_root: &Path) -> Vec<ActivityEvent> {
    let mut events: Vec<ActivityEvent> = fs::read_dir(vault_root.join(".groundwork/activity"))
        .into_iter()
        .flatten()
        .flatten()
        .flat_map(|machine| fs::read_dir(machine.path()).into_iter().flatten().flatten())
        .filter(|f| f.path().extension().is_some_and(|e| e == "jsonl"))
        .filter_map(|f| fs::read_to_string(f.path()).ok())
        .flat_map(|text| {
            text.lines()
                .filter_map(|l| serde_json::from_str::<ActivityEvent>(l).ok())
                .collect::<Vec<_>>()
        })
        .collect();
    // RFC 3339 with offsets: compare as instants, not strings.
    events.sort_by_key(|e| chrono::DateTime::parse_from_rfc3339(&e.ts).ok());
    events
}

/// A stable id for this machine, e.g. `aarons-macbook-3f2a`, stored in the
/// app data dir.
pub fn machine_id(data_dir: &Path) -> String {
    #[derive(Serialize, Deserialize)]
    struct Machine {
        id: String,
    }
    let file = data_dir.join("machine.json");
    if let Some(m) = fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice::<Machine>(&b).ok())
    {
        return m.id;
    }
    let host = gethostname::gethostname().to_string_lossy().to_lowercase();
    let host = host.strip_suffix(".local").unwrap_or(&host);
    let slug: String = host
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let suffix =
        &blake3::hash(format!("{host}{:?}", std::time::SystemTime::now()).as_bytes()).to_hex()[..4];
    let id = format!(
        "{}-{suffix}",
        if slug.is_empty() { "machine" } else { &slug }
    );
    let _ = fs::create_dir_all(data_dir);
    let _ = fs::write(
        &file,
        serde_json::to_vec_pretty(&Machine { id: id.clone() }).unwrap_or_default(),
    );
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_events(dir: &Path) -> Vec<ActivityEvent> {
        let mut out = Vec::new();
        for entry in fs::read_dir(dir).unwrap() {
            let text = fs::read_to_string(entry.unwrap().path()).unwrap();
            out.extend(text.lines().map(|l| serde_json::from_str(l).unwrap()));
        }
        out
    }

    #[test]
    fn records_and_debounces_modifications() {
        let vault = tempfile::tempdir().unwrap();
        let log = ActivityLog::new(vault.path(), "test-machine");
        log.record(ActivityKind::Created, "A.md", None, ActivitySource::App);
        log.record(ActivityKind::Modified, "A.md", None, ActivitySource::App);
        log.record(ActivityKind::Modified, "A.md", None, ActivitySource::App);
        log.record(
            ActivityKind::Modified,
            "A.md",
            None,
            ActivitySource::External,
        );
        log.record(
            ActivityKind::Moved,
            "B.md",
            Some("A.md"),
            ActivitySource::App,
        );

        let events = read_events(&vault.path().join(".groundwork/activity/test-machine"));
        let kinds: Vec<_> = events.iter().map(|e| (e.kind, e.source)).collect();
        assert_eq!(
            kinds,
            [
                (ActivityKind::Created, ActivitySource::App),
                (ActivityKind::Modified, ActivitySource::App),
                (ActivityKind::Modified, ActivitySource::External),
                (ActivityKind::Moved, ActivitySource::App),
            ]
        );
        assert_eq!(events[3].from.as_deref(), Some("A.md"));
    }

    #[test]
    fn machine_id_is_stable() {
        let data = tempfile::tempdir().unwrap();
        let first = machine_id(data.path());
        assert_eq!(machine_id(data.path()), first);
        assert!(first.len() > 5);
    }
}
