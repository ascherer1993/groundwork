//! Encrypted notes.
//!
//! An encrypted note stays a `.md` file at its own path, so links to it,
//! renames and the file tree work as before. On disk only its hint is
//! readable:
//!
//! ````text
//! ---
//! encrypted: groundwork-v1
//! hint: the usual one
//! ---
//! This note is encrypted. Open it in Groundwork to read it.
//!
//! ```groundwork-encrypted
//! AQAAAQADAAAAAQAAAN…
//! ```
//! ````
//!
//! The block holds, base64-encoded: a version byte, the Argon2id cost
//! (memory KiB, passes, lanes as little-endian `u32`s), a 16-byte salt, a
//! 24-byte nonce, then the whole note (its own frontmatter too) sealed with
//! XChaCha20-Poly1305. The bytes before the nonce are authenticated as well,
//! so the cost can't be lowered. The key is derived once per unlock and kept
//! in memory (see [`Key`]); each save seals with a fresh nonce.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::frontmatter::scalar;
use crate::parse::split_frontmatter;
use crate::{CoreError, Result};

/// The value of an encrypted note's `encrypted:` property.
pub const MARKER: &str = "groundwork-v1";
const FENCE: &str = "```groundwork-encrypted";
const NOTICE: &str = "This note is encrypted. Open it in Groundwork to read it.";
const VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = 1 + 12 + SALT_LEN;

/// Argon2id's cost: 64 MiB, 3 passes (OWASP's suggestion is 19 MiB, 2).
#[cfg(not(test))]
const COST: Cost = Cost {
    memory_kib: 64 * 1024,
    passes: 3,
    lanes: 1,
};
/// Tests derive cheaply; the cost is in each file, so either reads.
#[cfg(test)]
const COST: Cost = Cost {
    memory_kib: 64,
    passes: 1,
    lanes: 1,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Cost {
    memory_kib: u32,
    passes: u32,
    lanes: u32,
}

/// A note's key, derived from its password, and what it was derived with.
/// Wiped from memory when dropped.
pub struct Key {
    key: Zeroizing<[u8; 32]>,
    header: [u8; HEADER_LEN],
}

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Key(…)")
    }
}

impl Key {
    /// A new key for `password`, with a fresh salt.
    pub fn new(password: &str) -> Result<Self> {
        if password.is_empty() {
            return Err(CoreError::InvalidPath("the password can't be empty".into()));
        }
        let mut salt = [0u8; SALT_LEN];
        random(&mut salt)?;
        Self::derive(password, COST, salt)
    }

    fn derive(password: &str, cost: Cost, salt: [u8; SALT_LEN]) -> Result<Self> {
        let params = Params::new(cost.memory_kib, cost.passes, cost.lanes, Some(32))
            .map_err(|e| CoreError::Conflict(format!("bad encryption settings: {e}")))?;
        let mut key = Zeroizing::new([0u8; 32]);
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(password.as_bytes(), &salt, key.as_mut())
            .map_err(|e| CoreError::Conflict(format!("couldn't derive the key: {e}")))?;
        let mut header = [0u8; HEADER_LEN];
        header[0] = VERSION;
        header[1..5].copy_from_slice(&cost.memory_kib.to_le_bytes());
        header[5..9].copy_from_slice(&cost.passes.to_le_bytes());
        header[9..13].copy_from_slice(&cost.lanes.to_le_bytes());
        header[13..].copy_from_slice(&salt);
        Ok(Self { key, header })
    }

