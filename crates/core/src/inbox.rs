//! The inbox: what agents are waiting on you for. Questions from
//! `groundwork ask` (the agent waits for the answer), notes from
//! `groundwork notify`, and Claude Code asking for attention in a terminal.
//!
//! Kept in `inbox.json` in the data folder, so a question survives the app
//! restarting, and the CLI can post one while the app isn't running.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{CoreError, Result};

const FILE_NAME: &str = "inbox.json";
/// Done items are kept this long, for the inbox's history (and so an agent
/// can still read its answer)…
const KEEP_DONE_MS: u64 = 30 * 24 * 60 * 60 * 1000;
/// …up to this many.
const KEEP_DONE: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum InboxKind {
    /// A question; the agent waits for the answer.
    Ask,
    /// Something to know; nothing waits.
    Notify,
    /// Claude Code in a terminal is waiting on you (a permission prompt, or
    /// idle at its prompt).
    Attention,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InboxItem {
    pub id: String,
    pub kind: InboxKind,
    pub text: String,
    /// Answers to pick from, for a question. Any answer may be typed instead.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
    /// A note it's about (`[[Note]]` or a vault path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub link: Option<String>,
    /// The terminal it came from (`GROUNDWORK_TAB_ID`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tab: Option<String>,
    /// The vault it's about, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub vault: Option<String>,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub created: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answer: Option<String>,
    /// Answered or dismissed.
    #[serde(default)]
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub done_at: Option<u64>,
}

/// A new item's contents.
#[derive(Debug, Clone, Default)]
pub struct NewItem {
    pub text: String,
    pub choices: Vec<String>,
    pub link: Option<String>,
    pub tab: Option<String>,
    pub vault: Option<String>,
    /// Nothing to do about it: it goes straight to the history, done when
    /// it's made (`done_at == created`), with no notification.
    pub done: bool,
}

pub struct Inbox {
    file: PathBuf,
    lock: Mutex<()>,
}

static COUNTER: AtomicU32 = AtomicU32::new(0);

impl Inbox {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            file: data_dir.join(FILE_NAME),
            lock: Mutex::new(()),
        }
    }

    /// Items not yet answered or dismissed, oldest first.
    pub fn open(&self) -> Vec<InboxItem> {
        self.read().into_iter().filter(|i| !i.done).collect()
    }

    /// Items answered or dismissed, most recently done first.
    pub fn history(&self, limit: usize) -> Vec<InboxItem> {
        let mut done: Vec<_> = self.read().into_iter().filter(|i| i.done).collect();
        done.sort_by_key(|i| std::cmp::Reverse((i.done_at.unwrap_or(i.created), i.created)));
        done.truncate(limit);
        done
    }

    pub fn get(&self, id: &str) -> Option<InboxItem> {
        self.read().into_iter().find(|i| i.id == id)
    }

    pub fn add(&self, kind: InboxKind, item: NewItem) -> Result<InboxItem> {
        let text = item.text.trim().to_string();
        if text.is_empty() {
            return Err(CoreError::InvalidPath(
                "nothing to say: the text is empty".into(),
            ));
        }
        let now = now_millis();
        let item = InboxItem {
            id: format!(
                "{now:x}{:04x}",
                COUNTER.fetch_add(1, Ordering::Relaxed) & 0xffff
            ),
            kind,
            text,
            choices: item.choices,
            link: item.link,
            tab: item.tab,
            vault: item.vault,
            created: now,
            answer: None,
            done: item.done,
            done_at: item.done.then_some(now),
        };
        self.change(|items| {
            items.push(item.clone());
            true
        })?;
        Ok(item)
    }

    /// Answers a question (or marks anything else done). Answering twice is
    /// an error: the agent has already moved on.
    pub fn answer(&self, id: &str, answer: Option<String>) -> Result<InboxItem> {
        let mut found = None;
        let mut already = false;
        self.change(|items| {
            let Some(item) = items.iter_mut().find(|i| i.id == id) else {
                return false;
            };
            if item.done {
                already = true;
                return false;
            }
            item.done = true;
            item.done_at = Some(now_millis());
            item.answer = answer.clone();
            found = Some(item.clone());
            true
        })?;
        if already {
            return Err(CoreError::Conflict("that's already been answered".into()));
        }
        found.ok_or_else(|| CoreError::NotFound(format!("no inbox item {id}")))
    }

    /// Marks a terminal's attention items done. Returns whether any were.
    pub fn clear_attention(&self, tab: &str) -> Result<bool> {
        let mut any = false;
        self.change(|items| {
            let now = now_millis();
            for item in items.iter_mut() {
                if item.kind == InboxKind::Attention
                    && !item.done
                    && item.tab.as_deref() == Some(tab)
                {
                    item.done = true;
                    item.done_at = Some(now);
                    any = true;
                }
            }
            any
        })?;
        Ok(any)
    }

    fn read(&self) -> Vec<InboxItem> {
        fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Reads, changes and (if `f` says it changed anything) saves, dropping
    /// old done items.
    fn change(&self, f: impl FnOnce(&mut Vec<InboxItem>) -> bool) -> Result<()> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut items = self.read();
        if !f(&mut items) {
            return Ok(());
        }
        let now = now_millis();
        items.retain(|i| {
            !i.done
                || i.done_at
                    .is_none_or(|t| now.saturating_sub(t) < KEEP_DONE_MS)
        });
        let done = items.iter().filter(|i| i.done).count();
        if done > KEEP_DONE {
            // Drop the oldest done ones (items are in the order they came).
            let mut drop = done - KEEP_DONE;
            items.retain(|i| {
                if i.done && drop > 0 {
                    drop -= 1;
                    return false;
                }
                true
            });
        }
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = self
            .file
            .with_extension(format!("json.{}.tmp", std::process::id()));
        fs::write(&tmp, serde_json::to_vec_pretty(&items)?)?;
        fs::rename(tmp, &self.file)?;
        Ok(())
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(t: &str) -> NewItem {
        NewItem {
            text: t.into(),
            ..Default::default()
        }
    }

    #[test]
    fn some_things_are_done_as_they_arrive() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = Inbox::new(dir.path());
        let item = inbox
            .add(
                InboxKind::Notify,
                NewItem {
                    done: true,
                    ..text("Made the note")
                },
            )
            .unwrap();
        assert!(item.done && item.done_at == Some(item.created));
        assert!(inbox.open().is_empty());
        assert_eq!(inbox.history(10), [item]);
    }

    #[test]
    fn asks_answers_and_keeps_the_answer() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = Inbox::new(dir.path());
        let q = inbox
            .add(
                InboxKind::Ask,
                NewItem {
                    text: "Which env?".into(),
                    choices: vec!["staging".into(), "prod".into()],
                    tab: Some("t1".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let n = inbox.add(InboxKind::Notify, text("Done")).unwrap();
        assert_ne!(q.id, n.id);
        assert_eq!(inbox.open().len(), 2);

        let answered = inbox.answer(&q.id, Some("staging".into())).unwrap();
        assert!(answered.done);
        assert_eq!(inbox.open(), vec![n.clone()]);
        // Another process (the agent's CLI) reads the answer from the file.
        let again = Inbox::new(dir.path()).get(&q.id).unwrap();
        assert_eq!(again.answer.as_deref(), Some("staging"));
        assert!(matches!(
            inbox.answer(&q.id, None),
            Err(CoreError::Conflict(_))
        ));
        assert!(matches!(
            inbox.answer("nope", None),
            Err(CoreError::NotFound(_))
        ));
        assert!(inbox.add(InboxKind::Notify, text("  ")).is_err());

        // The history: what's done, most recent first.
        inbox.answer(&n.id, None).unwrap();
        let history = inbox.history(10);
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].id, n.id);
        assert_eq!(history[0].answer, None);
        assert_eq!(history[1].answer.as_deref(), Some("staging"));
        assert_eq!(inbox.history(1).len(), 1);
    }

    #[test]
    fn keeps_a_bounded_history() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = Inbox::new(dir.path());
        let waiting = inbox.add(InboxKind::Ask, text("still open")).unwrap();
        for i in 0..KEEP_DONE + 5 {
            let item = inbox
                .add(InboxKind::Notify, text(&format!("n{i}")))
                .unwrap();
            inbox.answer(&item.id, None).unwrap();
        }
        let history = inbox.history(usize::MAX);
        assert_eq!(history.len(), KEEP_DONE);
        assert!(history.iter().all(|i| i.text != "n0"));
        // Open items are never dropped.
        assert_eq!(inbox.open(), vec![waiting]);
    }

    #[test]
    fn attention_clears_by_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = Inbox::new(dir.path());
        let mut item = text("Claude needs your permission");
        item.tab = Some("t1".into());
        inbox.add(InboxKind::Attention, item.clone()).unwrap();
        item.tab = Some("t2".into());
        inbox.add(InboxKind::Attention, item).unwrap();
        assert!(!inbox.clear_attention("t3").unwrap());
        assert!(inbox.clear_attention("t1").unwrap());
        let open = inbox.open();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].tab.as_deref(), Some("t2"));
    }
}
