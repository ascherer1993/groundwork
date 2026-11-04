//! The git operations tickets need, through the `git` command so they behave
//! exactly as they would in a terminal (hooks, config, credentials).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use ts_rs::TS;

use crate::{CoreError, Result};

fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| CoreError::Git(format!("couldn't run git: {e}")))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string())
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        let err = err.trim();
        Err(CoreError::Git(if err.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            err.strip_prefix("fatal: ").unwrap_or(err).to_string()
        }))
    }
}

fn succeeds(dir: &Path, args: &[&str]) -> bool {
    git(dir, args).is_ok()
}

/// The top of the checkout holding `dir`, if it's in one.
pub fn toplevel(dir: &Path) -> Option<PathBuf> {
    git(dir, &["rev-parse", "--show-toplevel"])
        .ok()
        .map(PathBuf::from)
}

pub fn is_repo(dir: &Path) -> bool {
    dir.is_dir() && toplevel(dir).is_some()
}

fn has_ref(repo: &Path, name: &str) -> bool {
    succeeds(repo, &["rev-parse", "--verify", "--quiet", name])
}

/// What new branches start from: `origin/<base>` when there's a remote copy
/// (so a stale local base doesn't matter), else the local branch.
fn base_ref(repo: &Path, base: &str) -> String {
    let remote = format!("refs/remotes/origin/{base}");
    if has_ref(repo, &remote) {
        format!("origin/{base}")
    } else {
        base.to_string()
    }
}

/// Adds a worktree at `path` on `branch`: the existing local branch, else a
/// new one tracking `origin/<branch>`, else a new one from `base`.
pub fn add_worktree(repo: &Path, path: &Path, branch: &str, base: &str) -> Result<()> {
    if path.exists() {
        return Err(CoreError::AlreadyExists(path.display().to_string()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let target = path.to_string_lossy();
    if has_ref(repo, &format!("refs/heads/{branch}")) {
        git(repo, &["worktree", "add", &target, branch])?;
    } else if has_ref(repo, &format!("refs/remotes/origin/{branch}")) {
        let remote = format!("origin/{branch}");
        git(
            repo,
            &["worktree", "add", "--track", "-b", branch, &target, &remote],
        )?;
    } else {
        let from = base_ref(repo, base);
        if !has_ref(repo, &from) {
            return Err(CoreError::Git(format!(
                "the base branch {base} doesn't exist"
            )));
        }
        git(
            repo,
            &[
                "worktree",
                "add",
                "--no-track",
                "-b",
                branch,
                &target,
                &from,
            ],
        )?;
    }
    Ok(())
}

/// Removes a worktree. `force` discards uncommitted changes.
pub fn remove_worktree(repo: &Path, path: &Path, force: bool) -> Result<()> {
    let target = path.to_string_lossy();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&target);
    git(repo, &args)?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub path: PathBuf,
    /// `None` when detached.
    pub branch: Option<String>,
}

/// Every worktree of `repo` except its main checkout.
pub fn worktrees(repo: &Path) -> Result<Vec<Worktree>> {
    let out = git(repo, &["worktree", "list", "--porcelain"])?;
    let mut list = Vec::new();
    for block in out.split("\n\n") {
        let mut path = None;
        let mut branch = None;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(p));
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            }
        }
        if let Some(path) = path {
            list.push(Worktree { path, branch });
        }
    }
    // The first is the main checkout.
    Ok(list.into_iter().skip(1).collect())
}

/// What closing a worktree would lose, and how far it is from its base.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitState {
    /// Whether the worktree exists on disk.
    pub exists: bool,
    pub branch: Option<String>,
    /// Uncommitted changes, untracked files included.
    pub dirty: bool,
    /// Commits not on any remote branch.
    pub unpushed: u32,
    /// Whether `origin/<branch>` exists.
    pub on_remote: bool,
    /// Commits on the base branch that this branch doesn't have.
    pub behind: u32,
}

impl GitState {
    /// Why removing the worktree would lose work, if it would.
    pub fn warnings(&self) -> Vec<String> {
        let mut warnings = Vec::new();
        if !self.exists {
            return warnings;
        }
        if self.dirty {
            warnings.push("it has uncommitted changes".into());
        }
        if self.unpushed > 0 {
            warnings.push(match self.unpushed {
                1 => "1 commit isn't pushed".into(),
                n => format!("{n} commits aren't pushed"),
            });
        } else if !self.on_remote {
            warnings.push("its branch isn't on the remote".into());
        }
        warnings
    }
}

fn count(dir: &Path, args: &[&str]) -> u32 {
    git(dir, args)
        .ok()
        .and_then(|n| n.trim().parse().ok())
        .unwrap_or(0)
}