    /// The file for `plain`, sealed with this key and a fresh nonce.
    pub fn seal(&self, plain: &str, hint: &str) -> Result<String> {
        let mut nonce = [0u8; NONCE_LEN];
        random(&mut nonce)?;
        let cipher = XChaCha20Poly1305::new(self.key.as_ref().into());
        let sealed = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plain.as_bytes(),
                    aad: &self.header,
                },
            )
            .map_err(|_| CoreError::Conflict("couldn't encrypt the note".into()))?;
        let mut bytes = Vec::with_capacity(HEADER_LEN + NONCE_LEN + sealed.len());
        bytes.extend_from_slice(&self.header);
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&sealed);
        let encoded = BASE64.encode(&bytes);
        let mut out = format!("---\nencrypted: {MARKER}\n");
        let hint = one_line(hint);
        if !hint.is_empty() {
            out.push_str(&format!("hint: {}\n", scalar(&hint, false)));
        }
        out.push_str(&format!("---\n{NOTICE}\n\n{FENCE}\n"));
        for chunk in encoded.as_bytes().chunks(76) {
            out.push_str(std::str::from_utf8(chunk).expect("base64 is ASCII"));
            out.push('\n');
        }
        out.push_str("```\n");
        Ok(out)
    }
}

/// Encrypts a note's text with a new password. Returns the file and its key.
pub fn encrypt(plain: &str, password: &str, hint: &str) -> Result<(String, Key)> {
    let key = Key::new(password)?;
    let file = key.seal(plain, hint)?;
    Ok((file, key))
}

/// Opens an encrypted note's file with its password: its text and key.
pub fn unlock(file: &str, password: &str) -> Result<(String, Key)> {
    let bytes = payload(file)?;
    let u32_at = |i: usize| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
    let cost = Cost {
        memory_kib: u32_at(1),
        passes: u32_at(5),
        lanes: u32_at(9),
    };
    // Refuse a cost that would take minutes or all the memory.
    if cost.memory_kib > 4 * 1024 * 1024 || cost.passes > 64 || cost.lanes > 16 {
        return Err(damaged());
    }
    let salt: [u8; SALT_LEN] = bytes[13..HEADER_LEN].try_into().unwrap();
    let key = Key::derive(password, cost, salt)?;
    let text = key.decrypt(&bytes)?;
    Ok((text, key))
}

impl Key {
    /// Opens the file again with this key, as it is now. Fails with
    /// [`CoreError::WrongPassword`] if its password has changed since.
    pub fn open(&self, file: &str) -> Result<String> {
        let bytes = payload(file)?;
        if bytes[..HEADER_LEN] != self.header {
            return Err(CoreError::WrongPassword);
        }
        self.decrypt(&bytes)
    }

    fn decrypt(&self, bytes: &[u8]) -> Result<String> {
        let nonce = &bytes[HEADER_LEN..HEADER_LEN + NONCE_LEN];
        let cipher = XChaCha20Poly1305::new(self.key.as_ref().into());
        let plain = cipher
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: &bytes[HEADER_LEN + NONCE_LEN..],
                    aad: &bytes[..HEADER_LEN],
                },
            )
            .map_err(|_| CoreError::WrongPassword)?;
        String::from_utf8(plain).map_err(|_| damaged())
    }
}

/// Whether a note's text is an encrypted note.
pub fn is_encrypted(text: &str) -> bool {
    marks_encrypted(split_frontmatter(text).1.as_ref())
}

/// Whether a note's parsed frontmatter marks it encrypted.
pub fn marks_encrypted(frontmatter: Option<&Value>) -> bool {
    frontmatter
        .and_then(|f| f.get("encrypted"))
        .and_then(Value::as_str)
        .is_some_and(|v| v.starts_with("groundwork-"))
}

