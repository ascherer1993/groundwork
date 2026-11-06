//! Todos across the vault (PLAN §4.9, §5.11): listing, filtering and the
//! daily note's day view. Todos stay in the notes they were written in;
//! these are views over the index.

use chrono::{Duration, NaiveDate};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::activity::ActivityKind;
use crate::daily::DailySettings;
use crate::index::{Index, hash};
use crate::parse::{Task, TaskStatus};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Todo {
    /// `path:line:hash`; the hash of the task text catches stale ids.
    pub id: String,
    pub path: String,
    #[serde(flatten)]
    #[ts(flatten)]
    pub task: Task,
    /// Tags on the task's own line, without `#`.
    pub tags: Vec<String>,
    /// The date of the daily note it's in, if it's in one.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daily: Option<String>,
}

impl Todo {
    pub fn is_open(&self) -> bool {
        matches!(self.task.status, TaskStatus::Todo | TaskStatus::Other)
    }
}

/// The id of a task: its note, its line and a hash of its text.
pub fn todo_id(path: &str, task: &Task) -> String {
    format!("{path}:{}:{}", task.line, &hash(task.text.as_bytes())[..8])
}

/// A change to one task, made in the line where it lives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum TaskChange {
    Done,
    Cancel,
    Reopen,
    /// Sets (`YYYY-MM-DD`) or clears the due date.
    Due {
        date: Option<String>,
    },
    /// `0`–`5` for `p0`–`p5`.
    Priority {
        priority: u8,
    },
}

/// Splits an id into path, line and text hash.
pub fn split_id(id: &str) -> Option<(&str, u32, &str)> {
    let mut parts = id.rsplitn(3, ':');
    let hash = parts.next()?;
    let line = parts.next()?.parse().ok()?;
    let path = parts.next()?;
    Some((path, line, hash))
}

fn line_tags(text: &str) -> Vec<String> {
    text.split_whitespace()
        .filter_map(|w| w.strip_prefix('#'))
        .map(|t| t.trim_end_matches([',', '.', ';', ':']).to_string())
        .filter(|t| !t.is_empty() && !t.chars().all(|c| c.is_ascii_digit()))
        .collect()
}

