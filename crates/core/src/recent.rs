//! The machine-local list of recently opened vaults.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{Result, VaultInfo};

const MAX_RECENT: usize = 10;
const FILE_NAME: &str = "recent-vaults.json";

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecentVault {
    pub name: String,
    pub path: String,
    /// Milliseconds since the Unix epoch.
    pub last_opened: u64,
    /// Whether the folder still exists on this machine; recomputed on every read.
    #[serde(default)]
    pub exists: bool,
}

pub struct RecentVaults {
    file: PathBuf,
}

impl RecentVaults {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            file: data_dir.join(FILE_NAME),
        }
    }

    pub fn list(&self) -> Vec<RecentVault> {
        let mut items: Vec<RecentVault> = fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        for item in &mut items {
            item.exists = Path::new(&item.path).is_dir();
        }
        items
    }

    /// Moves `vault` to the front of the list.
    pub fn touch(&self, vault: &VaultInfo) -> Result<()> {
        let mut items = self.list();
        items.retain(|v| v.path != vault.path);
        items.insert(
            0,
            RecentVault {
                name: vault.name.clone(),
                path: vault.path.clone(),
                last_opened: now_millis(),
                exists: true,
            },
        );
        items.truncate(MAX_RECENT);
        self.save(&items)
    }

    pub fn remove(&self, path: &str) -> Result<()> {
        let mut items = self.list();
        items.retain(|v| v.path != path);
        self.save(&items)
    }

    fn save(&self, items: &[RecentVault]) -> Result<()> {
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = self.file.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(items)?)?;
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

    fn info(path: &Path) -> VaultInfo {
        VaultInfo {
            name: path.file_name().unwrap().to_string_lossy().into_owned(),
            path: path.display().to_string(),
        }
    }

    #[test]
    fn touch_dedupes_and_orders_most_recent_first() {
        let data = tempfile::tempdir().unwrap();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let recent = RecentVaults::new(data.path());

        recent.touch(&info(a.path())).unwrap();
        recent.touch(&info(b.path())).unwrap();
        recent.touch(&info(a.path())).unwrap();

        let list = recent.list();
        let paths: Vec<_> = list.iter().map(|v| v.path.clone()).collect();
        assert_eq!(
            paths,
            [
                a.path().display().to_string(),
                b.path().display().to_string()
            ]
        );
        assert!(list.iter().all(|v| v.exists));
    }

    #[test]
    fn missing_folders_are_flagged() {
        let data = tempfile::tempdir().unwrap();
        let recent = RecentVaults::new(data.path());
        let gone = tempfile::tempdir().unwrap();
        let gone_info = info(gone.path());
        drop(gone);
        recent.touch(&gone_info).unwrap();
        assert!(!recent.list()[0].exists);
    }
}
