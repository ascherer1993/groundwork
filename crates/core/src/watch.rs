//! Watches a vault for changes made outside Groundwork.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};

use crate::tree::is_hidden;
use crate::{CoreError, Result};

pub struct VaultWatcher {
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
}

/// Calls `on_change` with batches of changed vault-relative paths. Hidden
/// paths are dropped (except `.obsidian/app.json`, which holds link settings),
/// and anything inside a `.page` bundle is reported as the bundle itself.
pub fn watch(
    root: &Path,
    on_change: impl Fn(Vec<String>) + Send + 'static,
) -> Result<VaultWatcher> {
    let base: PathBuf = root.to_path_buf();
    let mut debouncer = new_debouncer(
        Duration::from_millis(150),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let paths: BTreeSet<String> = events
                .iter()
                .filter(|e| !matches!(e.kind, EventKind::Access(_)))
                .flat_map(|e| e.paths.iter())
                .filter_map(|p| vault_path(&base, p))
                .collect();
            if !paths.is_empty() {
                on_change(paths.into_iter().collect());
            }
        },
    )
    .map_err(watch_error)?;
    debouncer
        .watch(root, RecursiveMode::Recursive)
        .map_err(watch_error)?;
    Ok(VaultWatcher {
        _debouncer: debouncer,
    })
}

fn watch_error(e: notify::Error) -> CoreError {
    CoreError::Io(std::io::Error::other(e.to_string()))
}

fn vault_path(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        return None;
    }
    if parts == [".obsidian", "app.json"] {
        return Some(parts.join("/"));
    }
    if parts.iter().any(|p| is_hidden(p)) {
        return None;
    }
    let bundle_end = parts[..parts.len() - 1]
        .iter()
        .position(|p| p.to_ascii_lowercase().ends_with(".page"))
        .map(|i| i + 1);
    Some(parts[..bundle_end.unwrap_or(parts.len())].join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn maps_paths() {
        let root = Path::new("/v");
        let p = |s: &str| vault_path(root, Path::new(s));
        assert_eq!(p("/v/A/B.md").as_deref(), Some("A/B.md"));
        assert_eq!(p("/v/d/x.page/js/app.js").as_deref(), Some("d/x.page"));
        assert_eq!(p("/v/d/x.page").as_deref(), Some("d/x.page"));
        assert_eq!(
            p("/v/.obsidian/app.json").as_deref(),
            Some(".obsidian/app.json")
        );
        assert_eq!(p("/v/.obsidian/workspace.json"), None);
        assert_eq!(p("/v/A/.B.md.groundwork-tmp"), None);
        assert_eq!(p("/v"), None);
        assert_eq!(p("/elsewhere/A.md"), None);
    }

    #[test]
    fn reports_external_writes() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let (tx, rx) = mpsc::channel();
        let _watcher = watch(&root, move |paths| {
            let _ = tx.send(paths);
        })
        .unwrap();
        // FSEvents may need a moment to start delivering.
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(root.join("New.md"), "hi").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let paths = rx
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .expect("no watcher event within 5s");
            if paths.contains(&"New.md".to_string()) {
                break;
            }
        }
    }
}
