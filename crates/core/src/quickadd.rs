//! Quick add (PLAN §5.13): a menu of ways to make a note (a person, an
//! event…) or add a line to one (a todo in today's note), each asking only
//! what it needs. The choices are the vault's, in `.groundwork/quickadd.yml`;
//! without one, the defaults below.

use std::collections::HashMap;
use std::fs;

use chrono::{Local, NaiveDate};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::config::slugify;
use crate::frontmatter::Prop;
use crate::session::FileChange;
use crate::template::{self, TemplateSettings};
use crate::{CoreError, Result, Session};

const FILE: &str = ".groundwork/quickadd.yml";

/// Templates used when a choice's template isn't in the vault, by file name.
const BUILT_IN: &[(&str, &str)] = &[
    (
        "Person.md",
        "---\ntype: person\ncompany:\nrole:\nprojects: []\n---\n# {{title}}\n\n{{cursor}}\n",
    ),
    (
        "Event.md",
        "---\ntype: event\ndate: {{date}}\npeople: []\nprojects: []\n---\n# {{prompt:Title}}\n\n## Notes\n\n{{cursor}}\n\n## Action items\n\n",
    ),
];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ChoiceKind {
    /// Makes a note from a template.
    #[default]
    Note,
    /// Adds a line to a note.
    Capture,
}

/// One entry in the Quick add menu.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QuickAddChoice {
    pub name: String,
    #[serde(default)]
    pub kind: ChoiceKind,
    /// Note: the folder it goes in (the vault's root if empty).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub folder: Option<String>,
    /// Note: the template's vault path. A missing `Person.md` or `Event.md`
    /// falls back to a built-in one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template: Option<String>,
    /// Note: its name, with template tags (`{{date}} {{prompt:Title}}`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub file_name: Option<String>,
    /// Note: asks which project it's for, and sets `projects:`.
    #[serde(default)]
    pub project: bool,
    /// Capture: `today` (the daily note) or a note's vault path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub to: Option<String>,
    /// Capture: the line added, with template tags (`- [ ] {{prompt:Todo}}`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub format: Option<String>,
}

impl QuickAddChoice {
    /// The id its keyboard shortcut is saved under.
    pub fn id(&self) -> String {
        slugify(&self.name)
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    choices: Vec<QuickAddChoice>,
}

/// What a choice asks before it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QuickAddForm {
    /// The `{{prompt:…}}` labels, in order.
    pub prompts: Vec<String>,
    /// Whether it uses a date, so it asks for one (today by default).
    pub date: bool,
    /// Whether it asks for a project.
    pub project: bool,
    /// The project offered first: the one the note you're in belongs to.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_project: Option<String>,
}

/// What a choice made or added to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickAdded {
    pub path: String,
    /// Byte offset of `{{cursor}}` in a new note.
    pub cursor: Option<usize>,
    /// Whether it made a note (rather than adding to one).
    pub created: bool,
    pub changes: Vec<FileChange>,
}

/// The defaults: a person, an event and a todo for today.
pub fn default_choices(templates: &TemplateSettings) -> Vec<QuickAddChoice> {
    let template = |name: &str| Some(format!("{}/{name}", templates.folder));
    vec![
        QuickAddChoice {
            name: "Person".into(),
            folder: Some("Contacts".into()),
            template: template("Person.md"),
            file_name: Some("{{prompt:Name}}".into()),
            project: true,
            ..Default::default()
        },
        QuickAddChoice {
            name: "Event".into(),
            folder: Some("Events".into()),
            template: template("Event.md"),
            file_name: Some("{{date}} {{prompt:Title}}".into()),
            project: true,
            ..Default::default()
        },
        QuickAddChoice {
            name: "Todo".into(),
            kind: ChoiceKind::Capture,
            to: Some("today".into()),
            format: Some("- [ ] {{prompt:Todo}}".into()),
            ..Default::default()
        },
    ]
}

/// Characters a note's name can't have (in Obsidian, or in a link).
fn clean_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' | '[' | ']' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim_matches(['.', ' ', '-']);
    if cleaned.is_empty() {
        "Untitled".into()
    } else {
        cleaned.to_string()
    }
}

