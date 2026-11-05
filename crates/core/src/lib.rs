//! Vault model and file operations for Groundwork.
//!
//! A vault is a plain folder of Markdown, HTML and assets. Nothing here writes
//! to `.obsidian/`; Groundwork's own vault config lives in `.groundwork/`.

pub mod activity;
pub mod agent;
pub mod command_log;
pub mod config;
pub mod daily;
pub mod dates;
mod error;
pub mod frontmatter;
pub mod git;
pub mod inbox;
pub mod index;
pub mod moment;
pub mod pages;
pub mod parse;
pub mod project_view;
pub mod qmd;
pub mod quickadd;
pub mod recent;
pub mod repos;
pub mod search;
pub mod session;
pub mod settings;
pub mod setup;
pub mod template;
#[cfg(test)]
mod test_vault;
pub mod tickets;
pub mod todos;
mod tree;
mod vault;
pub mod watch;
pub mod who;
pub mod workspaces;

pub use error::{CoreError, Result};
pub use recent::{RecentVault, RecentVaults};
pub use session::{ChangeKind, FileChange, RenameOutcome, Session};
pub use tree::{NodeKind, TreeNode};
pub use vault::{FileContent, Vault, VaultInfo};

use std::path::PathBuf;

/// Machine-local app data directory (`~/Library/Application Support/Groundwork`
/// on macOS). `GROUNDWORK_DATA_DIR` overrides it, which tests rely on.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("GROUNDWORK_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("Groundwork")
}
