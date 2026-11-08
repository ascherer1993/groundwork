//! Subnotes (PLAN §5.15): a note named `Name.key.md` beside `Name.md`
//! belongs to it, like a meeting's transcript (`2026-12-01 Standup.transcript.md`
//! under `2026-12-01 Standup.md`). The file tree lists it under its note, and
//! renaming or moving the note takes its subnotes along. The key must start
//! with a letter, so `Release 1.2` isn't taken for a subnote of `Release 1`.
//! Subnotes nest: `Name.a.b.md` belongs to `Name.a.md` when that exists, else
//! to `Name.md`.

use crate::index::Index;
use crate::tree::NodeKind;

/// The key of `stem` as a subnote of `parent` ("Standup.transcript" of
/// "Standup" → "transcript"), if it is one.
pub fn subkey<'a>(parent: &str, stem: &'a str) -> Option<&'a str> {
    let rest = stem.strip_prefix(parent)?.strip_prefix('.')?;
    rest.chars()
        .next()
        .is_some_and(char::is_alphabetic)
        .then_some(rest)
}

fn split(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or(("", path))
}

fn note_stem(name: &str) -> Option<&str> {
    let cut = name.len().checked_sub(3)?;
    name.get(cut..)
        .is_some_and(|ext| ext.eq_ignore_ascii_case(".md"))
        .then(|| &name[..cut])
        .filter(|s| !s.is_empty())
}

fn join(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else {
        format!("{folder}/{name}")
    }
}

fn is_note(index: &Index, path: &str) -> bool {
    index.get(path).is_some_and(|f| f.kind == NodeKind::Note)
}

/// The note that `path` is a subnote of: the nearest `Name.md` beside it.
pub fn parent_of(index: &Index, path: &str) -> Option<String> {
    let (folder, name) = split(path);
    let stem = note_stem(name)?;
    let mut end = stem.len();
    while let Some(dot) = stem[..end].rfind('.') {
        let candidate = &stem[..dot];
        if subkey(candidate, stem).is_some() {
            let parent = join(folder, &format!("{candidate}.md"));
            if is_note(index, &parent) {
                return Some(parent);
            }
        }
        end = dot;
    }
    None
}

/// Every subnote of the note `path`, at any depth, in path order.
pub fn subnotes_of(index: &Index, path: &str) -> Vec<String> {
    let (folder, name) = split(path);
    let Some(stem) = note_stem(name) else {
        return Vec::new();
    };
    let mut found: Vec<String> = index
        .paths()
        .filter(|p| *p != path && is_note(index, p))
        .filter(|p| {
            let (f, n) = split(p);
            f == folder && note_stem(n).is_some_and(|s| subkey(stem, s).is_some())
        })
        .map(str::to_string)
        .collect();
    found.sort();
    found
}

/// Where the subnote `sub` of `from` goes when `from` becomes `to`: beside
/// it, with the same key.
pub fn moved_subnote(sub: &str, from: &str, to: &str) -> Option<String> {
    let from_stem = note_stem(split(from).1)?;
    let (to_folder, to_name) = split(to);
    let to_stem = note_stem(to_name)?;
    let key = subkey(from_stem, note_stem(split(sub).1)?)?;
    Some(join(to_folder, &format!("{to_stem}.{key}.md")))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::test_vault::session;
    use crate::{Session, Vault};

    struct TestVault {
        _dir: tempfile::TempDir,
        session: Session,
    }

    impl TestVault {
        fn new(files: &[(&str, &str)]) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let vault = dir.path().join("vault");
            for (path, text) in files {
                let full = vault.join(path);
                fs::create_dir_all(full.parent().unwrap()).unwrap();
                fs::write(full, text).unwrap();
            }
            let session =
                Session::open(Vault::open(&vault).unwrap(), &dir.path().join("data")).unwrap();
            Self { _dir: dir, session }
        }
    }

    #[test]
    fn the_fixture_meeting_has_a_transcript() {
        let (_dir, session) = session();
        let index = session.index();
        let meeting = "Projects/Acme/Meetings/2026-11-02 Kickoff.md";
        let transcript = "Projects/Acme/Meetings/2026-11-02 Kickoff.transcript.md";
        assert_eq!(parent_of(&index, transcript).as_deref(), Some(meeting));
        assert_eq!(subnotes_of(&index, meeting), [transcript]);
    }

    #[test]
    fn keys_start_with_a_letter() {
        assert_eq!(subkey("Standup", "Standup.transcript"), Some("transcript"));
        assert_eq!(subkey("Standup", "Standup.a.b"), Some("a.b"));
        assert_eq!(subkey("Release 1", "Release 1.2"), None);
        assert_eq!(subkey("Standup", "Standup. notes"), None);
        assert_eq!(subkey("Standup", "Standup."), None);
        assert_eq!(subkey("Standup", "Standups.x"), None);
        assert_eq!(subkey("Standup", "Standup"), None);
    }

    #[test]
    fn finds_the_nearest_parent_beside_it() {
        let v = TestVault::new(&[
            ("M/2026-12-01 Standup.md", ""),
            ("M/2026-12-01 Standup.transcript.md", ""),
            ("M/2026-12-01 Standup.transcript.raw.md", ""),
            ("M/2026-12-01 Standup.summary.draft.md", ""),
            ("M/v1.md", ""),
            ("M/v1.2 notes.md", ""),
            ("Other/2026-12-01 Standup.extra.md", ""),
            ("Lonely.key.md", ""),
        ]);
        let index = v.session.index();
        let parent = |p| parent_of(&index, p);
        assert_eq!(
            parent("M/2026-12-01 Standup.transcript.md").as_deref(),
            Some("M/2026-12-01 Standup.md")
        );
        assert_eq!(
            parent("M/2026-12-01 Standup.transcript.raw.md").as_deref(),
            Some("M/2026-12-01 Standup.transcript.md")
        );
        // No `summary.md`, so it belongs to the meeting itself.
        assert_eq!(
            parent("M/2026-12-01 Standup.summary.draft.md").as_deref(),
            Some("M/2026-12-01 Standup.md")
        );
        assert_eq!(parent("M/2026-12-01 Standup.md"), None);
        assert_eq!(parent("M/v1.2 notes.md"), None);
        assert_eq!(parent("Other/2026-12-01 Standup.extra.md"), None);
        assert_eq!(parent("Lonely.key.md"), None);

        assert_eq!(
            subnotes_of(&index, "M/2026-12-01 Standup.md"),
            [
                "M/2026-12-01 Standup.summary.draft.md",
                "M/2026-12-01 Standup.transcript.md",
                "M/2026-12-01 Standup.transcript.raw.md",
            ]
        );
        assert!(subnotes_of(&index, "M/v1.md").is_empty());
    }

    #[test]
    fn subnotes_keep_their_key_when_moved() {
        assert_eq!(
            moved_subnote("A/Old.transcript.md", "A/Old.md", "B/New.md").as_deref(),
            Some("B/New.transcript.md")
        );
        assert_eq!(
            moved_subnote("Old.a.b.md", "Old.md", "New.md").as_deref(),
            Some("New.a.b.md")
        );
        assert_eq!(moved_subnote("Old.a.md", "Old.md", "Folder"), None);
    }
}
