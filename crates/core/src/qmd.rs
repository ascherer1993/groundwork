//! Smart search through qmd (PLAN §5.9): the vault is a qmd collection,
//! kept up to date as files change, searched by meaning (`qmd query`:
//! keywords, vectors and reranking). qmd is the user's own install, with
//! its index in `~/.cache/qmd`; what Groundwork keeps (the collection's
//! name, whether to update it) is machine-local, in the vault's data folder.
//!
//! qmd is a Node script, and an app opened from the Finder has a bare PATH,
//! so it's looked for as the user's shells would find it, then where Node
//! tools are usually installed (each nvm version's, Homebrew's…), and run
//! with its own folder first on the PATH, so it gets the Node it was
//! installed with. `GROUNDWORK_QMD` names the qmd to run (tests use a fake).

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::config::slugify;
use crate::index::Index;
use crate::{CoreError, Result, Session};

/// How long notes must be quiet before the index is brought up to date.
/// The editor saves as you type, so this waits out a writing session's pauses.
const SETTLE: Duration = Duration::from_secs(2 * 60);
/// The least time between updates made for changes. Plain search reads the
/// files live, so smart search can be this far behind; Update now isn't held back.
const GAP: Duration = Duration::from_secs(10 * 60);

/// What Groundwork remembers about the vault's collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct State {
    collection: Option<String>,
    auto_update: bool,
    last_update: Option<String>,
    last_error: Option<String>,
    /// qmd's models are downloaded (`qmd pull`, the first time it updates).
    models: bool,
}

impl Default for State {
    fn default() -> Self {
        Self {
            collection: None,
            auto_update: true,
            last_update: None,
            last_error: None,
            models: false,
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
    /// Where it is.
    pub path: Option<String>,
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
    /// Where in the note it matched (zero-based).
    pub line: Option<u32>,
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
            .filter_map(|hit| {
                let path = vault_path(&index, &hit.file)?;
                Some(SmartResult {
                    title: crate::index::link_name(&path, crate::NodeKind::Note).to_string(),
                    path,
                    score: hit.score,
                    snippet: hit.snippet,
                    line: hit.line,
                })
            })
            .collect())
    }
}

/// Where qmd is, once found.
static FOUND: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

/// Finds qmd: `GROUNDWORK_QMD`; else where it was last found (remembered in
/// the data folder, since looking takes the shells a second or two); else
/// the login shell's PATH, the folders Node tools are usually installed
/// in, and the interactive shell's PATH.
pub fn locate() -> Option<PathBuf> {
    if let Some(qmd) = std::env::var_os("GROUNDWORK_QMD") {
        let qmd = PathBuf::from(qmd);
        return qmd.is_file().then_some(qmd);
    }
    let found = FOUND.get_or_init(|| Mutex::new(None));
    let mut found = found.lock().unwrap();
    if found.as_ref().is_none_or(|p| !p.is_file()) {
        let remembered = crate::data_dir().join("qmd-path");
        *found = std::fs::read_to_string(&remembered)
            .ok()
            .map(|p| PathBuf::from(p.trim()))
            .filter(|p| p.is_file())
            .or_else(|| {
                let path = from_shell(&["-l"])
                    .or_else(installed_somewhere)
                    .or_else(|| from_shell(&["-i", "-l"]))?;
                let _ = std::fs::create_dir_all(crate::data_dir());
                let _ = std::fs::write(&remembered, path.display().to_string());
                Some(path)
            });
    }
    found.clone()
}

/// `command -v qmd` in the user's shell (`-i` also reads their `.zshrc`,
/// where nvm is usually set up).
fn from_shell(flags: &[&str]) -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = Command::new(shell)
        .args(flags)
        .args(["-c", "command -v qmd"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let path = PathBuf::from(text.lines().rev().find(|l| l.starts_with('/'))?.trim());
    path.is_file().then_some(path)
}

/// The usual places: each nvm and fnm Node (newest first), Volta, Bun,
/// Homebrew, npm's global folder.
fn installed_somewhere() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let versions = |dir: PathBuf, bin: &str| -> Vec<PathBuf> {
        let mut found: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let version = name
                    .trim_start_matches('v')
                    .split('.')
                    .map(|n| n.parse().unwrap_or(0))
                    .collect();
                (version, e.path().join(bin))
            })
            .collect();
        found.sort_by(|a, b| b.0.cmp(&a.0));
        found.into_iter().map(|(_, p)| p).collect()
    };
    let mut candidates = versions(home.join(".nvm/versions/node"), "bin/qmd");
    candidates.extend(versions(
        home.join(".local/share/fnm/node-versions"),
        "installation/bin/qmd",
    ));
    candidates.extend([
        home.join(".volta/bin/qmd"),
        home.join(".bun/bin/qmd"),
        PathBuf::from("/opt/homebrew/bin/qmd"),
        PathBuf::from("/usr/local/bin/qmd"),
        home.join(".npm-global/bin/qmd"),
    ]);
    candidates.into_iter().find(|p| p.is_file())
}

