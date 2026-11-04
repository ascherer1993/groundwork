use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use ts_rs::TS;

use crate::tree::{self, NodeKind, TreeNode};
use crate::{CoreError, Result};

/// Files larger than this are not loaded into the viewer.
const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Vault {
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VaultInfo {
    pub name: String,
    /// Absolute path to the vault folder.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileContent {
    pub path: String,
    pub kind: NodeKind,
    pub size: u64,
    /// UTF-8 text for notes, pages and text files; absent for binary files.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl Vault {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let root =
            fs::canonicalize(path).map_err(|_| CoreError::NotFound(path.display().to_string()))?;
        if !root.is_dir() {
            return Err(CoreError::NotADirectory(root));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn name(&self) -> String {
        self.root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.root.display().to_string())
    }

    pub fn info(&self) -> VaultInfo {
        VaultInfo {
            name: self.name(),
            path: self.root.display().to_string(),
        }
    }

    pub fn tree(&self) -> Result<TreeNode> {
        tree::build(&self.root)
    }

    /// Resolves a vault-relative path to an existing file or folder, refusing
    /// anything that lands outside the vault (`..`, absolute paths, symlinks
    /// pointing elsewhere).
    pub fn resolve(&self, rel: &str) -> Result<PathBuf> {
        let rel_path = Path::new(rel);
        if rel_path
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err(CoreError::OutsideVault(rel.to_string()));
        }
        let full = fs::canonicalize(self.root.join(rel_path))
            .map_err(|_| CoreError::NotFound(rel.to_string()))?;
        if !full.starts_with(&self.root) {
            return Err(CoreError::OutsideVault(rel.to_string()));
        }
        Ok(full)
    }

    pub fn read_file(&self, rel: &str) -> Result<FileContent> {
        let full = self.resolve(rel)?;
        let name = full
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let kind = tree::classify(&name, full.is_dir());
        let file = match kind {
            NodeKind::Folder => return Err(CoreError::NotFound(rel.to_string())),
            NodeKind::PageBundle => {
                let index = full.join("index.html");
                if !index.is_file() {
                    return Err(CoreError::NotFound(format!("{rel}/index.html")));
                }
                index
            }
            _ => full,
        };
        let size = fs::metadata(&file)?.len();
        let text = match kind {
            NodeKind::Note | NodeKind::Page | NodeKind::PageBundle => {
                if size > MAX_READ_BYTES {
                    return Err(CoreError::TooLarge { size });
                }
                Some(String::from_utf8_lossy(&fs::read(&file)?).into_owned())
            }
            // Data files (CSV, JSON, …) that pages read: text if it's UTF-8.
            NodeKind::Asset if size <= MAX_READ_BYTES => String::from_utf8(fs::read(&file)?)
                .ok()
                .filter(|t| !t.contains('\0')),
            _ => None,
        };
        Ok(FileContent {
            path: rel.to_string(),
            kind,
            size,
            text,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Vault {
        Vault::open(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/vault")).unwrap()
    }

    fn names(node: &TreeNode) -> Vec<&str> {
        node.children
            .as_ref()
            .unwrap()
            .iter()
            .map(|n| n.name.as_str())
            .collect()
    }

    fn child<'a>(node: &'a TreeNode, name: &str) -> &'a TreeNode {
        node.children
            .as_ref()
            .unwrap()
            .iter()
            .find(|n| n.name == name)
            .unwrap_or_else(|| panic!("missing {name}"))
    }

    #[test]
    fn tree_hides_dotfiles_and_sorts_folders_first() {
        let tree = fixture().tree().unwrap();
        let top = names(&tree);
        assert!(!top.iter().any(|n| n.starts_with('.')), "{top:?}");
        assert_eq!(
            top,
            ["Contacts", "Daily", "Projects", "Templates", "Welcome.md"]
        );
    }

    #[test]
    fn page_bundles_are_leaves() {
        let tree = fixture().tree().unwrap();
        let demos = child(child(child(&tree, "Projects"), "Acme"), "demos");
        let bundle = child(demos, "login-flow.page");
        assert_eq!(bundle.kind, NodeKind::PageBundle);
        assert!(bundle.children.is_none());
        assert_eq!(bundle.path, "Projects/Acme/demos/login-flow.page");
        assert_eq!(child(demos, "sketch.html").kind, NodeKind::Page);
    }

    #[test]
    fn reads_notes_bundles_and_text_files() {
        let vault = fixture();
        let note = vault.read_file("Welcome.md").unwrap();
        assert_eq!(note.kind, NodeKind::Note);
        assert!(note.text.unwrap().contains("Welcome"));

        let bundle = vault
            .read_file("Projects/Acme/demos/login-flow.page")
            .unwrap();
        assert_eq!(bundle.kind, NodeKind::PageBundle);
        assert!(bundle.text.unwrap().contains("<html"));

        // Text data files have text; binary files don't.
        let csv = vault.read_file("Projects/Acme/demos/timings.csv").unwrap();
        assert_eq!(
            csv.text.as_deref(),
            Some("step,ms\nlogin,120\nrefresh,40\n")
        );
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.bin"), [0u8, 159, 146, 150]).unwrap();
        let binary = Vault::open(dir.path()).unwrap().read_file("a.bin").unwrap();
        assert_eq!(binary.text, None);
    }

    #[test]
    fn refuses_paths_outside_the_vault() {
        let vault = fixture();
        for rel in ["../vault/Welcome.md", "/etc/hosts", "Daily/../../x"] {
            assert!(
                matches!(vault.resolve(rel), Err(CoreError::OutsideVault(_))),
                "{rel}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_that_escape_the_vault() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.md"), "secret").unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.md"), dir.path().join("link.md"))
            .unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        assert!(matches!(
            vault.read_file("link.md"),
            Err(CoreError::OutsideVault(_))
        ));
    }

    #[test]
    fn missing_files_are_not_found() {
        assert!(matches!(
            fixture().read_file("Nope.md"),
            Err(CoreError::NotFound(_))
        ));
    }
}