/// Every task in the vault, in path and line order.
pub fn all(index: &Index, daily: &DailySettings) -> Vec<Todo> {
    let prefix = if daily.folder.is_empty() {
        String::new()
    } else {
        format!("{}/", daily.folder)
    };
    let mut todos: Vec<Todo> = index
        .notes()
        .flat_map(|(path, note)| {
            let day = path
                .strip_prefix(&prefix)
                .and_then(|p| daily.date_of(p))
                .map(|d| d.to_string());
            note.tasks.iter().map(move |task| Todo {
                id: todo_id(path, task),
                path: path.to_string(),
                tags: line_tags(&task.text),
                daily: day.clone(),
                task: task.clone(),
            })
        })
        .collect();
    todos.sort_by(|a, b| a.path.cmp(&b.path).then(a.task.line.cmp(&b.task.line)));
    todos
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum StatusFilter {
    #[default]
    Open,
    Done,
    Cancelled,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DueFilter {
    /// Due before today.
    Overdue,
    /// Due today or before.
    Today,
    /// Due within the next 7 days, or before.
    Week,
    /// Has a due date.
    Any,
    /// No due date.
    None,
}

/// Which todos to list. Every set field must match.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct TodoFilter {
    #[ts(optional)]
    pub status: Option<StatusFilter>,
    #[ts(optional)]
    pub due: Option<DueFilter>,
    /// Highest priority number to include: `1` means p0 and p1.
    #[ts(optional)]
    pub max_priority: Option<u8>,
    /// Tags (without `#`) the task line or its note must have.
    pub tags: Vec<String>,
    /// Only notes whose path starts with this (case-insensitive).
    #[ts(optional)]
    pub path: Option<String>,
    /// Text the task must contain (case-insensitive).
    #[ts(optional)]
    pub text: Option<String>,
    /// Only tasks created (`➕`) at least this many days ago.
    #[ts(optional)]
    pub stale_days: Option<u32>,
}

impl TodoFilter {
    pub fn matches(&self, todo: &Todo, note_tags: &[String], today: NaiveDate) -> bool {
        let status_ok = match self.status.unwrap_or_default() {
            StatusFilter::Open => todo.is_open(),
            StatusFilter::Done => todo.task.status == TaskStatus::Done,
            StatusFilter::Cancelled => todo.task.status == TaskStatus::Cancelled,
            StatusFilter::All => true,
        };
        let date = |s: &Option<String>| s.as_deref().and_then(|d| d.parse::<NaiveDate>().ok());
        let due = date(&todo.task.due);
        let due_ok = match self.due {
            None => true,
            Some(DueFilter::Overdue) => due.is_some_and(|d| d < today),
            Some(DueFilter::Today) => due.is_some_and(|d| d <= today),
            Some(DueFilter::Week) => due.is_some_and(|d| d <= today + Duration::days(7)),
            Some(DueFilter::Any) => due.is_some(),
            Some(DueFilter::None) => due.is_none(),
        };
        let has_tag = |wanted: &String| {
            let wanted = wanted.trim_start_matches('#').to_lowercase();
            todo.tags.iter().chain(note_tags).any(|t| {
                let t = t.to_lowercase();
                t == wanted || t.starts_with(&format!("{wanted}/"))
            })
        };
        status_ok
            && due_ok
            && self.max_priority.is_none_or(|p| todo.task.priority <= p)
            && self.tags.iter().all(has_tag)
            && self
                .path
                .as_ref()
                .is_none_or(|p| todo.path.to_lowercase().starts_with(&p.to_lowercase()))
            && self
                .text
                .as_ref()
                .is_none_or(|t| todo.task.text.to_lowercase().contains(&t.to_lowercase()))
            && self.stale_days.is_none_or(|days| {
                date(&todo.task.created).is_some_and(|c| c <= today - Duration::days(days.into()))
            })
    }
}

/// The `tags:` property of a note. Tags in its text belong to their line,
/// so they don't tag every task in the note.
fn frontmatter_tags(index: &Index, path: &str) -> Vec<String> {
    let Some(tags) = index
        .note(path)
        .and_then(|n| n.frontmatter.as_ref())
        .and_then(|f| f.get("tags"))
    else {
        return Vec::new();
    };
    let words = |s: &str| {
        s.split([',', ' '])
            .map(|t| t.trim().trim_start_matches('#').to_string())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
    };
    match tags {
        serde_json::Value::String(s) => words(s),
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|v| v.as_str())
            .flat_map(words)
            .collect(),
        _ => Vec::new(),
    }
}

/// Earliest due first (undated last), then priority, then where they live.
fn by_urgency(a: &Todo, b: &Todo) -> std::cmp::Ordering {
    let due = |t: &Todo| t.task.due.clone().unwrap_or_else(|| "9999".into());
    due(a)
        .cmp(&due(b))
        .then(a.task.priority.cmp(&b.task.priority))
        .then(a.path.cmp(&b.path))
        .then(a.task.line.cmp(&b.task.line))
}

/// Todos matching `filter`, most urgent first.
pub fn list(
    index: &Index,
    daily: &DailySettings,
    filter: &TodoFilter,
    today: NaiveDate,
) -> Vec<Todo> {
    // A note's tags only matter when asked for.
    let note_tags = |path: &str| {
        if filter.tags.is_empty() {
            Vec::new()
        } else {
            frontmatter_tags(index, path)
        }
    };
    let mut todos: Vec<Todo> = all(index, daily)
        .into_iter()
        .filter(|t| filter.matches(t, &note_tags(&t.path), today))
        .collect();
    todos.sort_by(by_urgency);
    todos
}

