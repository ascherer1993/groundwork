//! Daily notes settings: Groundwork's own (`daily_notes:` in
//! `.groundwork/config.yml`, set in Settings), falling back field by field to
//! Obsidian's (`.obsidian/daily-notes.json`, read-only), then the defaults.

use std::{fs, path::Path};

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::frontmatter::{self, Prop};
use crate::{CoreError, Result, moment};

const DEFAULT_FORMAT: &str = "YYYY-MM-DD";
const CONFIG: &str = ".groundwork/config.yml";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DailySettings {
    /// Vault-relative folder; empty for the root.
    pub folder: String,
    /// moment.js format; may contain `/` to nest notes in subfolders.
    pub format: String,
    /// Vault-relative template path, without `.md` as Obsidian stores it.
    pub template: Option<String>,
}

impl Default for DailySettings {
    fn default() -> Self {
        Self {
            folder: String::new(),
            format: DEFAULT_FORMAT.into(),
            template: None,
        }
    }
}

/// Daily notes settings as one source has them; `None` falls through to the
/// next source.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default)]
#[ts(export)]
pub struct DailyFields {
    /// Vault-relative folder; `""` for the vault's root.
    pub folder: Option<String>,
    pub format: Option<String>,
    /// Vault-relative template path, with or without `.md`.
    pub template: Option<String>,
}

impl DailyFields {
    /// Trimmed, with surrounding slashes and a template's `.md` taken off.
    /// Empty format and template mean unset; an empty folder is the root.
    fn clean(self) -> Self {
        let trim = |s: String| s.trim().trim_matches('/').to_string();
        Self {
            folder: self.folder.map(trim),
            format: self
                .format
                .map(|f| f.trim().to_string())
                .filter(|f| !f.is_empty()),
            template: self
                .template
                .map(|t| {
                    let t = trim(t);
                    t.strip_suffix(".md").map(str::to_string).unwrap_or(t)
                })
                .filter(|t| !t.is_empty()),
        }
    }

    fn is_empty(&self) -> bool {
        self.folder.is_none() && self.format.is_none() && self.template.is_none()
    }
}

/// Both sources, for Settings to show what's set where.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DailyNoteSettings {
    /// Groundwork's own; these win.
    pub groundwork: DailyFields,
    /// Obsidian's, used for whatever Groundwork's leave unset.
    pub obsidian: DailyFields,
    /// Where today's note goes with both put together.
    pub today_path: String,
}

impl DailyNoteSettings {
    pub fn read(root: &Path) -> Self {
        let groundwork = groundwork_fields(root);
        let obsidian = obsidian_fields(root);
        let today_path = DailySettings::combine(groundwork.clone(), obsidian.clone())
            .path_for(chrono::Local::now().date_naive());
        Self {
            groundwork,
            obsidian,
            today_path,
        }
    }

    /// Saves Groundwork's settings in `.groundwork/config.yml`, leaving the
    /// rest of the file as written. All unset removes `daily_notes:`.
    pub fn save(root: &Path, fields: DailyFields) -> Result<Self> {
        let fields = fields.clean();
        if let Some(folder) = &fields.folder
            && (folder.starts_with('~') || folder.split('/').any(|p| p == ".." || p == "."))
        {
            return Err(CoreError::InvalidPath(format!(
                "the daily notes folder must be inside the vault: {folder}"
            )));
        }
        let path = root.join(CONFIG);
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        let value = (!fields.is_empty()).then(|| {
            Prop::Map(
                [
                    ("folder", &fields.folder),
                    ("format", &fields.format),
                    ("template", &fields.template),
                ]
                .into_iter()
                .filter_map(|(k, v)| Some((k.to_string(), v.clone()?)))
                .collect(),
            )
        });
        let updated = frontmatter::set_in_yaml(&text, &[("daily_notes", value)]);
        if updated != text {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&path, updated)?;
        }
        Ok(Self::read(root))
    }
}

/// `daily_notes:` in Groundwork's config. A config that doesn't parse is
/// reported where the rest of it is used; daily notes fall back meanwhile.
fn groundwork_fields(root: &Path) -> DailyFields {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct File {
        daily_notes: Option<DailyFields>,
    }
    fs::read_to_string(root.join(CONFIG))
        .ok()
        .and_then(|t| serde_saphyr::from_str::<File>(&t).ok())
        .and_then(|f| f.daily_notes)
        .unwrap_or_default()
        .clean()
}

