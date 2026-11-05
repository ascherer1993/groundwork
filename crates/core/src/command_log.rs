//! The command log (PLAN §5.10): every request made from the command bar,
//! what was asked, when, and what Claude did, for looking back on and for
//! making sessions go better. It's `.groundwork/command-log.jsonl` in the
//! vault, one record per line, only ever appended to: the app writes
//! `asked` as it starts the session, Claude Code's SessionStart hook adds
//! the session (`started`), and `groundwork done` the outcome (`done`).
//! The session learns its request's id from `GROUNDWORK_REQUEST`.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::SystemTime;

use chrono::Local;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::Result;
use crate::agent::AgentContext;

pub const LOG_FILE: &str = ".groundwork/command-log.jsonl";
/// Set in a command bar session's environment: its request's id.
pub const REQUEST_ENV: &str = "GROUNDWORK_REQUEST";

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// How a request went, by Claude's account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Outcome {
    Done,
    /// It's waiting on the user: a question, a decision, more to do.
    NeedsYou,
    Failed,
}

/// One request from the command bar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommandEntry {
    pub id: String,
    /// When it was asked (RFC 3339).
    pub asked: String,
    pub prompt: String,
    /// The chips that were on.
    pub context: AgentContext,
    /// Whether they asked to see the session (⌘↩) rather than leave it in
    /// the background.
    pub shown: bool,
    /// The terminal it ran in.
    pub tab: Option<String>,
    /// Claude Code's session, for `claude --resume`.
    pub session: Option<String>,
    /// When Claude said it was done (RFC 3339).
    pub finished: Option<String>,
    pub outcome: Option<Outcome>,
    /// What Claude says it did.
    pub summary: Option<String>,
    /// Whether Claude closed its tab when it finished.
    pub closed: bool,
}

/// A line of the log.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
enum Record {
    Asked {
        id: String,
        at: String,
        prompt: String,
        #[serde(default)]
        context: AgentContext,
        #[serde(default)]
        shown: bool,
    },
    Started {
        id: String,
        #[serde(default)]
        tab: Option<String>,
        #[serde(default)]
        session: Option<String>,
    },
    Done {
        id: String,
        at: String,
        outcome: Outcome,
        summary: String,
        #[serde(default)]
        closed: bool,
    },
}

pub struct CommandLog {
    path: PathBuf,
}

fn now() -> String {
    Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

impl CommandLog {
    pub fn new(vault_root: &Path) -> Self {
        Self {
            path: vault_root.join(LOG_FILE),
        }
    }

    /// Logs a request as its session starts; returns its id.
    pub fn ask(&self, prompt: &str, context: &AgentContext, shown: bool) -> Result<String> {
        let millis = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let id = format!(
            "{millis:x}{:04x}",
            COUNTER.fetch_add(1, Ordering::Relaxed) & 0xffff
        );
        self.append(&Record::Asked {
            id: id.clone(),
            at: now(),
            prompt: prompt.to_string(),
            context: context.clone(),
            shown,
        })?;
        Ok(id)
    }

    /// Records where a request's session runs.
    pub fn started(&self, id: &str, tab: Option<&str>, session: Option<&str>) -> Result<()> {
        self.append(&Record::Started {
            id: id.to_string(),
            tab: tab.map(Into::into),
            session: session.map(Into::into),
        })
    }

    /// Records how a request went. Claude may say so more than once (it
    /// kept going); the last word counts.
    pub fn done(&self, id: &str, outcome: Outcome, summary: &str, closed: bool) -> Result<()> {
        self.append(&Record::Done {
            id: id.to_string(),
            at: now(),
            outcome,
            summary: summary.trim().to_string(),
            closed,
        })
    }

    pub fn get(&self, id: &str) -> Option<CommandEntry> {
        self.entries().into_iter().find(|e| e.id == id)
    }

    /// The newest `limit` requests, newest first.
    pub fn list(&self, limit: usize) -> Vec<CommandEntry> {
        let mut entries = self.entries();
        entries.reverse();
        entries.truncate(limit);
        entries
    }

    /// Every request, oldest first. Lines it can't read are skipped.
    fn entries(&self) -> Vec<CommandEntry> {
        let Ok(text) = fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        let mut entries: Vec<CommandEntry> = Vec::new();
        for record in text
            .lines()
            .filter_map(|l| serde_json::from_str::<Record>(l).ok())
        {
            match record {
                Record::Asked {
                    id,
                    at,
                    prompt,
                    context,
                    shown,
                } => entries.push(CommandEntry {
                    id,
                    asked: at,
                    prompt,
                    context,
                    shown,
                    tab: None,
                    session: None,
                    finished: None,
                    outcome: None,
                    summary: None,
                    closed: false,
                }),
                Record::Started { id, tab, session } => {
                    if let Some(e) = entries.iter_mut().rev().find(|e| e.id == id) {
                        e.tab = tab.or(e.tab.take());
                        e.session = session.or(e.session.take());
                    }
                }
                Record::Done {
                    id,
                    at,
                    outcome,
                    summary,
                    closed,
                } => {
                    if let Some(e) = entries.iter_mut().rev().find(|e| e.id == id) {
                        e.finished = Some(at);
                        e.outcome = Some(outcome);
                        e.summary = Some(summary);
                        e.closed = closed;
                    }
                }
            }
        }
        entries
    }

    /// One line, in one write, so records from the app and the CLI don't
    /// interleave.
    fn append(&self, record: &Record) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut line = serde_json::to_string(record).map_err(std::io::Error::other)?;
        line.push('\n');
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?
            .write_all(line.as_bytes())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_logged_as_they_go() {
        let dir = tempfile::tempdir().unwrap();
        let log = CommandLog::new(dir.path());
        assert!(log.list(10).is_empty());

        let context = AgentContext {
            note: Some("Welcome.md".into()),
            ..Default::default()
        };
        let first = log
            .ask("Open a worktree for TEAM-9", &context, false)
            .unwrap();
        let second = log
            .ask("Summarise this", &AgentContext::default(), true)
            .unwrap();
        assert_ne!(first, second);
        log.started(&first, Some("t1"), None).unwrap();
        log.started(&first, None, Some("s1")).unwrap();
        log.done(&first, Outcome::NeedsYou, "Asked which repo", false)
            .unwrap();
        log.done(&first, Outcome::Done, "  Made the worktree  ", true)
            .unwrap();
        // A line it can't read, say from a newer version, is skipped.
        let path = dir.path().join(LOG_FILE);
        let mut text = fs::read_to_string(&path).unwrap();
        text.push_str("{\"event\":\"somethingNew\"}\nnot json\n");
        fs::write(&path, text).unwrap();

        let list = log.list(10);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, second, "newest first");
        assert!(list[0].shown);
        assert_eq!(list[0].outcome, None);
        let e = &list[1];
        assert_eq!(e.prompt, "Open a worktree for TEAM-9");
        assert_eq!(e.context, context);
        assert_eq!(e.tab.as_deref(), Some("t1"));
        assert_eq!(e.session.as_deref(), Some("s1"));
        assert_eq!(e.outcome, Some(Outcome::Done), "the last word counts");
        assert_eq!(e.summary.as_deref(), Some("Made the worktree"));
        assert!(e.closed && e.finished.is_some());
        assert_eq!(log.list(1).len(), 1);
        assert_eq!(log.get(&first).unwrap().summary, e.summary);
        assert!(log.get("nope").is_none());
    }
}
