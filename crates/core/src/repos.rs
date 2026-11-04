//! Where each repo in `repos.yml` lives on this machine: its main checkout
//! and the folder its worktrees go in. Machine-local, so it's kept per vault
//! in the data folder (`vaults/<key>/repos.json`), never in the vault.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::session::atomic_write;
use crate::workspaces::expand_home;
use crate::{CoreError, Result, git};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RepoLocation {
    /// The main checkout.
    pub path: String,
    /// The folder worktrees are made in.
    pub worktrees: String,
}

impl RepoLocation {
    pub fn path(&self) -> &Path {
        Path::new(&self.path)
    }

    pub fn worktree(&self, name: &str) -> PathBuf {
        Path::new(&self.worktrees).join(name)
    }
}

pub struct RepoLocations {
    file: PathBuf,
    lock: Mutex<()>,
}

impl RepoLocations {
    pub fn new(state_dir: &Path) -> Self {
        Self {
            file: state_dir.join("repos.json"),
            lock: Mutex::new(()),
        }
    }

    pub fn all(&self) -> BTreeMap<String, RepoLocation> {
        fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn get(&self, id: &str) -> Option<RepoLocation> {
        self.all().remove(id)
    }

    /// Like [`get`](Self::get), but an error that asks for the repo to be located.
    pub fn require(&self, id: &str) -> Result<RepoLocation> {
        self.get(id)
            .ok_or_else(|| CoreError::RepoNotLocated(id.to_string()))
    }

    /// Records where `id` is checked out. `worktrees` defaults to a
    /// `<repo>-worktrees` folder beside it, made when the first worktree is.
    pub fn locate(&self, id: &str, path: &str, worktrees: Option<&str>) -> Result<RepoLocation> {
        let checkout = expand_home(path.trim());
        if !checkout.is_absolute() || !git::is_repo(&checkout) {
            return Err(CoreError::InvalidPath(format!(
                "no git repo at {}",
                checkout.display()
            )));
        }
        let checkout = git::toplevel(&checkout).unwrap_or(checkout);
        let checkout = fs::canonicalize(&checkout)?;
        let worktrees = match worktrees.map(str::trim).filter(|w| !w.is_empty()) {
            Some(w) => {
                let w = expand_home(w);
                if !w.is_absolute() {
                    return Err(CoreError::InvalidPath(format!(
                        "not an absolute folder: {}",
                        w.display()
                    )));
                }
                fs::canonicalize(&w).unwrap_or(w)
            }
            None => default_worktrees(&checkout),
        };
        let location = RepoLocation {
            path: checkout.display().to_string(),
            worktrees: worktrees.display().to_string(),
        };
        let _guard = self.lock.lock().unwrap();
        let mut all = self.all();
        all.insert(id.to_string(), location.clone());
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir)?;
        }
        atomic_write(&self.file, &serde_json::to_string_pretty(&all)?)?;
        Ok(location)
    }
}

/// `<repo>-worktrees` beside the checkout.
pub fn default_worktrees(checkout: &Path) -> PathBuf {
    let name = checkout
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into());
    checkout.with_file_name(format!("{name}-worktrees"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repos_are_located_once_per_machine() {
        let dir = tempfile::tempdir().unwrap();
        let repo = git::tests::repo_with_origin(dir.path());
        let store = RepoLocations::new(&dir.path().join("state"));
        assert!(matches!(
            store.require("acme"),
            Err(CoreError::RepoNotLocated(_))
        ));
        assert!(
            store
                .locate("acme", dir.path().to_str().unwrap(), None)
                .is_err()
        );

        // Any folder inside the checkout finds its top.
        fs::create_dir_all(repo.join("apps/web")).unwrap();
        let inside = repo.join("apps/web");
        let location = store
            .locate("acme", inside.to_str().unwrap(), None)
            .unwrap();
        assert_eq!(location.path(), repo);
        assert_eq!(
            location.worktrees,
            repo.with_file_name("repo-worktrees").display().to_string()
        );
        assert_eq!(store.require("acme").unwrap(), location);
        assert_eq!(
            location.worktree("T-1"),
            repo.with_file_name("repo-worktrees/T-1")
        );

        let other = dir.path().join("trees");
        let moved = store
            .locate(
                "acme",
                repo.to_str().unwrap(),
                Some(other.to_str().unwrap()),
            )
            .unwrap();
        assert_eq!(moved.worktrees, other.display().to_string());
        assert!(
            store
                .locate("acme", repo.to_str().unwrap(), Some("rel"))
                .is_err()
        );
    }
}
