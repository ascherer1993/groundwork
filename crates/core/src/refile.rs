//! Filing dated notes where today's settings put them (PLAN §5.3, §5.13):
//! daily notes by the daily notes format (`YYYY/MM-MMMM/YYYY-MM-DD` nests
//! them by year and month), and the notes of Quick add choices whose folder
//! has date tags (`Events/{{date:YYYY}}/{{date:MM-MMMM}}`). Changing a
//! setting only places new notes; this moves the ones already written, with
//! their subnotes, rewriting links to them.

use chrono::NaiveDate;
use serde::Serialize;
use ts_rs::TS;

use crate::daily::DailySettings;
use crate::project_view::event_date;
use crate::quickadd::{ChoiceKind, folder_base, render_folder};
use crate::session::FileChange;
use crate::template::{self, TemplateSettings};
use crate::tickets::MovedNote;
use crate::{Result, Session, subnotes};

/// What `refile_dated_notes` moved, or would move.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Refiled {
    pub moved: Vec<MovedNote>,
    /// Left where they are because another note is already at `to`.
    pub blocked: Vec<MovedNote>,
}

fn folder_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(f, _)| f)
}

fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn join(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else {
        format!("{folder}/{name}")
    }
}

impl Session {
    /// Moves daily notes and dated Quick add notes (events) into the folders
    /// their date puts them in now. With `dry_run`, only says what would move.
    pub fn refile_dated_notes(&self, dry_run: bool) -> Result<(Refiled, Vec<FileChange>)> {
        let plan = self.refile_plan()?;
        let mut refiled = Refiled::default();
        for m in plan {
            let case_only = m.from.to_lowercase() == m.to.to_lowercase();
            if self.vault().root().join(&m.to).exists() && !case_only {
                refiled.blocked.push(m);
            } else {
                refiled.moved.push(m);
            }
        }
        let mut changes = Vec::new();
        if dry_run {
            return Ok((refiled, changes));
        }
        for m in &refiled.moved {
            changes.extend(self.rename(&m.from, &m.to)?.1);
        }
        changes.extend(self.trash_emptied_folders(&refiled.moved)?);
        Ok((refiled, changes))
    }

    /// Every dated note that isn't where its date puts it, in path order.
    fn refile_plan(&self) -> Result<Vec<MovedNote>> {
        let root = self.vault().root();
        let daily = DailySettings::read(root);
        let templates = format!("{}/", TemplateSettings::read(root).folder);
        let choices = self.quick_add_choices()?;
        // Choices that file notes by date, with the folder all theirs are in.
        let dated: Vec<(&str, &str)> = choices
            .iter()
            .filter(|c| c.kind == ChoiceKind::Note)
            .filter_map(|c| c.folder.as_deref())
            .filter(|f| template::uses_date(f) && template::prompts(f).is_empty())
            .map(|f| (folder_base(f), f))
            .collect();

        let index = self.index();
        let mut plan: Vec<MovedNote> = Vec::new();
        for (path, note) in index.notes() {
            if path.starts_with(&templates) || subnotes::parent_of(&index, path).is_some() {
                continue;
            }
            let name = name_of(path);
            let stem = name.strip_suffix(".md").unwrap_or(name);
            // A daily note: named for its day, anywhere in the daily notes
            // folder (only right in it when that's the vault's root).
            let in_daily = match daily.folder.as_str() {
                "" => !path.contains('/'),
                folder => path.starts_with(&format!("{folder}/")),
            };
            if in_daily && let Some(date) = daily.date_of(stem) {
                let to = daily.path_for(date);
                if to != path {
                    plan.push(MovedNote {
                        from: path.to_string(),
                        to,
                    });
                }
                continue;
            }
            // A dated choice's note, right in its folder, with a date.
            let fm = note.frontmatter.as_ref();
            let Some((_, pattern)) = dated.iter().find(|(base, _)| folder_of(path) == *base) else {
                continue;
            };
            let Some(date) =
                event_date(path, fm).and_then(|d| NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok())
            else {
                continue;
            };
            let ctx = self.template_context("", Some(date), Default::default());
            let to = join(&render_folder(pattern, &ctx), name);
            if to != path {
                plan.push(MovedNote {
                    from: path.to_string(),
                    to,
                });
            }
        }
        plan.sort_by(|a, b| a.from.cmp(&b.from));
        Ok(plan)
    }

