use std::path::PathBuf;

pub type Result<T, E = CoreError> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("path is outside the vault: {0}")]
    OutsideVault(String),
    #[error("not a folder: {}", .0.display())]
    NotADirectory(PathBuf),
    #[error("already exists: {0}")]
    AlreadyExists(String),
    #[error("{0}")]
    InvalidPath(String),
    #[error("{0}")]
    Conflict(String),
    #[error("file is too large to open ({size} bytes)")]
    TooLarge { size: u64 },
    /// A Groundwork config file (`config.yml`, `repos.yml`, `.groundwork.yml`) is invalid.
    #[error("{0}")]
    Config(String),
    /// A repo hasn't been located on this machine yet.
    #[error("the {0} repo hasn't been located on this machine")]
    RepoNotLocated(String),
    /// A git command failed; the message is git's.
    #[error("{0}")]
    Git(String),
    /// qmd (smart search) isn't installed or set up, or it failed.
    #[error("{0}")]
    Qmd(String),
    /// Setting up the CLI or the Claude Code plugin failed.
    #[error("{0}")]
    Setup(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
