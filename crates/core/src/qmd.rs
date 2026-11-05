//! Smart search through qmd (PLAN §5.9): the vault is a qmd collection,
//! kept up to date as files change, searched by meaning (`qmd query`:
//! keywords, vectors and reranking). qmd is the user's own install, with
//! its index in `~/.cache/qmd`; what Groundwork keeps (the collection's
//! name, whether to update it) is machine-local, in the vault's data folder.
//!
//! qmd is a Node script, and an app opened from the Finder has a bare PATH,
//! so it runs through the user's login shell, as their terminals would.
//! `GROUNDWORK_QMD` names a qmd to run directly instead (tests use a fake).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::config::slugify;
use crate::index::Index;
use crate::{CoreError, Result, Session};

/// How long after the last change the index is brought up to date.
const SETTLE: Duration = Duration::from_secs(20);

/// What Groundwork remembers about the vault's collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct State {
    collection: Option<String>,
    auto_update: bool,
    last_update: Option<String>,
    last_error: Option<String>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            collection: None,
            auto_update: true,
            last_update: None,
            last_error: None,
        }
    }
}

/// Whether smart search is ready, for Settings and the search panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QmdStatus {
    /// qmd runs on this machine.
    pub installed: bool,
    /// The vault's qmd collection, once set up.
    pub collection: Option<String>,
    /// Updated as files change.
    pub auto_update: bool,
    /// Bringing the index up to date right now.
    pub updating: bool,
    /// When it was last brought up to date (local time, `YYYY-MM-DD HH:MM`).
    pub last_update: Option<String>,
    /// What went wrong last time, if it did.
    pub last_error: Option<String>,
}

/// A note found by meaning.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SmartResult {
    pub path: String,
    pub title: String,
    /// qmd's relevance, 0 to 1.
    pub score: f64,
    /// The passage that matched, when qmd gives one.
    pub snippet: Option<String>,
}

/// The vault's qmd collection.
#[derive(Debug, Clone)]
pub struct Qmd {
    root: PathBuf,
    state_file: PathBuf,
    name: String,
}

impl Session {
    pub fn qmd(&self) -> Qmd {
        let root = self.vault().root().to_path_buf();
        let base = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        Qmd {
            name: format!("groundwork-{}", slugify(&base)),
            state_file: self.state_dir().join("qmd.json"),
            root,
        }
    }

    /// Searches by meaning. Fails if smart search isn't set up.
    pub fn smart_search(&self, query: &str, limit: usize) -> Result<Vec<SmartResult>> {
        let found = self.qmd().query(query, limit)?;
        let index = self.index();
        Ok(found
            .into_iter()
            .filter_map(|(file, score, snippet)| {
                let path = vault_path(&index, &file)?;
                Some(SmartResult {
                    title: crate::index::link_name(&path, crate::NodeKind::Note).to_string(),
                    path,
                    score,
                    snippet,
                })
            })
            .collect())
    }
}

fn run(args: &[&str]) -> Result<String> {
    let mut cmd = match std::env::var_os("GROUNDWORK_QMD") {
        Some(qmd) => Command::new(qmd),
        None => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let mut c = Command::new(shell);
            c.args(["-l", "-c", "qmd \"$@\"", "qmd"]);
            c
        }
    };
    let out = cmd
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| CoreError::Qmd(format!("couldn't run qmd: {e}")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("qmd failed");
        return Err(CoreError::Qmd(format!("qmd {}: {}", args[0], line.trim())));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Whether qmd runs here.
pub fn installed() -> bool {
    match std::env::var_os("GROUNDWORK_QMD") {
        Some(qmd) => Path::new(&qmd).is_file(),
        None => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            Command::new(shell)
                .args(["-l", "-c", "command -v qmd"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        }
    }
}

/// qmd's results' files are `qmd://<collection>/<path>`, or absolute with
/// `--full-path`. qmd may change a path's case and punctuation, so failing
/// an exact match, the note whose path reads the same that way.
fn vault_path(index: &Index, file: &str) -> Option<String> {
    let rel = match file.strip_prefix("qmd://") {
        Some(rest) => rest.split_once('/')?.1.to_string(),
        None => {
            let root = index.root().to_string_lossy();
            file.strip_prefix(root.as_ref())?
                .trim_start_matches('/')
                .to_string()
        }
    };
    if index.note(&rel).is_some() {
        return Some(rel);
    }
    let loose = |p: &str| -> String {
        p.to_lowercase()
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '/' || c == '.' {
                    c
                } else {
                    '-'
                }
            })
            .collect::<String>()
            .split('-')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-")
    };
    let want = loose(&rel);
    index
        .notes()
        .map(|(p, _)| p)
        .find(|p| loose(p) == want)
        .map(str::to_string)
}

