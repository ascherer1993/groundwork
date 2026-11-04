//! Obsidian's daily notes settings (`.obsidian/daily-notes.json`, read-only).

use std::{fs, path::Path};

use chrono::NaiveDate;
use serde::Deserialize;

use crate::moment;

const DEFAULT_FORMAT: &str = "YYYY-MM-DD";

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

impl DailySettings {
    pub fn read(root: &Path) -> Self {
        #[derive(Deserialize, Default)]
        struct Json {
            folder: Option<String>,
            format: Option<String>,
            template: Option<String>,
        }
        let json: Json = fs::read(root.join(".obsidian/daily-notes.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let clean = |s: String| s.trim().trim_matches('/').to_string();
        Self {
            folder: json.folder.map(clean).unwrap_or_default(),
            format: json
                .format
                .map(|f| f.trim().to_string())
                .filter(|f| !f.is_empty())
                .unwrap_or_else(|| DEFAULT_FORMAT.into()),
            template: json.template.map(clean).filter(|t| !t.is_empty()),
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
}
