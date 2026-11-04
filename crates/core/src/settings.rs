//! App-wide settings that belong to this machine, not a vault: for now, the
//! keyboard shortcuts you've changed.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::Result;

const FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AppSettings {
    /// Shortcuts changed from their defaults, by command id: a key
    /// combination like `Ctrl+Cmd+1`, or `null` for none.
    #[serde(default)]
    #[ts(type = "Record<string, string | null>")]
    pub keys: BTreeMap<String, Option<String>>,
}

pub struct Settings {
    file: PathBuf,
}

impl Settings {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            file: data_dir.join(FILE_NAME),
        }
    }

    /// The saved settings; the defaults if there are none or they can't be read.
    pub fn get(&self) -> AppSettings {
        fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn set(&self, settings: &AppSettings) -> Result<()> {
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = self.file.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(settings)?)?;
        fs::rename(tmp, &self.file)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings::new(dir.path());
        assert_eq!(settings.get(), AppSettings::default());
        let mut changed = AppSettings::default();
        changed
            .keys
            .insert("view.terminal".into(), Some("Ctrl+Cmd+T".into()));
        changed.keys.insert("tab.close".into(), None);
        settings.set(&changed).unwrap();
        assert_eq!(settings.get(), changed);
        // A file that doesn't parse reads as the defaults.
        fs::write(dir.path().join(FILE_NAME), "{").unwrap();
        assert_eq!(settings.get(), AppSettings::default());
    }
}
