//! HTML pages: where their state is kept, and the vault's page settings.
//!
//! A page is a single `.html` file or a `.page` bundle. Pages save state
//! through the bridge (`groundwork.state`), as JSON in the vault so it
//! travels with it and Claude can read it:
//! - a bundle keeps it in `foo.page/state.json`
//! - a single file keeps it in `.groundwork/page-state/<path>.json`

use std::fs;
use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

use crate::tree::{NodeKind, classify};
use crate::{CoreError, Result};

/// A bundle's state file, at its top level.
pub const BUNDLE_STATE: &str = "state.json";
/// Where single-file pages keep state.
const STATE_DIR: &str = ".groundwork/page-state";

/// The page a vault path belongs to: the `.page` bundle that contains it (or
/// is it), or the path itself for an `.html` file. `None` for anything else.
pub fn page_of(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').collect();
    if let Some(i) = parts
        .iter()
        .position(|p| classify(p, true) == NodeKind::PageBundle)
    {
        return Some(parts[..=i].join("/"));
    }
    let name = parts.last()?;
    (classify(name, false) == NodeKind::Page).then(|| path.to_string())
}

/// Vault path of a page's state file. `page` must be a page (see [`page_of`]).
pub fn state_path(page: &str) -> String {
    if is_bundle(page) {
        format!("{page}/{BUNDLE_STATE}")
    } else {
        format!("{STATE_DIR}/{page}.json")
    }
}

/// The page whose state file is at `path`, if it is one.
pub fn page_for_state_path(path: &str) -> Option<String> {
    if let Some(page) = path.strip_prefix(&format!("{STATE_DIR}/")) {
        let page = page.strip_suffix(".json")?;
        return (classify(page.rsplit('/').next()?, false) == NodeKind::Page)
            .then(|| page.to_string());
    }
    let page = path.strip_suffix(&format!("/{BUNDLE_STATE}"))?;
    is_bundle(page).then(|| page.to_string())
}

fn is_bundle(page: &str) -> bool {
    let name = page.rsplit('/').next().unwrap_or(page);
    classify(name, true) == NodeKind::PageBundle
}

/// A page's saved state; `null` when it has none.
pub fn read_state(root: &Path, page: &str) -> Result<Value> {
    match fs::read(root.join(state_path(page))) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
            CoreError::Conflict(format!("{} isn't valid JSON: {e}", state_path(page)))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.into()),
    }
}

/// Saves a page's state, pretty-printed so it reads well in a diff.
pub(crate) fn write_state(root: &Path, page: &str, state: &Value) -> Result<()> {
    let full = root.join(state_path(page));
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut text = serde_json::to_string_pretty(state)?;
    text.push('\n');
    crate::session::atomic_write(&full, &text)
}

/// Moves a single-file page's state along with the page. Bundles carry
/// theirs inside, so there's nothing to do for them.
pub(crate) fn move_state(root: &Path, from: &str, to: &str) {
    if is_bundle(from) || page_of(from).as_deref() != Some(from) {
        return;
    }
    let old = root.join(state_path(from));
    if !old.exists() {
        return;
    }
    let new = root.join(state_path(to));
    if let Some(parent) = new.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::rename(old, new);
}

/// Page settings, from `pages:` in `.groundwork/config.yml`.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct PageSettings {
    /// Whether pages may load and fetch from the network.
    pub allow_network: bool,
}

impl Default for PageSettings {
    fn default() -> Self {
        Self {
            allow_network: true,
        }
    }
}

impl PageSettings {
    pub fn read(root: &Path) -> Self {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Config {
            pages: PageSettings,
        }
        fs::read_to_string(root.join(".groundwork/config.yml"))
            .ok()
            .and_then(|text| serde_saphyr::from_str::<Config>(&text).ok())
            .unwrap_or_default()
            .pages
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/vault");

    #[test]
    fn finds_the_page_a_file_belongs_to() {
        assert_eq!(page_of("d/x.page").as_deref(), Some("d/x.page"));
        assert_eq!(page_of("d/x.page/js/app.js").as_deref(), Some("d/x.page"));
        assert_eq!(page_of("d/sketch.html").as_deref(), Some("d/sketch.html"));
        assert_eq!(page_of("d/Note.md"), None);
        assert_eq!(page_of("d/data.csv"), None);
    }

    #[test]
    fn state_files_map_both_ways() {
        for (page, state) in [
            ("d/x.page", "d/x.page/state.json"),
            ("d/sketch.html", ".groundwork/page-state/d/sketch.html.json"),
        ] {
            assert_eq!(state_path(page), state);
            assert_eq!(page_for_state_path(state).as_deref(), Some(page));
        }
        assert_eq!(page_for_state_path("d/x.page/data/state.json"), None);
        assert_eq!(
            page_for_state_path(".groundwork/page-state/notes.json"),
            None
        );
        assert_eq!(page_for_state_path("d/state.json"), None);
    }

    #[test]
    fn state_round_trips_and_moves_with_the_page() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(read_state(root, "a.html").unwrap(), Value::Null);
        write_state(root, "a.html", &json!({ "picked": [1, 2] })).unwrap();
        assert_eq!(
            read_state(root, "a.html").unwrap(),
            json!({ "picked": [1, 2] })
        );
        let text = fs::read_to_string(root.join(".groundwork/page-state/a.html.json")).unwrap();
        assert_eq!(text, "{\n  \"picked\": [\n    1,\n    2\n  ]\n}\n");

        move_state(root, "a.html", "Archive/b.html");
        assert_eq!(read_state(root, "a.html").unwrap(), Value::Null);
        assert_eq!(
            read_state(root, "Archive/b.html").unwrap(),
            json!({ "picked": [1, 2] })
        );

        fs::create_dir(root.join("x.page")).unwrap();
        write_state(root, "x.page", &json!(true)).unwrap();
        assert!(root.join("x.page/state.json").exists());
    }

    #[test]
    fn reads_page_settings() {
        assert!(PageSettings::read(Path::new(FIXTURE)).allow_network);
        let dir = tempfile::tempdir().unwrap();
        assert!(PageSettings::read(dir.path()).allow_network);
        fs::create_dir(dir.path().join(".groundwork")).unwrap();
        fs::write(
            dir.path().join(".groundwork/config.yml"),
            "pages:\n  allow_network: false\ntrackers: []\n",
        )
        .unwrap();
        assert!(!PageSettings::read(dir.path()).allow_network);
    }
}
