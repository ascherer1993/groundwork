//! Workspaces: named sets of terminal tabs and splits, with a folder new
//! terminals start in. They hold absolute paths and running terminals, so
//! they're machine-local: kept per vault in the data folder, not the vault.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::session::atomic_write;
use crate::{CoreError, Result};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// The absolute folder new terminals start in.
    pub cwd: String,
    /// Its tabs and splits, as the app saved them (dockview's layout).
    #[serde(default)]
    #[ts(type = "unknown")]
    pub layout: Value,
}

pub struct Workspaces {
    file: PathBuf,
    /// Serializes read-modify-write.
    lock: Mutex<()>,
}

impl Workspaces {
    /// Workspaces kept in `state_dir` (a vault's folder in the data folder).
    pub fn new(state_dir: &Path) -> Self {
        Self {
            file: state_dir.join("workspaces.json"),
            lock: Mutex::new(()),
        }
    }

    /// In the order they were created.
    pub fn list(&self) -> Vec<Workspace> {
        fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn create(&self, name: &str, cwd: &str) -> Result<Workspace> {
        let _guard = self.lock.lock().unwrap();
        let workspace = Workspace {
            id: new_id(name),
            name: valid_name(name)?,
            cwd: valid_folder(cwd)?,
            layout: Value::Null,
        };
        let mut all = self.list();
        all.push(workspace.clone());
        self.save(&all)?;
        Ok(workspace)
    }

    pub fn update(&self, id: &str, name: Option<&str>, cwd: Option<&str>) -> Result<Workspace> {
        self.change(id, |w| {
            if let Some(name) = name {
                w.name = valid_name(name)?;
            }
            if let Some(cwd) = cwd {
                w.cwd = valid_folder(cwd)?;
            }
            Ok(())
        })
    }

    pub fn save_layout(&self, id: &str, layout: Value) -> Result<()> {
        self.change(id, |w| {
            w.layout = layout;
            Ok(())
        })
        .map(drop)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let _guard = self.lock.lock().unwrap();
        let mut all = self.list();
        let before = all.len();
        all.retain(|w| w.id != id);
        if all.len() == before {
            return Err(CoreError::NotFound(format!("workspace {id}")));
        }
        self.save(&all)
    }

    fn change(
        &self,
        id: &str,
        apply: impl FnOnce(&mut Workspace) -> Result<()>,
    ) -> Result<Workspace> {
        let _guard = self.lock.lock().unwrap();
        let mut all = self.list();
        let workspace = all
            .iter_mut()
            .find(|w| w.id == id)
            .ok_or_else(|| CoreError::NotFound(format!("workspace {id}")))?;
        apply(workspace)?;
        let changed = workspace.clone();
        self.save(&all)?;
        Ok(changed)
    }

    fn save(&self, all: &[Workspace]) -> Result<()> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir)?;
        }
        atomic_write(&self.file, &serde_json::to_string_pretty(all)?)
    }
}

fn valid_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CoreError::InvalidPath("a workspace needs a name".into()));
    }
    Ok(name.to_string())
}

/// The folder's real path, as shells report it (`/var` is `/private/var`).
fn valid_folder(cwd: &str) -> Result<String> {
    let path = Path::new(cwd);
    if !path.is_absolute() || !path.is_dir() {
        return Err(CoreError::InvalidPath(format!("no folder at {cwd}")));
    }
    Ok(fs::canonicalize(path)?.display().to_string())
}

fn new_id(name: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let hash = blake3::hash(format!("{nanos}:{name}:{}", std::process::id()).as_bytes());
    format!("ws-{}", &hash.to_hex()[..8])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspaces_are_created_changed_and_deleted() {
        let state = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let cwd = folder.path().to_str().unwrap();
        let store = Workspaces::new(&state.path().join("vaults/abc"));
        assert!(store.list().is_empty());

        let a = store.create(" Acme ", cwd).unwrap();
        let b = store.create("Spike", &format!("{cwd}/.")).unwrap();
        assert_eq!(a.name, "Acme");
        let real = fs::canonicalize(folder.path()).unwrap();
        assert_eq!(b.cwd, real.display().to_string());
        assert!(a.id.starts_with("ws-") && a.id != b.id);

        store
            .save_layout(&a.id, serde_json::json!({ "grid": 1 }))
            .unwrap();
        let renamed = store.update(&a.id, Some("Acme API"), None).unwrap();
        assert_eq!(renamed.layout["grid"], 1);
        let names: Vec<_> = store.list().into_iter().map(|w| w.name).collect();
        assert_eq!(names, ["Acme API", "Spike"]);

        assert!(store.create("  ", cwd).is_err());
        assert!(store.create("X", "relative").is_err());
        assert!(store.update(&b.id, None, Some("/no/such/folder")).is_err());
        assert!(matches!(
            store.delete("ws-nope"),
            Err(CoreError::NotFound(_))
        ));

        store.delete(&a.id).unwrap();
        assert_eq!(store.list(), [b]);
    }
}
