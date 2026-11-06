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
    /// The note it belongs to, which links back with `workspace:`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
    /// Its tabs and splits, as the app saved them (dockview's layout).
    #[serde(default)]
    #[ts(type = "unknown")]
    pub layout: Value,
    /// One of [`COLORS`], marking it in the list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// Kept at the top of the list.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub pinned: bool,
}

/// The colours a workspace can have (the app has a shade of each for light and dark).
pub const COLORS: [&str; 8] = [
    "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink",
];

/// What to change about a workspace; `None` leaves it as it is.
#[derive(Debug, Default)]
pub struct WorkspaceChange<'a> {
    pub name: Option<&'a str>,
    pub cwd: Option<&'a str>,
    /// `""` takes the colour away.
    pub color: Option<&'a str>,
    pub pinned: Option<bool>,
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

    /// In the order they were created, or as they've been moved.
    pub fn list(&self) -> Vec<Workspace> {
        fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn create(&self, name: &str, cwd: &str) -> Result<Workspace> {
        self.create_for(name, cwd, None)
    }

    /// A workspace belonging to `note`.
    pub fn create_for(&self, name: &str, cwd: &str, note: Option<&str>) -> Result<Workspace> {
        let _guard = self.lock.lock().unwrap();
        let workspace = Workspace {
            id: new_id(name),
            name: valid_name(name)?,
            cwd: valid_folder(cwd)?,
            note: note.map(str::to_string),
            layout: Value::Null,
            color: None,
            pinned: false,
        };
        let mut all = self.list();
        all.push(workspace.clone());
        self.save(&all)?;
        Ok(workspace)
    }

    pub fn update(&self, id: &str, change: &WorkspaceChange) -> Result<Workspace> {
        self.change(id, |w| {
            if let Some(name) = change.name {
                w.name = valid_name(name)?;
            }
            if let Some(cwd) = change.cwd {
                w.cwd = valid_folder(cwd)?;
            }
            match change.color {
                Some("") => w.color = None,
                Some(color) if COLORS.contains(&color) => w.color = Some(color.to_string()),
                Some(color) => {
                    return Err(CoreError::InvalidPath(format!("no colour called {color}")));
                }
                None => {}
            }
            if let Some(pinned) = change.pinned {
                w.pinned = pinned;
            }
            Ok(())
        })
    }

    /// Moves a workspace to just before `before`, or to the end. Returns the list.
    pub fn move_before(&self, id: &str, before: Option<&str>) -> Result<Vec<Workspace>> {
        let _guard = self.lock.lock().unwrap();
        let mut all = self.list();
        let from = all
            .iter()
            .position(|w| w.id == id)
            .ok_or_else(|| CoreError::NotFound(format!("workspace {id}")))?;
        let moving = all.remove(from);
        let to = match before {
            Some(before) => all
                .iter()
                .position(|w| w.id == before)
                .ok_or_else(|| CoreError::NotFound(format!("workspace {before}")))?,
            None => all.len(),
        };
        all.insert(to, moving);
        self.save(&all)?;
        Ok(all)
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

/// A typed folder with a leading `~` meaning the home folder.
pub fn expand_home(path: &str) -> PathBuf {
    let rest = match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => rest,
        _ => return PathBuf::from(path),
    };
    match std::env::var_os("HOME") {
        Some(home) => PathBuf::from(format!("{}{rest}", home.to_string_lossy())),
        None => PathBuf::from(path),
    }
}

/// The folder's real path, as shells report it (`/var` is `/private/var`).
fn valid_folder(cwd: &str) -> Result<String> {
    let path = expand_home(cwd.trim());
    if !path.is_absolute() || !path.is_dir() {
        return Err(CoreError::InvalidPath(format!("no folder at {cwd}")));
    }
    Ok(fs::canonicalize(&path)?.display().to_string())
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
        let renamed = store
            .update(
                &a.id,
                &WorkspaceChange {
                    name: Some("Acme API"),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(renamed.layout["grid"], 1);
        let names: Vec<_> = store.list().into_iter().map(|w| w.name).collect();
        assert_eq!(names, ["Acme API", "Spike"]);

        assert!(store.create("  ", cwd).is_err());
        assert!(store.create("X", "relative").is_err());
        let folder = WorkspaceChange {
            cwd: Some("/no/such/folder"),
            ..Default::default()
        };
        assert!(store.update(&b.id, &folder).is_err());
        assert!(matches!(
            store.delete("ws-nope"),
            Err(CoreError::NotFound(_))
        ));

        store.delete(&a.id).unwrap();
        assert_eq!(store.list(), [b]);
    }

    #[test]
    fn workspaces_are_coloured_pinned_and_moved() {
        let state = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let cwd = folder.path().to_str().unwrap();
        let store = Workspaces::new(state.path());
        let a = store.create("A", cwd).unwrap();
        let b = store.create("B", cwd).unwrap();
        let c = store.create("C", cwd).unwrap();

        let style = WorkspaceChange {
            color: Some("teal"),
            pinned: Some(true),
            ..Default::default()
        };
        let styled = store.update(&b.id, &style).unwrap();
        assert_eq!(styled.color.as_deref(), Some("teal"));
        assert!(styled.pinned);
        let plain = WorkspaceChange {
            color: Some(""),
            ..Default::default()
        };
        assert_eq!(store.update(&b.id, &plain).unwrap().color, None);
        let odd = WorkspaceChange {
            color: Some("chartreuse"),
            ..Default::default()
        };
        assert!(store.update(&b.id, &odd).is_err());
        // Unset, they aren't written at all.
        let saved = fs::read_to_string(state.path().join("workspaces.json")).unwrap();
        assert_eq!(saved.matches("pinned").count(), 1);
        assert!(!saved.contains("color"));

        let names = |list: Vec<Workspace>| list.into_iter().map(|w| w.name).collect::<Vec<_>>();
        assert_eq!(
            names(store.move_before(&c.id, Some(&a.id)).unwrap()),
            ["C", "A", "B"]
        );
        assert_eq!(
            names(store.move_before(&c.id, None).unwrap()),
            ["A", "B", "C"]
        );
        assert_eq!(
            names(store.move_before(&a.id, Some(&c.id)).unwrap()),
            ["B", "A", "C"]
        );
        assert_eq!(names(store.list()), ["B", "A", "C"]);
        assert!(store.move_before("ws-nope", None).is_err());
        assert!(store.move_before(&a.id, Some("ws-nope")).is_err());
    }

    #[test]
    fn a_leading_tilde_is_the_home_folder() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand_home("~"), PathBuf::from(&home));
        assert_eq!(expand_home("~/dev"), PathBuf::from(format!("{home}/dev")));
        assert_eq!(expand_home("~bob/dev"), PathBuf::from("~bob/dev"));
        assert_eq!(expand_home("/tmp/~"), PathBuf::from("/tmp/~"));
        let canonical = fs::canonicalize(&home).unwrap();
        assert_eq!(
            valid_folder(" ~ ").unwrap(),
            canonical.display().to_string()
        );
    }
}
