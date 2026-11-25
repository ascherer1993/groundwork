//! Spell checking for notes (PLAN §5.18). Words are checked against an
//! English (US) Hunspell dictionary that ships with the app (SCOWL, through
//! `dictionaries/`), plus the vault's own words in
//! `.groundwork/dictionary.txt`: one word per line, which "Add to dictionary"
//! appends to. That file is plain text, so it travels with the vault and can
//! be edited by hand; it's read again whenever it changes.
//!
//! The editor decides what counts as a word (it skips code, links, tags and
//! the like); this only answers whether a word is known and what it might
//! have meant.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use spellbook::Dictionary;

use crate::{CoreError, Result};

pub const DICTIONARY_FILE: &str = ".groundwork/dictionary.txt";

/// Suggestions offered for a word, at most.
const MAX_SUGGESTIONS: usize = 6;
/// The longest word worth checking; anything longer is left alone.
const MAX_WORD: usize = 64;

static ENGLISH: OnceLock<Dictionary> = OnceLock::new();

/// The bundled dictionary, parsed on first use (a few tenths of a second).
fn english() -> &'static Dictionary {
    ENGLISH.get_or_init(|| {
        Dictionary::new(
            include_str!("../dictionaries/en_US.aff"),
            include_str!("../dictionaries/en_US.dic"),
        )
        .expect("the bundled dictionary parses")
    })
}

/// Parses the bundled dictionary in the background, so the first check
/// after opening a vault doesn't wait for it.
pub fn warm_up() {
    if ENGLISH.get().is_none() {
        std::thread::spawn(english);
    }
}

/// A vault's spell checker: the bundled dictionary plus the vault's words.
pub struct Spelling {
    file: PathBuf,
    user: Mutex<UserWords>,
}

#[derive(Default)]
struct UserWords {
    /// The file's modified time when it was read; `None` if it wasn't there.
    read: Option<Option<SystemTime>>,
    words: HashSet<String>,
}

impl UserWords {
    /// Whether the vault's dictionary has `word`. A word added in lower case
    /// also covers it capitalised or in capitals, as Hunspell does; one added
    /// with capitals (a name) only in that form or in all capitals.
    fn knows(&self, word: &str) -> bool {
        if self.words.contains(word) {
            return true;
        }
        let lower = word.to_lowercase();
        if self.words.contains(&lower) {
            return true;
        }
        is_all_caps(word) && self.words.iter().any(|w| w.to_lowercase() == lower)
    }
}

impl Spelling {
    pub fn new(root: &Path) -> Self {
        Self {
            file: root.join(DICTIONARY_FILE),
            user: Mutex::new(UserWords::default()),
        }
    }

    /// The words in `words` that aren't known, in the order given.
    pub fn misspelled(&self, words: &[String]) -> Vec<String> {
        let dict = english();
        let user = self.user_words();
        words
            .iter()
            .filter(|w| !is_known(dict, &user, w))
            .cloned()
            .collect()
    }

    /// What `word` might have been meant to be, best first.
    pub fn suggest(&self, word: &str) -> Vec<String> {
        let word = normalize(word);
        if word.is_empty() || word.chars().count() > MAX_WORD {
            return Vec::new();
        }
        let mut out = Vec::new();
        english().suggest(&word, &mut out);
        out.truncate(MAX_SUGGESTIONS);
        out
    }

    /// Adds `word` to the vault's dictionary, unless it's already known.
    pub fn add(&self, word: &str) -> Result<()> {
        let word = normalize(word.trim());
        if word.is_empty() || word.chars().any(char::is_whitespace) {
            return Err(CoreError::InvalidPath(format!(
                "can't add {word:?} to the dictionary: it should be one word"
            )));
        }
        let mut user = self.user_words();
        if user.knows(&word) {
            return Ok(());
        }
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir)?;
        }
        // Start on a line of its own if the file was edited by hand and
        // doesn't end with one.
        let needs_newline = fs::read(&self.file)
            .map(|b| b.last().is_some_and(|&c| c != b'\n'))
            .unwrap_or(false);
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file)?;
        let line = format!("{}{word}\n", if needs_newline { "\n" } else { "" });
        file.write_all(line.as_bytes())?;
        user.words.insert(word);
        user.read = Some(modified(&self.file));
        Ok(())
    }

    /// The vault's own words, sorted.
    pub fn words(&self) -> Vec<String> {
        let mut words: Vec<String> = self.user_words().words.iter().cloned().collect();
        words.sort_by_key(|w| w.to_lowercase());
        words
    }

    /// Takes `word` out of the vault's dictionary, keeping the file's other
    /// lines (and comments) as they were.
    pub fn remove(&self, word: &str) -> Result<()> {
        let word = normalize(word.trim());
        let mut user = self.user_words();
        let Ok(text) = fs::read_to_string(&self.file) else {
            return Ok(());
        };
        let kept: Vec<&str> = text
            .lines()
            .filter(|l| normalize(l.trim()) != word)
            .collect();
        let mut out = kept.join("\n");
        if !out.is_empty() {
            out.push('\n');
        }
        crate::session::atomic_write(&self.file, &out)?;
        user.words.remove(&word);
        user.read = Some(modified(&self.file));
        Ok(())
    }

    /// The vault's words, read again if the file changed since.
    fn user_words(&self) -> std::sync::MutexGuard<'_, UserWords> {
        let mut user = self.user.lock().unwrap();
        let now = modified(&self.file);
        if user.read != Some(now) {
            user.words = fs::read_to_string(&self.file)
                .map(|text| parse_words(&text))
                .unwrap_or_default();
            user.read = Some(now);
        }
        user
    }
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// The words in a dictionary file: one per line, ignoring blank lines and
/// `#` comments.
fn parse_words(text: &str) -> HashSet<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(normalize)
        .collect()
}