/// An encrypted note's hint (empty if it has none).
pub fn hint(text: &str) -> String {
    split_frontmatter(text)
        .1
        .as_ref()
        .and_then(|f| f.get("hint"))
        .map(|h| match h {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default()
}

fn one_line(hint: &str) -> String {
    hint.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The decoded bytes in an encrypted note's block.
fn payload(file: &str) -> Result<Vec<u8>> {
    if !is_encrypted(file) {
        return Err(CoreError::Conflict("this note isn't encrypted".into()));
    }
    let mut lines = file.lines().skip_while(|l| l.trim_end() != FENCE);
    if lines.next().is_none() {
        return Err(damaged());
    }
    let encoded: String = lines
        .take_while(|l| !l.trim_start().starts_with("```"))
        .map(str::trim)
        .collect();
    let bytes = BASE64.decode(encoded).map_err(|_| damaged())?;
    if bytes.len() < HEADER_LEN + NONCE_LEN + 16 || bytes[0] != VERSION {
        return Err(damaged());
    }
    Ok(bytes)
}

fn damaged() -> CoreError {
    CoreError::Conflict("this encrypted note is damaged and can't be opened".into())
}

fn random(buf: &mut [u8]) -> Result<()> {
    getrandom::fill(buf)
        .map_err(|e| CoreError::Io(std::io::Error::other(format!("no randomness: {e}"))))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "---\ntags: [secret]\n---\n# Plans\n\nSee [[Welcome]].\n";

    /// A note encrypted when the format was made: it must always open.
    #[test]
    fn opens_the_fixture_note() {
        let file = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/vault/Projects/Acme/Credentials.md"
        ))
        .unwrap();
        assert_eq!(hint(&file), "the fixture one");
        let (text, _) = unlock(&file, "fixture-password").unwrap();
        assert!(text.starts_with("# Acme credentials\n"), "{text}");
        assert!(text.contains("- [ ] Rotate the staging password"));
    }

    #[test]
    fn round_trips() {
        let (file, _) = encrypt(NOTE, "hunter2", "the usual").unwrap();
        assert!(is_encrypted(&file));
        assert_eq!(hint(&file), "the usual");
        assert!(!file.contains("Plans") && !file.contains("secret"));
        let (text, _) = unlock(&file, "hunter2").unwrap();
        assert_eq!(text, NOTE);
    }

    #[test]
    fn wrong_password_fails() {
        let (file, _) = encrypt(NOTE, "hunter2", "").unwrap();
        assert!(matches!(
            unlock(&file, "hunter3"),
            Err(CoreError::WrongPassword)
        ));
        assert!(!file.contains("hint:"));
    }

    #[test]
    fn resealing_keeps_the_password_with_a_new_nonce() {
        let (first, key) = encrypt(NOTE, "pw", "h").unwrap();
        let second = key.seal("changed", "h").unwrap();
        assert_ne!(payload(&first).unwrap()[..HEADER_LEN + NONCE_LEN], {
            let b = payload(&second).unwrap();
            b[..HEADER_LEN + NONCE_LEN].to_vec()
        });
        assert_eq!(unlock(&second, "pw").unwrap().0, "changed");
        assert_eq!(key.open(&second).unwrap(), "changed");
        // Another password's file isn't opened with this key.
        let (other, _) = encrypt(NOTE, "pw", "h").unwrap();
        assert!(matches!(key.open(&other), Err(CoreError::WrongPassword)));
    }

    #[test]
    fn tampering_is_caught() {
        let (file, _) = encrypt(NOTE, "pw", "").unwrap();
        let mut bytes = payload(&file).unwrap();
        // Change the cost: the header is authenticated.
        bytes[1] ^= 0x80;
        let encoded = BASE64.encode(&bytes);
        let forged = format!("---\nencrypted: {MARKER}\n---\n{FENCE}\n{encoded}\n```\n");
        assert!(matches!(
            unlock(&forged, "pw"),
            Err(CoreError::WrongPassword)
        ));
        let truncated = file.replace(FENCE, "```text");
        assert!(matches!(
            unlock(&truncated, "pw"),
            Err(CoreError::Conflict(_))
        ));
    }

    #[test]
    fn hints_are_one_quoted_line() {
        let (file, _) = encrypt(NOTE, "pw", "  first: second\nthird ").unwrap();
        assert_eq!(hint(&file), "first: second third");
    }

    #[test]
    fn only_marked_notes_count() {
        assert!(!is_encrypted(NOTE));
        assert!(!is_encrypted("---\nencrypted: true\n---\n"));
        assert!(matches!(unlock(NOTE, "pw"), Err(CoreError::Conflict(_))));
        assert!(matches!(Key::new(""), Err(CoreError::InvalidPath(_))));
    }
}