impl Session {
    /// The vault's Quick add choices, or the defaults when it has none.
    pub fn quick_add_choices(&self) -> Result<Vec<QuickAddChoice>> {
        let path = self.vault().root().join(FILE);
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(default_choices(&TemplateSettings::read(
                    self.vault().root(),
                )));
            }
            Err(e) => return Err(e.into()),
        };
        let file: File =
            serde_saphyr::from_str(&text).map_err(|e| CoreError::Config(format!("{FILE}: {e}")))?;
        Ok(file.choices)
    }

    /// Saves the choices to `.groundwork/quickadd.yml`.
    pub fn save_quick_add_choices(&self, choices: &[QuickAddChoice]) -> Result<()> {
        let mut seen: Vec<String> = Vec::new();
        for c in choices {
            if c.name.trim().is_empty() {
                return Err(CoreError::InvalidPath("every choice needs a name".into()));
            }
            if seen.contains(&c.id()) {
                return Err(CoreError::Conflict(format!(
                    "there are two choices named {:?}",
                    c.name
                )));
            }
            seen.push(c.id());
        }
        let text = serde_saphyr::to_string(&File {
            choices: choices.to_vec(),
        })
        .map_err(|e| CoreError::Config(e.to_string()))?;
        let full = self.vault().root().join(FILE);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(
            full,
            format!("# Quick add choices (Settings → Quick add).\n{text}"),
        )?;
        Ok(())
    }

    fn quick_add_choice(&self, name: &str) -> Result<QuickAddChoice> {
        let wanted = slugify(name);
        self.quick_add_choices()?
            .into_iter()
            .find(|c| c.id() == wanted)
            .ok_or_else(|| CoreError::NotFound(format!("no Quick add choice {name:?}")))
    }

    /// A choice's template: the vault's, else a built-in one, else nothing.
    fn choice_template(&self, choice: &QuickAddChoice) -> Result<String> {
        let Some(path) = choice.template.as_deref().filter(|t| !t.trim().is_empty()) else {
            return Ok(String::new());
        };
        match self.read_template(path) {
            Err(CoreError::NotFound(_)) => {
                let name = path.rsplit('/').next().unwrap_or(path);
                BUILT_IN
                    .iter()
                    .find(|(n, _)| *n == name)
                    .map(|(_, text)| text.to_string())
                    .ok_or_else(|| CoreError::NotFound(format!("the template {path} is missing")))
            }
            other => other,
        }
    }

    /// What a choice asks for. `note` is where you are, for the project
    /// offered first.
    pub fn quick_add_form(&self, name: &str, note: Option<&str>) -> Result<QuickAddForm> {
        let choice = self.quick_add_choice(name)?;
        let (prompts, date) = match choice.kind {
            ChoiceKind::Note => {
                let pattern = choice.file_name.clone().unwrap_or_default();
                let source = self.choice_template(&choice)?;
                let mut prompts = template::prompts(&pattern);
                for p in template::prompts(&source) {
                    if !prompts.contains(&p) {
                        prompts.push(p);
                    }
                }
                let date = template::uses_date(&pattern) || template::uses_date(&source);
                (prompts, date)
            }
            ChoiceKind::Capture => {
                let format = choice.format.clone().unwrap_or_default();
                (template::prompts(&format), false)
            }
        };
        let project = choice.kind == ChoiceKind::Note && choice.project;
        let default_project = match (project, note) {
            (true, Some(note)) => {
                let config = self.config()?;
                self.note_projects(&config, note).into_iter().next()
            }
            _ => None,
        };
        Ok(QuickAddForm {
            prompts,
            date,
            project,
            default_project,
        })
    }

    /// Runs a choice with the answers to its form.
    pub fn quick_add(
        &self,
        name: &str,
        answers: HashMap<String, String>,
        date: Option<NaiveDate>,
        project: Option<&str>,
    ) -> Result<QuickAdded> {
        let choice = self.quick_add_choice(name)?;
        match choice.kind {
            ChoiceKind::Note => self.quick_add_note(&choice, answers, date, project),
            ChoiceKind::Capture => self.quick_add_capture(&choice, answers),
        }
    }

    fn quick_add_note(
        &self,
        choice: &QuickAddChoice,
        answers: HashMap<String, String>,
        date: Option<NaiveDate>,
        project: Option<&str>,
    ) -> Result<QuickAdded> {
        let project = match project.filter(|p| !p.is_empty()) {
            Some(p) => Some(
                self.config()?
                    .project(p)
                    .cloned()
                    .ok_or_else(|| CoreError::NotFound(format!("no project {p:?}")))?,
            ),
            None => None,
        };
        let folder = choice
            .folder
            .as_deref()
            .unwrap_or("")
            .trim_matches('/')
            .to_string();
        let pattern = choice.file_name.as_deref().unwrap_or("{{prompt:Name}}");
        let ctx = self.template_context(&folder, date, answers.clone());
        let base = clean_name(&template::render(pattern, &ctx).text);
        let path = self.available_path(&folder, &base, ".md");
        let source = self.choice_template(choice)?;
        let (cursor, mut changes) = self.create_from_source(&source, &path, date, answers)?;
        let mut cursor = cursor;
        if let Some(project) = &project {
            let full = self.vault().resolve(&path)?;
            let before = fs::metadata(&full)?.len() as usize;
            changes.extend(self.set_properties(
                &path,
                &[(
                    "projects",
                    Some(Prop::List(vec![self.project_link(project, &path)])),
                )],
            )?);
            // The frontmatter is above the cursor: it moves by what was added.
            let after = fs::metadata(&full)?.len() as usize;
            cursor = cursor.map(|c| (c + after).saturating_sub(before));
        }
        Ok(QuickAdded {
            path,
            cursor,
            created: true,
            changes,
        })
    }

    fn quick_add_capture(
        &self,
        choice: &QuickAddChoice,
        answers: HashMap<String, String>,
    ) -> Result<QuickAdded> {
        let mut changes = Vec::new();
        let to = choice.to.as_deref().unwrap_or("today").trim();
        let path = if to.is_empty() || to == "today" {
            let (path, created) = self.daily_note(Local::now().date_naive())?;
            changes.extend(created);
            path
        } else {
            let path = if to.ends_with(".md") {
                to.to_string()
            } else {
                format!("{to}.md")
            };
            // `create_file` checks the path is a new one inside the vault.
            if !self.vault().root().join(&path).exists() {
                changes.extend(self.create_file(&path, None)?);
            }
            path
        };
        let format = choice.format.as_deref().unwrap_or("{{prompt:Text}}");
        let ctx = self.template_context(&path, None, answers);
        let line = template::render(format, &ctx).text;
        // A todo goes where `todo add` puts them, with its stamp.
        if let Some(task) = line.trim().strip_prefix("- [ ] ") {
            changes.extend(self.add_task(Some(&path), task, None, 3)?.1);
            return Ok(QuickAdded {
                path,
                cursor: None,
                created: false,
                changes,
            });
        }
        let mut text = fs::read_to_string(self.vault().resolve(&path)?)?;
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(line.trim_end_matches('\n'));
        text.push('\n');
        changes.extend(self.write_file(&path, &text)?.1);
        Ok(QuickAdded {
            path,
            cursor: None,
            created: false,
            changes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daily::DailySettings;

    use crate::test_vault::session;

    fn read(dir: &tempfile::TempDir, path: &str) -> String {
        fs::read_to_string(dir.path().join("vault").join(path)).unwrap()
    }

    #[test]
    fn without_a_file_the_defaults_are_offered() {
        let (_dir, s) = session();
        let names: Vec<String> = s
            .quick_add_choices()
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, ["Person", "Event", "Todo"]);
    }

    #[test]
    fn an_event_asks_for_a_title_a_date_and_the_project_youre_in() {
        let (_dir, s) = session();
        let form = s
            .quick_add_form(
                "event",
                Some("Projects/Acme/Meetings/2026-11-02 Kickoff.md"),
            )
            .unwrap();
        assert_eq!(form.prompts, ["Title"]);
        assert!(form.date && form.project);
        assert_eq!(form.default_project.as_deref(), Some("acme"));
        // A person's note is named by its prompt; no date to ask for.
        let form = s.quick_add_form("Person", Some("Welcome.md")).unwrap();
        assert_eq!(form.prompts, ["Name"]);
        assert!(!form.date && form.default_project.is_none());
    }

    #[test]
    fn an_event_is_made_in_events_with_its_project() {
        let (dir, s) = session();
        let date = NaiveDate::from_ymd_opt(2026, 11, 6);
        let added = s
            .quick_add(
                "Event",
                HashMap::from([("Title".into(), "Design review: v2".into())]),
                date,
                Some("Acme"),
            )
            .unwrap();
        assert_eq!(added.path, "Events/2026-11-06 Design review- v2.md");
        let text = read(&dir, &added.path);
        assert!(text.contains("type: event\ndate: 2026-11-06\n"), "{text}");
        assert!(text.contains("projects: [\"[[Acme]]\"]"), "{text}");
        assert!(text.contains("# Design review: v2\n"), "{text}");
        // The cursor is still at `{{cursor}}`, below the changed frontmatter.
        let cursor = added.cursor.unwrap();
        assert!(text[..cursor].ends_with("## Notes\n\n"), "{text}");
        // Its project is now one it belongs to.
        let config = s.config().unwrap();
        assert_eq!(s.note_projects(&config, &added.path), ["acme"]);
    }

    #[test]
    fn the_vaults_own_template_wins_and_names_dont_clash() {
        let (dir, s) = session();
        fs::write(
            dir.path().join("vault/Templates/Person.md"),
            "---\ntype: person\nteam: {{prompt:Team}}\n---\n",
        )
        .unwrap();
        let answers = HashMap::from([
            ("Name".to_string(), "Jane Doe".to_string()),
            ("Team".to_string(), "Auth".to_string()),
        ]);
        assert_eq!(
            s.quick_add_form("person", None).unwrap().prompts,
            ["Name", "Team"]
        );
        // Jane Doe is already in Contacts.
        let added = s.quick_add("person", answers, None, None).unwrap();
        assert_eq!(added.path, "Contacts/Jane Doe 1.md");
        assert!(read(&dir, &added.path).contains("team: Auth\n"));
    }

    #[test]
    fn a_todo_is_added_to_todays_note() {
        let (dir, s) = session();
        let added = s
            .quick_add(
                "Todo",
                HashMap::from([("Todo".into(), "Call Jane".into())]),
                None,
                None,
            )
            .unwrap();
        assert!(!added.created);
        assert!(
            added
                .path
                .starts_with(&DailySettings::read(&dir.path().join("vault")).folder)
        );
        // Under the note's todos heading, stamped as `todo add` does.
        let text = read(&dir, &added.path);
        assert!(text.contains("## Todos\n"), "{text}");
        assert!(text.contains("\n- [ ] Call Jane ➕ "), "{text}");
    }

    #[test]
    fn choices_are_saved_in_the_vault() {
        let (dir, s) = session();
        let mut choices = s.quick_add_choices().unwrap();
        choices.push(QuickAddChoice {
            name: "Idea".into(),
            kind: ChoiceKind::Capture,
            to: Some("Ideas".into()),
            format: Some("- {{prompt:Idea}}".into()),
            ..Default::default()
        });
        s.save_quick_add_choices(&choices).unwrap();
        assert_eq!(s.quick_add_choices().unwrap(), choices);
        assert!(read(&dir, FILE).contains("name: Idea"));
        let added = s
            .quick_add(
                "idea",
                HashMap::from([("Idea".into(), "Dark mode".into())]),
                None,
                None,
            )
            .unwrap();
        assert_eq!(added.path, "Ideas.md");
        // A note it adds to is made if need be, like any new note.
        let ideas = read(&dir, "Ideas.md");
        assert!(ideas.starts_with("---\ncreated: "), "{ideas}");
        assert!(ideas.ends_with("---\n- Dark mode\n"), "{ideas}");
        // Two with one name can't both have a shortcut.
        choices.push(choices[0].clone());
        assert!(s.save_quick_add_choices(&choices).is_err());
    }
}