impl Qmd {
    fn state(&self) -> State {
        std::fs::read_to_string(&self.state_file)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn save(&self, state: &State) -> Result<()> {
        if let Some(dir) = self.state_file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&self.state_file, serde_json::to_string_pretty(state)?)?;
        Ok(())
    }

    /// The collection, if it's set up.
    pub fn collection(&self) -> Option<String> {
        self.state().collection
    }

    pub fn status(&self, updating: bool) -> QmdStatus {
        let state = self.state();
        QmdStatus {
            installed: installed(),
            collection: state.collection,
            auto_update: state.auto_update,
            updating,
            last_update: state.last_update,
            last_error: state.last_error,
        }
    }

    /// Makes the vault a qmd collection (its notes, `**/*.md`), unless it
    /// is one already. `refresh` then indexes it.
    pub fn setup(&self) -> Result<String> {
        if !installed() {
            return Err(CoreError::Qmd(
                "qmd isn't installed: npm install -g @tobilu/qmd".into(),
            ));
        }
        let root = self.root.display().to_string();
        if run(&["collection", "show", &self.name]).is_err() {
            run(&[
                "collection",
                "add",
                &root,
                "--name",
                &self.name,
                "--mask",
                "**/*.md",
            ])?;
            let about = format!(
                "{}: the user's notes (Groundwork, Obsidian-compatible Markdown)",
                self.root
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            );
            // Context helps qmd rank; without it, search still works.
            let _ = run(&["context", "add", &format!("qmd://{}", self.name), &about]);
        }
        let mut state = self.state();
        state.collection = Some(self.name.clone());
        state.last_error = None;
        self.save(&state)?;
        Ok(self.name.clone())
    }

    /// Brings the index up to date: new and changed notes, then their
    /// embeddings (the first time, qmd downloads its model).
    pub fn refresh(&self) -> Result<()> {
        let mut state = self.state();
        if state.collection.is_none() {
            return Err(not_set_up());
        }
        let result = run(&["update"]).and_then(|_| run(&["embed"]));
        match &result {
            Ok(_) => {
                state.last_update = Some(Local::now().format("%Y-%m-%d %H:%M").to_string());
                state.last_error = None;
            }
            Err(e) => state.last_error = Some(e.to_string()),
        }
        self.save(&state)?;
        result.map(|_| ())
    }

    /// Takes the vault out of qmd.
    pub fn remove(&self) -> Result<()> {
        let mut state = self.state();
        if let Some(name) = state.collection.take() {
            run(&["collection", "remove", &name])?;
        }
        state.last_update = None;
        state.last_error = None;
        self.save(&state)
    }

    pub fn set_auto_update(&self, on: bool) -> Result<()> {
        let mut state = self.state();
        state.auto_update = on;
        self.save(&state)
    }

    /// `(file, score, snippet)` for each hit, best first.
    fn query(&self, query: &str, limit: usize) -> Result<Vec<(String, f64, Option<String>)>> {
        let name = self.collection().ok_or_else(not_set_up)?;
        let n = limit.to_string();
        let out = run(&["query", "--json", "-n", &n, "-c", &name, query])?;
        let start = out.find('[').unwrap_or(0);
        let hits: Vec<Value> = serde_json::from_str(out[start..].trim())
            .map_err(|e| CoreError::Qmd(format!("qmd's answer wasn't readable: {e}")))?;
        Ok(hits
            .iter()
            .filter_map(|h| {
                let file = h.get("file")?.as_str()?.to_string();
                let score = h.get("score").and_then(Value::as_f64).unwrap_or(0.0);
                let snippet = h
                    .get("snippet")
                    .and_then(Value::as_str)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                Some((file, score, snippet))
            })
            .collect())
    }
}

fn not_set_up() -> CoreError {
    CoreError::Qmd(
        "smart search isn't set up: run `groundwork qmd setup`, or turn it on in Settings › Search"
            .into(),
    )
}

/// Keeps the collection up to date in the background: after files change
/// (once they've settled), or at once when asked.
pub struct Updater {
    tx: Mutex<mpsc::Sender<bool>>,
    busy: Arc<AtomicBool>,
}