/// What a daily note's `todos` block shows for its date.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DayView {
    pub date: String,
    /// Due before the date and not done.
    pub overdue: Vec<Todo>,
    /// Due (or scheduled) on the date.
    pub due: Vec<Todo>,
    /// The note's own open tasks that are due after the date.
    pub later: Vec<Todo>,
    /// Undated open tasks from earlier daily notes.
    pub carried: Vec<Todo>,
    /// Completed on the date, and the note's own done or cancelled tasks.
    pub done: Vec<Todo>,
}

/// The day view for `date`. Tasks written in `note` itself are left out
/// (they're already on the page), except those on `own` lines (zero-based,
/// inclusive): the ones beside the block, which it shows as its own. Undated
/// ones count as that day's, and done or cancelled ones stay, under done.
pub fn day(
    index: &Index,
    daily: &DailySettings,
    date: NaiveDate,
    note: &str,
    own: Option<[u32; 2]>,
) -> DayView {
    let day = date.to_string();
    let mut view = DayView {
        date: day.clone(),
        ..Default::default()
    };
    for todo in all(index, daily) {
        let task = &todo.task;
        if todo.path == note {
            if !own.is_some_and(|[first, last]| (first..=last).contains(&task.line)) {
                continue;
            }
            match task.due.as_deref() {
                _ if !todo.is_open() => view.done.push(todo),
                Some(due) if due < day.as_str() => view.overdue.push(todo),
                Some(due) if due > day.as_str() => view.later.push(todo),
                _ => view.due.push(todo),
            }
            continue;
        }
        if task.status == TaskStatus::Cancelled {
            continue;
        }
        if task.status == TaskStatus::Done {
            if task.done.as_deref() == Some(day.as_str()) {
                view.done.push(todo);
            }
        } else if task.due.as_ref().is_some_and(|d| *d < day) {
            view.overdue.push(todo);
        } else if task.due.as_deref() == Some(day.as_str())
            || (task.due.is_none() && task.scheduled.as_deref() == Some(day.as_str()))
        {
            view.due.push(todo);
        } else if task.due.is_none() && todo.daily.as_ref().is_some_and(|d| *d < day) {
            view.carried.push(todo);
        }
    }
    view.overdue.sort_by(by_urgency);
    view.due.sort_by(by_urgency);
    view.later.sort_by(by_urgency);
    // Oldest first, so the longest-waiting tasks are noticed.
    view.carried
        .sort_by(|a, b| a.daily.cmp(&b.daily).then(a.task.line.cmp(&b.task.line)));
    view
}

