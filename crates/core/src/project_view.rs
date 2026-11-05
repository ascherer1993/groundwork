//! The project view (PLAN §5.13): a project's events and the people around
//! it. Events are notes with `type: event` or `meeting` (or in `Events/` or a
//! `Meetings` folder); people have `type: person` (or are in `Contacts/`).
//! Either belongs to a project the usual way (§4.6): `projects:` or sitting
//! in its folder.

use std::collections::{BTreeMap, BTreeSet};

use chrono::NaiveDate;
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use crate::index::Index;
use crate::template::TemplateSettings;
use crate::tickets::{ProjectInfo, file_stem, fm_str, note_projects_in};
use crate::{CoreError, Result, Session};

/// A project's events and people.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectView {
    pub project: ProjectInfo,
    /// Newest first; undated ones last.
    pub events: Vec<ProjectEvent>,
    /// By name.
    pub people: Vec<ProjectPerson>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectEvent {
    pub path: String,
    /// The note's name, less a leading date.
    pub title: String,
    /// `YYYY-MM-DD`: its `date:`, else the date its name starts with, else
    /// when it was created.
    pub date: Option<String>,
    pub time: Option<String>,
    /// The people it links to, by name.
    pub people: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectPerson {
    pub path: String,
    pub name: String,
    pub role: Option<String>,
    pub company: Option<String>,
    /// Their own `projects:` names the project.
    pub member: bool,
    /// How many of the project's notes link to them.
    pub mentions: u32,
    /// The date of the latest of the project's events that links to them.
    pub last_seen: Option<String>,
}

fn note_type(fm: Option<&Value>) -> String {
    fm_str(fm, "type").unwrap_or_default().to_lowercase()
}

fn folder_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(f, _)| f)
}

fn is_event(path: &str, fm: Option<&Value>) -> bool {
    let folder = folder_of(path).rsplit('/').next().unwrap_or("");
    matches!(note_type(fm).as_str(), "event" | "meeting")
        || path.starts_with("Events/")
        || folder.eq_ignore_ascii_case("meetings")
}

fn is_person(path: &str, fm: Option<&Value>) -> bool {
    matches!(note_type(fm).as_str(), "person" | "contact") || path.starts_with("Contacts/")
}

/// A `YYYY-MM-DD` at the start of `text`.
fn leading_date(text: &str) -> Option<&str> {
    let head = text.get(..10)?;
    NaiveDate::parse_from_str(head, "%Y-%m-%d").ok()?;
    Some(head)
}

fn event_date(path: &str, fm: Option<&Value>) -> Option<String> {
    let field = |key| fm_str(fm, key).and_then(|d| leading_date(&d).map(str::to_string));
    field("date")
        .or_else(|| leading_date(file_stem(path)).map(str::to_string))
        .or_else(|| field("created"))
}

/// "2026-11-04 Vendor call" → "Vendor call".
fn event_title(path: &str) -> String {
    let stem = file_stem(path);
    match leading_date(stem) {
        Some(d) => {
            let rest = stem[d.len()..]
                .trim_start_matches([' ', '-', '_', '·'])
                .trim();
            if rest.is_empty() { stem } else { rest }.to_string()
        }
        None => stem.to_string(),
    }
}

impl Session {
    /// A project's events and people.
    pub fn project_view(&self, project: &str) -> Result<ProjectView> {
        let config = self.config()?;
        let id = config
            .project(project)
            .map(|p| p.id.clone())
            .ok_or_else(|| CoreError::NotFound(format!("project {project}")))?;
        let info = self
            .project_list()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| CoreError::NotFound(format!("project {project}")))?;
        let templates = format!("{}/", TemplateSettings::read(self.vault().root()).folder);
        let index = self.index();

        let mut people: BTreeMap<String, ProjectPerson> = BTreeMap::new();
        let mut members: Vec<(&str, Option<&Value>)> = Vec::new();
        for (path, note) in index.notes() {
            if path.starts_with(&templates) {
                continue;
            }
            let fm = note.frontmatter.as_ref();
            let belongs = note_projects_in(&index, &config, path).contains(&id);
            if is_person(path, fm) {
                people.insert(
                    path.to_string(),
                    ProjectPerson {
                        path: path.to_string(),
                        name: file_stem(path).to_string(),
                        role: fm_str(fm, "role"),
                        company: fm_str(fm, "company"),
                        member: belongs,
                        mentions: 0,
                        last_seen: None,
                    },
                );
            } else if belongs {
                members.push((path, fm));
            }
        }

