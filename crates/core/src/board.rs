//! The todo board (PLAN §5.11): a run of days, usually a week, each with its
//! events, the todos due that day and the ones done that day. Open todos that
//! are overdue show on today, so nothing is left behind on a past day.

use chrono::{Duration, Local, NaiveDate};
use serde::Serialize;
use ts_rs::TS;

use crate::Session;
use crate::daily::DailySettings;
use crate::parse::TaskStatus;
use crate::project_view::{ProjectEvent, events_between};
use crate::template::TemplateSettings;
use crate::todos::{self, StatusFilter, Todo, TodoFilter};

/// The most days one board asks for (six weeks, for a month later).
const MAX_DAYS: u32 = 42;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Board {
    /// `YYYY-MM-DD`, as the board was made.
    pub today: String,
    pub days: Vec<BoardDay>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BoardDay {
    pub date: String,
    /// The day's events, by time (untimed first).
    pub events: Vec<ProjectEvent>,
    /// Open todos due that day (or, with no due date, scheduled for it), most
    /// urgent first. Today's also has every overdue one, first.
    pub open: Vec<Todo>,
    /// Todos done that day.
    pub done: Vec<Todo>,
}

impl Session {
    /// `days` days from `from`. `filter` narrows the todos (its status and
    /// due date are ignored); events show only when it's words or a path at
    /// most, and must match them.
    pub fn todo_board(&self, from: NaiveDate, days: u32, filter: &TodoFilter) -> Board {
        self.todo_board_on(from, days, filter, Local::now().date_naive())
    }

    pub(crate) fn todo_board_on(
        &self,
        from: NaiveDate,
        days: u32,
        filter: &TodoFilter,
        today: NaiveDate,
    ) -> Board {
        let count = days.clamp(1, MAX_DAYS);
        let dates: Vec<String> = (0..count)
            .map(|i| (from + Duration::days(i.into())).to_string())
            .collect();
        let mut board: Vec<BoardDay> = dates
            .iter()
            .map(|date| BoardDay {
                date: date.clone(),
                events: Vec::new(),
                open: Vec::new(),
                done: Vec::new(),
            })
            .collect();
        let today_str = today.to_string();
        let slot = |date: &str| dates.iter().position(|d| d == date);

        let index = self.index();
        let daily = DailySettings::read(self.vault().root());
        let wanted = TodoFilter {
            status: Some(StatusFilter::All),
            due: None,
            ..filter.clone()
        };
        // Most urgent first, so each day's open todos are in order.
        for todo in todos::list(&index, &daily, &wanted, today) {
            let task = &todo.task;
            let day = if todo.is_open() {
                match task.due.as_deref().or(task.scheduled.as_deref()) {
                    Some(when) if when < today_str.as_str() => slot(&today_str),
                    Some(when) => slot(when),
                    None => None,
                }
            } else if task.status == TaskStatus::Done {
                task.done.as_deref().and_then(slot)
            } else {
                None
            };
            if let Some(i) = day {
                let list = if todo.is_open() {
                    &mut board[i].open
                } else {
                    &mut board[i].done
                };
                list.push(todo);
            }
        }

        let plain =
            filter.tags.is_empty() && filter.max_priority.is_none() && filter.stale_days.is_none();
        if plain && let (Some(first), Some(last)) = (dates.first(), dates.last()) {
            let templates = format!("{}/", TemplateSettings::read(self.vault().root()).folder);
            for event in events_between(&index, &templates, first, last) {
                let path_ok = filter
                    .path
                    .as_ref()
                    .is_none_or(|p| event.path.to_lowercase().starts_with(&p.to_lowercase()));
                let text_ok = filter
                    .text
                    .as_ref()
                    .is_none_or(|t| event.title.to_lowercase().contains(&t.to_lowercase()));
                if let Some(i) = event.date.as_deref().and_then(slot)
                    && path_ok
                    && text_ok
                {
                    board[i].events.push(event);
                }
            }
        }
        Board {
            today: today_str,
            days: board,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_vault::session;

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn texts(todos: &[Todo]) -> Vec<&str> {
        todos.iter().map(|t| t.task.text.as_str()).collect()
    }

    #[test]
    fn a_week_of_events_and_todos() {
        let (_dir, s) = session();
        let board = s.todo_board_on(d("2026-11-02"), 7, &TodoFilter::default(), d("2026-11-03"));
        let days: Vec<&str> = board.days.iter().map(|d| d.date.as_str()).collect();
        assert_eq!(days[0], "2026-11-02");
        assert_eq!(days.len(), 7);
        let day = |date: &str| board.days.iter().find(|d| d.date == date).unwrap();

        let events = |date: &str| {
            day(date)
                .events
                .iter()
                .map(|e| e.title.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(events("2026-11-02"), ["Kickoff"]);
        assert_eq!(events("2026-11-04"), ["Vendor call"]);
        assert_eq!(day("2026-11-04").events[0].people, ["Jane Doe", "Sam Lee"]);

        assert_eq!(texts(&day("2026-11-03").done), ["Review PR #412"]);
        assert_eq!(
            texts(&day("2026-11-05").open),
            [
                "Ask [[Jane Doe]] about the auth migration",
                "Try the quick switcher"
            ],
            "most urgent first"
        );
        assert!(day("2026-11-03").open.is_empty());
    }

    #[test]
    fn overdue_todos_show_on_today() {
        let (_dir, s) = session();
        let filter = TodoFilter::default();
        let board = s.todo_board_on(d("2026-11-02"), 7, &filter, d("2026-11-07"));
        let day = |date: &str| board.days.iter().find(|d| d.date == date).unwrap();
        assert!(day("2026-11-05").open.is_empty());
        assert_eq!(day("2026-11-07").open.len(), 2);

        // A week without today has no overdue todos at all.
        let board = s.todo_board_on(d("2026-10-26"), 7, &filter, d("2026-11-07"));
        assert!(board.days.iter().all(|d| d.open.is_empty()));
        assert_eq!(board.days[2].events[0].title, "Planning");
    }

    #[test]
    fn the_filter_narrows_todos_and_events() {
        let (_dir, s) = session();
        let today = d("2026-11-03");
        let words = TodoFilter {
            text: Some("switcher".into()),
            ..Default::default()
        };
        let board = s.todo_board_on(d("2026-11-02"), 7, &words, today);
        let open: Vec<&str> = board.days.iter().flat_map(|d| texts(&d.open)).collect();
        assert_eq!(open, ["Try the quick switcher"]);
        assert!(board.days.iter().all(|d| d.events.is_empty()));

        let path = TodoFilter {
            path: Some("projects/acme".into()),
            ..Default::default()
        };
        let board = s.todo_board_on(d("2026-11-02"), 7, &path, today);
        let events: Vec<&str> = board
            .days
            .iter()
            .flat_map(|d| d.events.iter().map(|e| e.title.as_str()))
            .collect();
        assert_eq!(events, ["Kickoff"]);

        let tagged = TodoFilter {
            max_priority: Some(1),
            ..Default::default()
        };
        let board = s.todo_board_on(d("2026-11-02"), 7, &tagged, today);
        assert!(board.days.iter().all(|d| d.events.is_empty()));
    }
}