/// What happened to a note's tasks between two versions, for the activity
/// log. Tasks are matched by text, then by line (an edited task). New tasks
/// count as added when they carry a `➕` stamp (the editor adds one once you
/// leave the line, so half-typed tasks aren't logged) or come from outside
/// Groundwork.
pub fn task_events(old: &[Task], new: &[Task], external: bool) -> Vec<(ActivityKind, Task)> {
    let mut unmatched_old: Vec<&Task> = old.iter().collect();
    let mut pairs: Vec<(Option<&Task>, &Task)> = Vec::new();
    let mut unmatched_new = Vec::new();
    for task in new {
        let same_text = unmatched_old
            .iter()
            .enumerate()
            .filter(|(_, o)| o.text == task.text)
            .min_by_key(|(_, o)| o.line.abs_diff(task.line))
            .map(|(i, _)| i);
        match same_text {
            Some(i) => pairs.push((Some(unmatched_old.remove(i)), task)),
            None => unmatched_new.push(task),
        }
    }
    for task in unmatched_new {
        let same_line = unmatched_old.iter().position(|o| o.line == task.line);
        pairs.push((same_line.map(|i| unmatched_old.remove(i)), task));
    }

    let closed = |t: &Task| matches!(t.status, TaskStatus::Done | TaskStatus::Cancelled);
    let mut events = Vec::new();
    for (before, after) in pairs {
        let mut push = |kind| events.push((kind, after.clone()));
        let Some(before) = before else {
            if external || after.created.is_some() {
                push(ActivityKind::TaskAdded);
            }
            continue;
        };
        if before.created.is_none() && after.created.is_some() {
            push(ActivityKind::TaskAdded);
        }
        if before.status != after.status {
            match after.status {
                TaskStatus::Done => push(ActivityKind::TaskDone),
                TaskStatus::Cancelled => push(ActivityKind::TaskCancelled),
                _ if closed(before) => push(ActivityKind::TaskReopened),
                _ => {}
            }
        }
        if before.due != after.due && after.due.is_some() {
            push(ActivityKind::TaskRescheduled);
        }
    }
    events.sort_by_key(|(_, t)| t.line);
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::tests::temp_vault;

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn texts(todos: &[Todo]) -> Vec<&str> {
        todos.iter().map(|t| t.task.text.as_str()).collect()
    }

    fn daily() -> DailySettings {
        DailySettings {
            folder: "Daily".into(),
            ..Default::default()
        }
    }

    const VAULT: &[(&str, &str)] = &[
        (
            "Daily/2026-11-01.md",
            "- [ ] Old undated\n- [ ] Old dated 📅 2026-11-02\n- [x] Finished ✅ 2026-11-03\n",
        ),
        (
            "Daily/2026-11-03.md",
            "- [ ] Written today\n- [x] Done today here ✅ 2026-11-03\n",
        ),
        (
            "Projects/Acme.md",
            "---\ntags: [work]\n---\n- [ ] Ship it ⏫ 📅 2026-11-03 ➕ 2026-10-01\n- [ ] Someday #waiting\n- [-] Dropped ❌ 2026-11-03\n- [ ] Plan ⏳ 2026-11-03\n",
        ),
        ("Later.md", "- [ ] Future 📅 2026-11-08\n"),
    ];

    #[test]
    fn day_view_groups_tasks_for_the_notes_date() {
        let (_dir, index) = temp_vault(VAULT);
        let view = day(
            &index,
            &daily(),
            d("2026-11-03"),
            "Daily/2026-11-03.md",
            None,
        );
        assert_eq!(texts(&view.overdue), ["Old dated"]);
        assert_eq!(texts(&view.due), ["Ship it", "Plan"]);
        assert_eq!(texts(&view.carried), ["Old undated"]);
        assert_eq!(view.carried[0].daily.as_deref(), Some("2026-11-01"));
        assert_eq!(texts(&view.done), ["Finished"]);

        // An earlier day: nothing was overdue yet, nothing carried from before.
        let view = day(
            &index,
            &daily(),
            d("2026-11-01"),
            "Daily/2026-11-01.md",
            None,
        );
        assert!(view.overdue.is_empty() && view.carried.is_empty() && view.done.is_empty());
    }

    #[test]
    fn day_view_shows_the_tasks_beside_its_block() {
        let note = "Daily/2026-11-05.md";
        let text = "## Todos\n\n- [ ] Undated\n- [ ] Due before 📅 2026-11-04\n- [ ] Due on the day 📅 2026-11-05\n- [ ] Due after 📅 2026-11-09\n- [x] Ticked ✅ 2026-11-01\n- [-] Dropped ❌ 2026-11-05\n\n```todos\nday\n```\n\n## Notes\n- [ ] Elsewhere in the note\n";
        let mut vault = VAULT.to_vec();
        vault.push((note, text));
        let (_dir, index) = temp_vault(&vault);
        let view = day(&index, &daily(), d("2026-11-05"), note, Some([2, 11]));
        assert_eq!(texts(&view.overdue), ["Old dated", "Ship it", "Due before"]);
        assert_eq!(
            texts(&view.due),
            ["Due on the day", "Undated"],
            "undated ones are the day's"
        );
        assert_eq!(texts(&view.later), ["Due after"]);
        assert_eq!(texts(&view.done), ["Ticked", "Dropped"]);
        assert!(!texts(&view.due).contains(&"Elsewhere in the note"));

        // Without the lines, the note's own tasks stay on the page.
        let view = day(&index, &daily(), d("2026-11-05"), note, None);
        assert!(view.later.is_empty() && view.done.is_empty());
        assert_eq!(texts(&view.overdue), ["Old dated", "Ship it"]);
    }

    #[test]
    fn filters_combine() {
        let (_dir, index) = temp_vault(VAULT);
        let today = d("2026-11-03");
        let run = |f: TodoFilter| texts(&list(&index, &daily(), &f, today)).join(", ");
        assert_eq!(
            run(TodoFilter {
                due: Some(DueFilter::Overdue),
                ..Default::default()
            }),
            "Old dated"
        );
        assert_eq!(
            run(TodoFilter {
                due: Some(DueFilter::Week),
                ..Default::default()
            }),
            "Old dated, Ship it, Future"
        );
        assert_eq!(
            run(TodoFilter {
                max_priority: Some(1),
                ..Default::default()
            }),
            "Ship it"
        );
        // Note tags count, and so do tags on the line.
        assert_eq!(
            run(TodoFilter {
                tags: vec!["work".into()],
                ..Default::default()
            }),
            "Ship it, Someday #waiting, Plan"
        );
        assert_eq!(
            run(TodoFilter {
                tags: vec!["#waiting".into()],
                ..Default::default()
            }),
            "Someday #waiting"
        );
        assert_eq!(
            run(TodoFilter {
                status: Some(StatusFilter::Done),
                path: Some("daily/".into()),
                ..Default::default()
            }),
            "Finished, Done today here"
        );
        assert_eq!(
            run(TodoFilter {
                stale_days: Some(14),
                ..Default::default()
            }),
            "Ship it"
        );
    }

    #[test]
    fn ids_round_trip() {
        let (_dir, index) = temp_vault(VAULT);
        let todo = &all(&index, &daily())[0];
        let (path, line, hash) = split_id(&todo.id).unwrap();
        assert_eq!((path, line), ("Daily/2026-11-01.md", 0));
        assert_eq!(hash.len(), 8);
        assert_eq!(split_id("a:b:c:4:abc"), Some(("a:b:c", 4, "abc")));
    }

    #[test]
    fn task_events_follow_edits() {
        let tasks = |text: &str| crate::parse::parse(text).tasks;
        let kinds = |old: &str, new: &str, external: bool| {
            task_events(&tasks(old), &tasks(new), external)
                .into_iter()
                .map(|(k, t)| format!("{k:?} {}", t.text))
                .collect::<Vec<_>>()
        };
        // Typing a task in the app logs nothing until it gets its ➕ stamp.
        assert!(kinds("- [ ] Bu\n", "- [ ] Buy milk\n", false).is_empty());
        assert_eq!(
            kinds("- [ ] Buy milk\n", "- [ ] Buy milk ➕ 2026-11-03\n", false),
            ["TaskAdded Buy milk"]
        );
        // From outside, a new task is logged straight away.
        assert_eq!(
            kinds("", "- [ ] From Claude\n", true),
            ["TaskAdded From Claude"]
        );
        // Moving lines around isn't an event; checking one off is.
        assert_eq!(
            kinds(
                "- [ ] A\n- [ ] B 📅 2026-11-04\n",
                "- [ ] B 📅 2026-11-06\n- [x] A ✅ 2026-11-03\n",
                false
            ),
            ["TaskRescheduled B", "TaskDone A"]
        );
        assert_eq!(
            kinds("- [x] A ✅ 2026-11-03\n", "- [ ] A\n", false),
            ["TaskReopened A"]
        );
        assert_eq!(
            kinds("- [ ] A\n", "- [-] A ❌ 2026-11-03\n", false),
            ["TaskCancelled A"]
        );
    }
}
