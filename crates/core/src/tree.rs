use std::cmp::Ordering;
use std::fs;
use std::path::Path;

use serde::Serialize;
use ts_rs::TS;

use crate::Result;

/// What a vault entry is, as far as Groundwork is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NodeKind {
    Folder,
    /// A Markdown note (`.md`).
    Note,
    /// A single-file HTML page (`.html`).
    Page,
    /// A folder named `*.page` containing an `index.html`, shown as one item.
    PageBundle,
    /// Anything else: images, PDFs, data files.
    Asset,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TreeNode {
    pub name: String,
    /// Vault-relative path with `/` separators; empty for the vault root.
    pub path: String,
    pub kind: NodeKind,
    /// Present for folders only.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
}

pub(crate) fn classify(name: &str, is_dir: bool) -> NodeKind {
    let lower = name.to_ascii_lowercase();
    if is_dir {
        if lower.ends_with(".page") {
            NodeKind::PageBundle
        } else {
            NodeKind::Folder
        }
    } else if lower.ends_with(".md") {
        NodeKind::Note
    } else if lower.ends_with(".html") || lower.ends_with(".htm") {
        NodeKind::Page
    } else {
        NodeKind::Asset
    }
}

/// Dotfiles and dot-folders (`.obsidian`, `.groundwork`, `.git`, `.trash`) are
/// not part of the visible vault.
pub(crate) fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

pub(crate) fn build(root: &Path) -> Result<TreeNode> {
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(TreeNode {
        name,
        path: String::new(),
        kind: NodeKind::Folder,
        children: Some(read_children(root, "")?),
    })
}

fn read_children(dir: &Path, rel: &str) -> Result<Vec<TreeNode>> {
    let mut nodes = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        // Follows symlinks, so a linked folder shows up as a folder.
        let Ok(meta) = fs::metadata(entry.path()) else {
            continue;
        };
        let kind = classify(&name, meta.is_dir());
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let children = match kind {
            NodeKind::Folder => Some(read_children(&entry.path(), &path)?),
            _ => None,
        };
        nodes.push(TreeNode {
            name,
            path,
            kind,
            children,
        });
    }
    nodes.sort_by(compare);
    Ok(nodes)
}

/// Folders first, then everything else, each group by case-insensitive name.
fn compare(a: &TreeNode, b: &TreeNode) -> Ordering {
    let a_folder = a.kind == NodeKind::Folder;
    let b_folder = b.kind == NodeKind::Folder;
    b_folder
        .cmp(&a_folder)
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        .then_with(|| a.name.cmp(&b.name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_entries() {
        assert_eq!(classify("Note.md", false), NodeKind::Note);
        assert_eq!(classify("README.MD", false), NodeKind::Note);
        assert_eq!(classify("demo.html", false), NodeKind::Page);
        assert_eq!(classify("demo.page", true), NodeKind::PageBundle);
        assert_eq!(classify("demo.page", false), NodeKind::Asset);
        assert_eq!(classify("Projects", true), NodeKind::Folder);
        assert_eq!(classify("diagram.png", false), NodeKind::Asset);
    }
}