fn run(args: &[&str]) -> Result<String> {
    let qmd = locate().ok_or_else(not_installed)?;
    let mut path = std::ffi::OsString::new();
    if let Some(dir) = qmd.parent() {
        path.push(dir);
        path.push(":");
    }
    path.push(std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()));
    let out = Command::new(&qmd)
        .args(args)
        .env("PATH", path)
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

fn not_installed() -> CoreError {
    CoreError::Qmd("qmd isn't installed: npm install -g @tobilu/qmd".into())
}

/// qmd's results' files are `qmd://<collection>/<path>` (plus `?index=…`
/// from a named index), or absolute with `--full-path`. qmd may change a
/// path's case and punctuation, so failing an exact match, the note whose
/// path reads the same that way.
fn vault_path(index: &Index, file: &str) -> Option<String> {
    let file = file.split_once('?').map_or(file, |(f, _)| f);
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
        let path = locate();
        QmdStatus {
            installed: path.is_some(),
            path: path.map(|p| p.display().to_string()),
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
        locate().ok_or_else(not_installed)?;
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
    /// embeddings. The first time, it downloads qmd's models (about 2 GB),
    /// so the first search needn't.
    pub fn refresh(&self) -> Result<()> {
        let mut state = self.state();
        let Some(name) = state.collection.clone() else {
            return Err(not_set_up());
        };
        let models = || match state.models {
            true => Ok(String::new()),
            false => run(&["pull"]),
        };
        let result = models()
            .and_then(|_| run(&["update"]))
            .and_then(|_| run(&["embed", "-c", &name]));
        match &result {
            Ok(_) => {
                state.models = true;
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

    /// The hits for `query`, best first.
    fn query(&self, query: &str, limit: usize) -> Result<Vec<Hit>> {
        let name = self.collection().ok_or_else(not_set_up)?;
        let n = limit.to_string();
        parse_hits(&run(&["query", "--json", "-n", &n, "-c", &name, query])?)
    }
}

/// One of qmd's results.
#[derive(Debug, PartialEq)]
struct Hit {
    file: String,
    score: f64,
    snippet: Option<String>,
    /// Zero-based.
    line: Option<u32>,
}

/// Reads `qmd … --json`. Progress (the expanded queries…) can come first on
/// stdout, and each snippet starts with a `@@ -11,4 @@ (…)` line saying
/// where it's from.
fn parse_hits(out: &str) -> Result<Vec<Hit>> {
    let start = out
        .lines()
        .position(|l| l.trim_start().starts_with('['))
        .map(|i| out.lines().take(i).map(|l| l.len() + 1).sum::<usize>())
        .ok_or_else(|| CoreError::Qmd("qmd answered with no results list".into()))?;
    let hits: Vec<Value> = serde_json::from_str(out[start..].trim())
        .map_err(|e| CoreError::Qmd(format!("qmd's answer wasn't readable: {e}")))?;
    Ok(hits
        .iter()
        .filter_map(|h| {
            let snippet = h.get("snippet").and_then(Value::as_str).map(|s| {
                let s = s.trim_start();
                match s.starts_with("@@") {
                    true => s.split_once('\n').map_or("", |(_, rest)| rest),
                    false => s,
                }
                .trim()
                .to_string()
            });
            Some(Hit {
                file: h.get("file")?.as_str()?.to_string(),
                score: h.get("score").and_then(Value::as_f64).unwrap_or(0.0),
                snippet: snippet.filter(|s| !s.is_empty()),
                line: h
                    .get("line")
                    .and_then(Value::as_u64)
                    .and_then(|l| u32::try_from(l.checked_sub(1)?).ok()),
            })
        })
        .collect())
}

fn not_set_up() -> CoreError {
    CoreError::Qmd(
        "smart search isn't set up: run `groundwork qmd setup`, or turn it on in Settings › Search"
            .into(),
    )
}

/// Keeps the collection up to date in the background: after files change
/// (once they've settled, and not more often than every `GAP`), or at once
/// when asked.
pub struct Updater {
    tx: Mutex<mpsc::Sender<bool>>,
    busy: Arc<AtomicBool>,
}

impl Updater {
    pub fn start(qmd: Qmd) -> Self {
        Self::with_timing(qmd, SETTLE, GAP)
    }

    fn with_timing(qmd: Qmd, settle: Duration, gap: Duration) -> Self {
        let (tx, rx) = mpsc::channel::<bool>();
        let busy = Arc::new(AtomicBool::new(false));
        let flag = busy.clone();
        std::thread::spawn(move || {
            let mut due: Option<Instant> = None;
            let mut last: Option<Instant> = None;
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
                            let settled = Instant::now() + settle;
                            due = Some(last.map_or(settled, |l| settled.max(l + gap)));
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
                    last = Some(Instant::now());
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
    use std::path::Path;

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
        assert_eq!(found[0].line, Some(11));
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
        // The first time, the models; then only the vault's embeddings.
        assert!(
            calls.ends_with("pull\nupdate\nembed -c groundwork-vault\n"),
            "{calls}"
        );
        updater.refresh();
        while updater.busy() {
            std::thread::sleep(Duration::from_millis(20));
        }
        let calls = std::fs::read_to_string(dir.path().join("qmd-bin/calls")).unwrap();
        assert!(
            calls.ends_with("embed -c groundwork-vault\nupdate\nembed -c groundwork-vault\n"),
            "{calls}"
        );
    }

    #[test]
    fn changes_wait_to_settle_and_updates_are_spaced_out() {
        let (dir, s) = session();
        let _qmd = fake(dir.path());
        let qmd = s.qmd();
        qmd.setup().unwrap();
        let calls = dir.path().join("qmd-bin/calls");
        let updates = || {
            std::fs::read_to_string(&calls)
                .unwrap()
                .lines()
                .filter(|l| *l == "update")
                .count()
        };
        let ms = Duration::from_millis;
        let updater = Updater::with_timing(qmd, ms(150), ms(800));
        // Changes keep pushing the update back until they stop.
        for _ in 0..4 {
            updater.changed();
            std::thread::sleep(ms(60));
        }
        assert_eq!(updates(), 0);
        std::thread::sleep(ms(300));
        assert_eq!(updates(), 1);
        // Another change has to wait out the gap since that update.
        updater.changed();
        std::thread::sleep(ms(350));
        assert_eq!(updates(), 1);
        std::thread::sleep(ms(700));
        assert_eq!(updates(), 2);
    }

    #[test]
    fn reads_qmds_answers() {
        // As qmd 2.8 prints them (`vsearch` shows its expanded queries first).
        let out = r##"├─ what did we agree with the vendor
└─ hyde: Understanding what did we agree [with] the vendor…
Searching 4 vector queries...
[
  {
    "docid": "#742c9b",
    "score": 0.77,
    "file": "qmd://gw/Events/2026-11-04 Vendor call.md?index=probe",
    "line": 12,
    "title": "Vendor call",
    "snippet": "@@ -11,4 @@ (10 before, 2 after)\n\nSam walked through the contract terms.\n\n## Action items"
  },
  { "file": "qmd://gw/Welcome.md", "score": 0.3, "snippet": "Hello" }
]
"##;
        let hits = parse_hits(out).unwrap();
        assert_eq!(
            hits[0],
            Hit {
                file: "qmd://gw/Events/2026-11-04 Vendor call.md?index=probe".into(),
                score: 0.77,
                snippet: Some("Sam walked through the contract terms.\n\n## Action items".into()),
                line: Some(11),
            }
        );
        assert_eq!(hits[1].snippet.as_deref(), Some("Hello"));
        assert_eq!(hits[1].line, None);
        assert!(parse_hits("Searching…\n").is_err());
        let (_dir, s) = session();
        assert_eq!(
            vault_path(&s.index(), &hits[0].file).as_deref(),
            Some("Events/2026-11-04 Vendor call.md")
        );
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