/// Typographic apostrophes as plain ones, which is what the dictionary has.
fn normalize(word: &str) -> String {
    word.replace(['\u{2019}', '\u{2018}'], "'")
}

fn is_all_caps(word: &str) -> bool {
    word.chars().any(char::is_alphabetic) && !word.chars().any(char::is_lowercase)
}

fn is_known(dict: &Dictionary, user: &UserWords, word: &str) -> bool {
    let word = normalize(word);
    if word.is_empty() || word.chars().count() > MAX_WORD {
        return true;
    }
    if dict.check(&word) || user.knows(&word) {
        return true;
    }
    // A possessive of a known word ("Groundwork's"), when the dictionary
    // doesn't list that form itself.
    let stem = word
        .strip_suffix("'s")
        .or_else(|| word.strip_suffix("'S"))
        .or_else(|| word.strip_suffix('\''));
    stem.is_some_and(|s| !s.is_empty() && (dict.check(s) || user.knows(s)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn finds_misspelled_words() {
        let dir = tempfile::tempdir().unwrap();
        let s = Spelling::new(dir.path());
        let found = s.misspelled(&words(&[
            "The",
            "quick",
            "brwon",
            "fox",
            "don't",
            "don\u{2019}t",
            "teh",
            "NASA",
            "I",
            "isn't",
            "children's",
            "Monday",
        ]));
        assert_eq!(found, words(&["brwon", "teh"]));
    }

    #[test]
    fn suggests_corrections() {
        let dir = tempfile::tempdir().unwrap();
        let s = Spelling::new(dir.path());
        let suggestions = s.suggest("recieve");
        assert_eq!(suggestions.first().map(String::as_str), Some("receive"));
        assert!(suggestions.len() <= MAX_SUGGESTIONS);
        assert!(s.suggest("").is_empty());
    }

    #[test]
    fn added_words_are_known_and_kept_in_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let s = Spelling::new(dir.path());
        assert_eq!(
            s.misspelled(&words(&["frobnicate"])),
            words(&["frobnicate"])
        );

        s.add("frobnicate").unwrap();
        s.add("Kubernetes").unwrap();
        s.add("frobnicate").unwrap(); // already there: not written twice
        let text = fs::read_to_string(dir.path().join(DICTIONARY_FILE)).unwrap();
        assert_eq!(text, "frobnicate\nKubernetes\n");

        // Lower case covers capitalised and capitals; a name only itself and
        // capitals; possessives of either.
        let checked = words(&[
            "frobnicate",
            "Frobnicate",
            "FROBNICATE",
            "Kubernetes",
            "KUBERNETES",
            "kubernetes",
            "Kubernetes's",
            "Kubernetes\u{2019}s",
        ]);
        assert_eq!(s.misspelled(&checked), words(&["kubernetes"]));

        // Another checker on the same vault reads the file.
        let other = Spelling::new(dir.path());
        assert!(other.misspelled(&words(&["frobnicate"])).is_empty());
    }

    #[test]
    fn reads_the_file_again_when_it_changes() {
        let dir = tempfile::tempdir().unwrap();
        let s = Spelling::new(dir.path());
        assert_eq!(s.misspelled(&words(&["zorbly"])), words(&["zorbly"]));

        let file = dir.path().join(DICTIONARY_FILE);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "# words for this vault\n\n  zorbly  \nquux").unwrap();
        assert!(s.misspelled(&words(&["zorbly", "quux"])).is_empty());

        // Added after a hand edit with no newline at the end.
        s.add("blorp").unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.ends_with("quux\nblorp\n"), "{text:?}");

        fs::remove_file(&file).unwrap();
        assert_eq!(s.misspelled(&words(&["zorbly"])), words(&["zorbly"]));
    }

    #[test]
    fn lists_and_removes_words() {
        let dir = tempfile::tempdir().unwrap();
        let s = Spelling::new(dir.path());
        assert!(s.words().is_empty());
        s.remove("nothing").unwrap(); // no file: nothing to do

        let file = dir.path().join(DICTIONARY_FILE);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "# mine\nzorbly\nQuux\nblorp\n").unwrap();
        assert_eq!(s.words(), words(&["blorp", "Quux", "zorbly"]));

        s.remove("zorbly").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "# mine\nQuux\nblorp\n");
        assert_eq!(
            s.misspelled(&words(&["zorbly", "Quux"])),
            words(&["zorbly"])
        );
    }

    #[test]
    fn refuses_more_than_one_word() {
        let dir = tempfile::tempdir().unwrap();
        let s = Spelling::new(dir.path());
        assert!(s.add("two words").is_err());
        assert!(s.add("   ").is_err());
        assert!(!dir.path().join(DICTIONARY_FILE).exists());
    }
}