    /// Folders the moves left empty (bar a `.DS_Store`), innermost first,
    /// up to the folder they were filed under.
    fn trash_emptied_folders(&self, moved: &[MovedNote]) -> Result<Vec<FileChange>> {
        let mut left: Vec<&str> = moved.iter().map(|m| folder_of(&m.from)).collect();
        left.sort_by_key(|f| std::cmp::Reverse(f.len()));
        left.dedup();
        let keep: Vec<String> = {
            let daily = DailySettings::read(self.vault().root()).folder;
            let mut keep = vec![daily];
            keep.extend(
                self.quick_add_choices()?
                    .iter()
                    .filter_map(|c| c.folder.as_deref())
                    .map(|f| folder_base(f).to_string()),
            );
            keep
        };
        let mut changes = Vec::new();
        for start in left {
            let mut dir = start.to_string();
            while !dir.is_empty() && !keep.contains(&dir) {
                let full = self.vault().root().join(&dir);
                let empty = std::fs::read_dir(&full)
                    .is_ok_and(|entries| entries.flatten().all(|e| e.file_name() == ".DS_Store"));
                if !empty {
                    break;
                }
                changes.extend(self.delete(&dir)?);
                dir = folder_of(&dir).to_string();
            }
        }
        Ok(changes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daily::DailyFields;
    use crate::daily::DailyNoteSettings;
    use crate::test_vault::session;

    fn by_month(s: &Session) {
        DailyNoteSettings::save(
            s.vault().root(),
            DailyFields {
                folder: Some("Daily".into()),
                format: Some("YYYY/MM-MMMM/YYYY-MM-DD".into()),
                template: Some("Templates/Daily".into()),
            },
        )
        .unwrap();
        let mut choices = s.quick_add_choices().unwrap();
        let event = choices.iter_mut().find(|c| c.name == "Event").unwrap();
        event.folder = Some("Events/{{date:YYYY}}/{{date:MM-MMMM}}".into());
        s.save_quick_add_choices(&choices).unwrap();
    }

    fn moves(r: &Refiled) -> Vec<(&str, &str)> {
        r.moved
            .iter()
            .map(|m| (m.from.as_str(), m.to.as_str()))
            .collect()
    }

    #[test]
    fn nothing_moves_while_the_settings_are_flat() {
        let (_dir, s) = session();
        let (r, _) = s.refile_dated_notes(false).unwrap();
        assert_eq!(r, Refiled::default());
    }

    #[test]
    fn daily_notes_and_events_move_into_year_and_month_folders() {
        let (dir, s) = session();
        by_month(&s);
        let vault = dir.path().join("vault");
        s.create_file(
            "Daily/2026-11-03.wrapup.md",
            Some("Back to [[2026-11-03]].\n"),
        )
        .unwrap();
        s.create_file("Events/Ideas.md", Some("Not dated.\n"))
            .unwrap();

        // A dry run says what would move, and moves nothing.
        let (planned, _) = s.refile_dated_notes(true).unwrap();
        assert!(vault.join("Daily/2026-11-03.md").exists());
        let expected = [
            (
                "Daily/2026-11-03.md",
                "Daily/2026/11-November/2026-11-03.md",
            ),
            (
                "Events/2026-10-20 Offsite.md",
                "Events/2026/10-October/2026-10-20 Offsite.md",
            ),
            (
                "Events/2026-11-04 Vendor call.md",
                "Events/2026/11-November/2026-11-04 Vendor call.md",
            ),
        ];
        assert_eq!(moves(&planned), expected);

        let (done, _) = s.refile_dated_notes(false).unwrap();
        assert_eq!(moves(&done), expected);
        // Subnotes go with their notes; undated notes stay put.
        assert!(
            vault
                .join("Daily/2026/11-November/2026-11-03.wrapup.md")
                .exists()
        );
        assert!(
            vault
                .join("Events/2026/11-November/2026-11-04 Vendor call.transcript.md")
                .exists()
        );
        assert!(vault.join("Events/Ideas.md").exists());
        // Links still reach the moved note: by name, and with a path.
        let sources: Vec<String> = s
            .index()
            .backlinks("Daily/2026/11-November/2026-11-03.md")
            .into_iter()
            .map(|b| b.source)
            .collect();
        for source in ["Welcome.md", "Daily/2026/11-November/2026-11-03.wrapup.md"] {
            assert!(sources.contains(&source.to_string()), "{sources:?}");
        }
        // Run again, there's nothing left to do.
        assert_eq!(s.refile_dated_notes(false).unwrap().0, Refiled::default());
        // The daily notes still count as daily notes.
        assert_eq!(
            s.note_date("Daily/2026/11-November/2026-11-03.md"),
            NaiveDate::from_ymd_opt(2026, 11, 3).unwrap()
        );
    }

    #[test]
    fn a_taken_place_is_left_alone() {
        let (dir, s) = session();
        by_month(&s);
        let vault = dir.path().join("vault");
        s.create_file("Daily/2026/11-November/2026-11-03.md", Some(""))
            .unwrap();
        let (r, _) = s.refile_dated_notes(false).unwrap();
        assert_eq!(r.blocked.len(), 1);
        assert_eq!(r.blocked[0].from, "Daily/2026-11-03.md");
        assert!(vault.join("Daily/2026-11-03.md").exists());
        assert_eq!(r.moved.len(), 2);
    }

    #[test]
    fn changing_the_format_again_empties_the_old_folders() {
        let (dir, s) = session();
        by_month(&s);
        s.refile_dated_notes(false).unwrap();
        DailyNoteSettings::save(
            s.vault().root(),
            DailyFields {
                folder: Some("Daily".into()),
                format: Some("YYYY/MM/YYYY-MM-DD".into()),
                template: None,
            },
        )
        .unwrap();
        let (r, _) = s.refile_dated_notes(false).unwrap();
        assert_eq!(
            moves(&r),
            [(
                "Daily/2026/11-November/2026-11-03.md",
                "Daily/2026/11/2026-11-03.md"
            )]
        );
        assert!(!dir.path().join("vault/Daily/2026/11-November").exists());
        assert!(dir.path().join("vault/Daily/2026/11").exists());
    }
}