pub fn state(worktree: &Path, base: &str) -> GitState {
    if !worktree.is_dir() {
        return GitState::default();
    }
    let branch = git(worktree, &["symbolic-ref", "--short", "-q", "HEAD"]).ok();
    let dirty = git(worktree, &["status", "--porcelain"]).is_ok_and(|s| !s.trim().is_empty());
    let on_remote = branch
        .as_deref()
        .is_some_and(|b| has_ref(worktree, &format!("refs/remotes/origin/{b}")));
    let unpushed = count(
        worktree,
        &["rev-list", "--count", "HEAD", "--not", "--remotes"],
    );
    let base = base_ref(worktree, base);
    let behind = count(worktree, &["rev-list", "--count", &format!("HEAD..{base}")]);
    GitState {
        exists: true,
        branch,
        dirty,
        unpushed,
        on_remote,
        behind,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;

    /// A repo with one commit on `main`, and a bare `origin` it's pushed to.
    pub(crate) fn repo_with_origin(dir: &Path) -> PathBuf {
        let origin = dir.join("origin.git");
        let repo = dir.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let run = |dir: &Path, args: &[&str]| git(dir, args).unwrap();
        run(dir, &["init", "-q", "--bare", "-b", "main", "origin.git"]);
        run(&repo, &["init", "-q", "-b", "main"]);
        run(&repo, &["config", "user.email", "test@example.com"]);
        run(&repo, &["config", "user.name", "Test"]);
        run(&repo, &["config", "commit.gpgsign", "false"]);
        fs::write(repo.join("README.md"), "hi\n").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-q", "-m", "first"]);
        run(
            &repo,
            &["remote", "add", "origin", &origin.to_string_lossy()],
        );
        run(&repo, &["push", "-q", "-u", "origin", "main"]);
        fs::canonicalize(repo).unwrap()
    }

    #[test]
    fn worktrees_are_added_inspected_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_with_origin(dir.path());
        assert!(is_repo(&repo));
        assert!(!is_repo(dir.path()));
        let wt = dir.path().join("repo-worktrees/T-1-fix");

        add_worktree(&repo, &wt, "T-1-fix", "main").unwrap();
        assert!(wt.join("README.md").is_file());
        let list = worktrees(&repo).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].branch.as_deref(), Some("T-1-fix"));
        assert!(add_worktree(&repo, &wt, "T-1-fix", "main").is_err());

        // A fresh branch: nothing to lose but it isn't on the remote.
        let fresh = state(&wt, "main");
        assert!(fresh.exists && !fresh.dirty && fresh.unpushed == 0 && !fresh.on_remote);
        assert_eq!(fresh.warnings(), ["its branch isn't on the remote"]);

        fs::write(wt.join("new.txt"), "x").unwrap();
        assert!(state(&wt, "main").dirty);
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "work"]).unwrap();
        let committed = state(&wt, "main");
        assert_eq!(committed.unpushed, 1);
        assert_eq!(committed.warnings(), ["1 commit isn't pushed"]);
        git(&wt, &["push", "-q", "-u", "origin", "T-1-fix"]).unwrap();
        let pushed = state(&wt, "main");
        assert!(pushed.on_remote && pushed.warnings().is_empty());

        // Main moves on.
        fs::write(repo.join("more.txt"), "y").unwrap();
        git(&repo, &["add", "."]).unwrap();
        git(&repo, &["commit", "-q", "-m", "more"]).unwrap();
        git(&repo, &["push", "-q"]).unwrap();
        assert_eq!(state(&wt, "main").behind, 1);

        remove_worktree(&repo, &wt, false).unwrap();
        assert!(!wt.exists());
        assert!(worktrees(&repo).unwrap().is_empty());
        assert_eq!(state(&wt, "main"), GitState::default());

        // Restoring uses the existing branch.
        add_worktree(&repo, &wt, "T-1-fix", "main").unwrap();
        assert!(wt.join("new.txt").is_file());

        // A dirty worktree needs force.
        fs::write(wt.join("scratch.txt"), "z").unwrap();
        assert!(remove_worktree(&repo, &wt, false).is_err());
        remove_worktree(&repo, &wt, true).unwrap();

        // Only on the remote: tracked from there.
        git(&repo, &["branch", "-q", "-D", "T-1-fix"]).unwrap();
        add_worktree(&repo, &wt, "T-1-fix", "main").unwrap();
        assert!(wt.join("new.txt").is_file());
        assert!(state(&wt, "main").on_remote);

        let err = add_worktree(&repo, &dir.path().join("x"), "x", "nope").unwrap_err();
        assert!(err.to_string().contains("nope"), "{err}");
    }
}