fn obsidian_fields(root: &Path) -> DailyFields {
    let fields: DailyFields = fs::read(root.join(".obsidian/daily-notes.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut fields = fields.clean();
    // Obsidian writes `"folder": ""` for the root; that's its default, not a
    // choice to stand for, but it means the same either way.
    if fields.folder.as_deref() == Some("") {
        fields.folder = None;
    }
    fields
}

impl DailySettings {
    pub fn read(root: &Path) -> Self {
        Self::combine(groundwork_fields(root), obsidian_fields(root))
    }

    /// Groundwork's settings over Obsidian's, over the defaults.
    fn combine(groundwork: DailyFields, obsidian: DailyFields) -> Self {
        Self {
            folder: groundwork.folder.or(obsidian.folder).unwrap_or_default(),
            format: groundwork
                .format
                .or(obsidian.format)
                .unwrap_or_else(|| DEFAULT_FORMAT.into()),
            template: groundwork.template.or(obsidian.template),
        }
    }

    /// The vault path of the daily note for `date`.
    pub fn path_for(&self, date: NaiveDate) -> String {
        let name = format!("{}.md", moment::format(date, &self.format));
        if self.folder.is_empty() {
            name
        } else {
            format!("{}/{name}", self.folder)
        }
    }

    /// The date a link or note name refers to, if it's a daily note name.
    /// Accepts the full formatted name or, for nested formats like
    /// `YYYY/MM/YYYY-MM-DD`, just the last segment (what `[[…]]` shows).
    pub fn date_of(&self, name: &str) -> Option<NaiveDate> {
        let name = name.strip_suffix(".md").unwrap_or(name);
        moment::parse(name, &self.format).or_else(|| {
            let (_, last) = self.format.rsplit_once('/')?;
            moment::parse(name, last)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn reads_fixture_settings() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/vault");
        let s = DailySettings::read(&root);
        assert_eq!(s.folder, "Daily");
        assert_eq!(s.format, "YYYY-MM-DD");
        assert_eq!(s.template.as_deref(), Some("Templates/Daily"));
        assert_eq!(s.path_for(d(2026, 11, 2)), "Daily/2026-11-02.md");
    }

    #[test]
    fn missing_file_uses_obsidian_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let s = DailySettings::read(dir.path());
        assert_eq!(s, DailySettings::default());
        assert_eq!(s.path_for(d(2026, 1, 5)), "2026-01-05.md");
    }

    #[test]
    fn nested_formats_match_by_last_segment() {
        let s = DailySettings {
            folder: "Journal".into(),
            format: "YYYY/MM/YYYY-MM-DD".into(),
            template: None,
        };
        assert_eq!(s.date_of("2026-11-02"), Some(d(2026, 11, 2)));
        assert_eq!(s.date_of("2026/11/2026-11-02"), Some(d(2026, 11, 2)));
        assert_eq!(s.path_for(d(2026, 11, 2)), "Journal/2026/11/2026-11-02.md");
        assert_eq!(s.date_of("Kickoff"), None);
    }

    fn vault_with(obsidian: Option<&str>, config: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        if let Some(json) = obsidian {
            fs::create_dir_all(dir.path().join(".obsidian")).unwrap();
            fs::write(dir.path().join(".obsidian/daily-notes.json"), json).unwrap();
        }
        if let Some(yaml) = config {
            fs::create_dir_all(dir.path().join(".groundwork")).unwrap();
            fs::write(dir.path().join(CONFIG), yaml).unwrap();
        }
        dir
    }

    #[test]
    fn groundwork_settings_win_field_by_field() {
        let dir = vault_with(
            Some(
                r#"{"folder": "Obsidian/Daily", "format": "DD-MM-YYYY", "template": "Templates/Day"}"#,
            ),
            Some("work_folder: Work\ndaily_notes:\n  folder: Journal/\n"),
        );
        let s = DailySettings::read(dir.path());
        assert_eq!(s.folder, "Journal");
        assert_eq!(s.format, "DD-MM-YYYY");
        assert_eq!(s.template.as_deref(), Some("Templates/Day"));
        assert_eq!(s.path_for(d(2026, 11, 9)), "Journal/09-11-2026.md");
    }

    #[test]
    fn groundwork_alone_is_enough() {
        let dir = vault_with(
            None,
            Some("daily_notes:\n  folder: Daily\n  template: Templates/Daily.md\n"),
        );
        let s = DailySettings::read(dir.path());
        assert_eq!(s.path_for(d(2026, 11, 9)), "Daily/2026-11-09.md");
        assert_eq!(s.template.as_deref(), Some("Templates/Daily"));
        // An empty folder is the root, on purpose, over Obsidian's.
        let dir = vault_with(
            Some(r#"{"folder": "Days"}"#),
            Some("daily_notes:\n  folder: \"\"\n"),
        );
        assert_eq!(DailySettings::read(dir.path()).folder, "");
    }

    #[test]
    fn saving_keeps_the_rest_of_the_config() {
        let config = "# Vault settings.\nwork_folder: Work\n\nactions: []\n";
        let dir = vault_with(Some(r#"{"folder": "Old", "format": ""}"#), Some(config));
        let saved = DailyNoteSettings::save(
            dir.path(),
            DailyFields {
                folder: Some(" Daily/ ".into()),
                format: Some("".into()),
                template: None,
            },
        )
        .unwrap();
        assert_eq!(saved.groundwork.folder.as_deref(), Some("Daily"));
        assert_eq!(saved.groundwork.format, None);
        assert_eq!(saved.obsidian.folder.as_deref(), Some("Old"));
        assert_eq!(
            fs::read_to_string(dir.path().join(CONFIG)).unwrap(),
            format!("{config}daily_notes:\n  folder: Daily\n")
        );
        assert_eq!(DailySettings::read(dir.path()).folder, "Daily");

        // Clearing every field takes the section out again.
        DailyNoteSettings::save(dir.path(), DailyFields::default()).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join(CONFIG)).unwrap(), config);
        assert_eq!(DailySettings::read(dir.path()).folder, "Old");
    }

    #[test]
    fn the_folder_must_be_inside_the_vault() {
        let dir = vault_with(None, None);
        let bad = |f: &str| DailyFields {
            folder: Some(f.into()),
            ..Default::default()
        };
        assert!(DailyNoteSettings::save(dir.path(), bad("../Elsewhere")).is_err());
        assert!(DailyNoteSettings::save(dir.path(), bad("~/Notes")).is_err());
        assert!(!dir.path().join(CONFIG).exists());
        // A vault without a config gets one.
        DailyNoteSettings::save(dir.path(), bad("Daily")).unwrap();
        assert_eq!(DailySettings::read(dir.path()).folder, "Daily");
    }
}