        let mut events = Vec::new();
        for (path, fm) in members {
            let linked = person_links(&index, path, &people);
            let event = is_event(path, fm).then(|| ProjectEvent {
                path: path.to_string(),
                title: event_title(path),
                date: event_date(path, fm),
                time: fm_str(fm, "time"),
                people: linked.iter().map(|p| file_stem(p).to_string()).collect(),
            });
            for person in &linked {
                let p = people.get_mut(person).expect("a person");
                p.mentions += 1;
                if let Some(date) = event.as_ref().and_then(|e| e.date.clone())
                    && p.last_seen.as_ref().is_none_or(|seen| *seen < date)
                {
                    p.last_seen = Some(date);
                }
            }
            events.extend(event);
        }
        events.sort_by(|a, b| {
            (a.date.is_none(), &b.date, &b.time, &a.title).cmp(&(
                b.date.is_none(),
                &a.date,
                &a.time,
                &b.title,
            ))
        });
        let mut people: Vec<ProjectPerson> = people
            .into_values()
            .filter(|p| p.member || p.mentions > 0)
            .collect();
        people.sort_by_key(|p| p.name.to_lowercase());
        Ok(ProjectView {
            project: info,
            events,
            people,
        })
    }
}

/// The people a note links to (in its text or frontmatter), each once.
fn person_links(
    index: &Index,
    path: &str,
    people: &BTreeMap<String, ProjectPerson>,
) -> BTreeSet<String> {
    index
        .outgoing(path)
        .into_iter()
        .filter_map(|l| l.resolved)
        .filter(|r| r != path && people.contains_key(r))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_vault::session;

    #[test]
    fn events_are_the_projects_newest_first() {
        let (_dir, s) = session();
        let view = s.project_view("Acme").unwrap();
        assert_eq!(view.project.id, "acme");
        let events: Vec<(&str, Option<&str>)> = view
            .events
            .iter()
            .map(|e| (e.title.as_str(), e.date.as_deref()))
            .collect();
        // Events/ by `projects:`, and the meetings in the project's folder
        // (typed or not); not the offsite, which isn't Acme's.
        assert_eq!(
            events,
            [
                ("Vendor call", Some("2026-11-04")),
                ("Kickoff", Some("2026-11-02")),
                ("Planning", Some("2026-10-28")),
            ]
        );
        let call = &view.events[0];
        assert_eq!(call.path, "Events/2026-11-04 Vendor call.md");
        assert_eq!(call.time.as_deref(), Some("14:00"));
        assert_eq!(call.people, ["Jane Doe", "Sam Lee"]);
    }

    #[test]
    fn people_are_members_and_the_mentioned() {
        let (_dir, s) = session();
        let view = s.project_view("acme").unwrap();
        let people: Vec<(&str, bool, u32, Option<&str>)> = view
            .people
            .iter()
            .map(|p| {
                (
                    p.name.as_str(),
                    p.member,
                    p.mentions,
                    p.last_seen.as_deref(),
                )
            })
            .collect();
        // Jane is on Acme and all over its notes; Sam was only on the call;
        // Priya is on Acme but no note mentions her; Lee isn't Acme's at all.
        assert_eq!(
            people,
            [
                ("Jane Doe", true, 5, Some("2026-11-04")),
                ("Priya Shah", true, 0, None),
                ("Sam Lee", false, 1, Some("2026-11-04")),
            ]
        );
        assert_eq!(view.people[0].role.as_deref(), Some("Staff Engineer"));
    }

    #[test]
    fn dates_and_titles() {
        assert_eq!(
            event_title("Events/2026-11-04 Vendor call.md"),
            "Vendor call"
        );
        assert_eq!(event_title("Events/2026-11-04.md"), "2026-11-04");
        assert_eq!(event_title("Meetings/Standup.md"), "Standup");
        let fm = serde_json::json!({ "date": "2026-01-02T10:00", "created": "2025-01-01" });
        assert_eq!(
            event_date("x/2026-03-04 A.md", Some(&fm)).as_deref(),
            Some("2026-01-02")
        );
        let fm = serde_json::json!({ "created": "2025-01-01 09:00" });
        assert_eq!(
            event_date("x/A.md", Some(&fm)).as_deref(),
            Some("2025-01-01")
        );
        assert_eq!(event_date("x/A.md", None), None);
    }

    #[test]
    fn unknown_projects_are_an_error() {
        let (_dir, s) = session();
        assert!(matches!(
            s.project_view("Nope"),
            Err(CoreError::NotFound(_))
        ));
    }
}
