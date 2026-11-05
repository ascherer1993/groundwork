//! A copy of `fixtures/vault` for tests that open a session on it.

use std::fs;
use std::path::Path;

use crate::{Session, Vault};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/vault");

/// The fixture vault copied to `<dir>/vault`, with its data in `<dir>/data`.
pub fn session() -> (tempfile::TempDir, Session) {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    copy_dir(Path::new(FIXTURE), &vault);
    let session = Session::open(Vault::open(&vault).unwrap(), &dir.path().join("data")).unwrap();
    (dir, session)
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}