impl Updater {
    pub fn start(qmd: Qmd) -> Self {
        let (tx, rx) = mpsc::channel::<bool>();
        let busy = Arc::new(AtomicBool::new(false));
        let flag = busy.clone();
        std::thread::spawn(move || {
            let mut due: Option<Instant> = None;
            loop {
                let wait = due.map_or(Duration::from_secs(3600), |d| {
                    d.saturating_duration_since(Instant::now())
                });
                match rx.recv_timeout(wait) {
                    // `true`: now; `false`: a change, so after it settles.
                    Ok(true) => due = Some(Instant::now()),
                    Ok(false) => {
                        let state = qmd.state();
                        if state.collection.is_some() && state.auto_update {
                            due = Some(Instant::now() + SETTLE);
                        }
                        continue;
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                if due.is_some_and(|d| d <= Instant::now()) {
                    due = None;
                    flag.store(true, Ordering::SeqCst);
                    let _ = qmd.refresh();
                    flag.store(false, Ordering::SeqCst);
                }
            }
        });
        Self {
            tx: Mutex::new(tx),
            busy,
        }
    }

    /// Files changed.
    pub fn changed(&self) {
        let _ = self.tx.lock().unwrap().send(false);
    }

    /// Update now. It counts as updating from here, so a status asked for
    /// straight after says so.
    pub fn refresh(&self) {
        self.busy.store(true, Ordering::SeqCst);
        let _ = self.tx.lock().unwrap().send(true);
    }

    pub fn busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::test_vault::session;

    /// Tests that run qmd take turns: it's named by an environment variable.
    static FAKE: Mutex<()> = Mutex::new(());

    /// Points qmd at the fake one (`fixtures/bin/qmd`, which keeps its
    /// state next to itself) copied into `dir`, until the guard drops.
    pub fn fake(dir: &Path) -> std::sync::MutexGuard<'static, ()> {
        let guard = FAKE.lock().unwrap_or_else(|e| e.into_inner());
        let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/bin/qmd");
        let copy = dir.join("qmd-bin/qmd");
        std::fs::create_dir_all(copy.parent().unwrap()).unwrap();
        std::fs::copy(fake, &copy).unwrap();
        // SAFETY: tests that use qmd all point it at the same fake.
        unsafe { std::env::set_var("GROUNDWORK_QMD", &copy) };
        guard
    }

    #[test]
    fn set_up_searched_and_taken_out() {
        let (dir, s) = session();
        let _qmd = fake(dir.path());
        let qmd = s.qmd();
        assert_eq!(qmd.status(false).collection, None);
        assert!(
            s.smart_search("vendor", 5)
                .unwrap_err()
                .to_string()
                .contains("isn't set up")
        );

        assert_eq!(qmd.setup().unwrap(), "groundwork-vault");
        qmd.refresh().unwrap();
        let status = qmd.status(false);
        assert!(status.installed && status.auto_update && status.last_update.is_some());

        let found = s.smart_search("contract terms", 5).unwrap();
        assert_eq!(found[0].path, "Events/2026-11-04 Vendor call.md");
        assert_eq!(found[0].title, "2026-11-04 Vendor call");
        assert!(
            found[0]
                .snippet
                .as_deref()
                .unwrap()
                .contains("contract terms")
        );

        qmd.remove().unwrap();
        assert_eq!(qmd.status(false).collection, None);
    }

    #[test]
    fn the_updater_updates_when_asked() {
        let (dir, s) = session();
        let _qmd = fake(dir.path());
        let qmd = s.qmd();
        qmd.setup().unwrap();
        let updater = Updater::start(qmd.clone());
        // A change waits for things to settle; asking doesn't.
        updater.changed();
        updater.refresh();
        assert!(updater.busy());
        let start = Instant::now();
        while updater.busy() && start.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!updater.busy());
        assert!(qmd.status(false).last_update.is_some());
        let calls = std::fs::read_to_string(dir.path().join("qmd-bin/calls")).unwrap();
        assert!(calls.contains("update\nembed\n"), "{calls}");
    }

    #[test]
    fn qmds_paths_are_matched_to_notes() {
        let (_dir, s) = session();
        let index = s.index();
        let jane = "Contacts/Jane Doe.md";
        assert_eq!(
            vault_path(&index, "qmd://notes/Contacts/Jane Doe.md").as_deref(),
            Some(jane)
        );
        assert_eq!(
            vault_path(&index, "qmd://notes/contacts/jane-doe.md").as_deref(),
            Some(jane)
        );
        let abs = format!("{}/{jane}", index.root().display());
        assert_eq!(vault_path(&index, &abs).as_deref(), Some(jane));
        assert_eq!(vault_path(&index, "qmd://notes/Nope.md"), None);
    }
}
