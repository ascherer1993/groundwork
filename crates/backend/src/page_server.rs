//! Serving HTML pages to their frames.
//!
//! Pages load from `/page/<token>/<vault path>` on the host's file scheme
//! (`groundwork://localhost` in the app, the dev server in browser mode).
//! The UI puts them in sandboxed iframes without `allow-same-origin`, so a
//! page has no origin of its own: it can't reach the app's API or DOM, only
//! the bridge, which talks to the app with postMessage. Because the frame's
//! origin is opaque, page files are served with CORS open (for module scripts
//! and `fetch`); the random token keeps other websites from using that to read
//! the vault through the dev server.

use groundwork_core::pages::{self, PageSettings};
use groundwork_protocol::{ApiError, ErrorCode};

const BRIDGE: &str = include_str!("bridge.js");

/// A file for a page frame, with the headers to send it with.
pub struct PageFile {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub headers: Vec<(&'static str, String)>,
}

/// A random token for page URLs, new each time the app starts.
pub fn new_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the system random number generator failed");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl crate::Backend {
    /// Serves the part of a page URL after `/page/`: `<token>/<vault path>`,
    /// percent-decoded. HTML documents get the bridge, and a Content Security
    /// Policy when the vault doesn't allow network access. `self_source` is
    /// the CSP source for the host's own files (`groundwork:` or the dev
    /// server's origin).
    pub fn page_file(&self, rest: &str, self_source: &str) -> Result<PageFile, ApiError> {
        let (token, path) = rest
            .split_once('/')
            .ok_or_else(|| ApiError::new(ErrorCode::NotFound, "not found"))?;
        if token != self.page_token {
            return Err(ApiError::new(ErrorCode::Forbidden, "unknown page token"));
        }
        let path = path.trim_end_matches('/');
        let (bytes, mime) = self.read_bytes(path)?;
        let mut headers = vec![
            ("Access-Control-Allow-Origin", "*".to_string()),
            ("Cache-Control", "no-store".to_string()),
        ];
        let page = pages::page_of(path);
        let (Some(page), "text/html") = (page, mime.as_str()) else {
            return Ok(PageFile {
                bytes,
                mime,
                headers,
            });
        };
        let session = self.session()?;
        if !PageSettings::read(session.vault().root()).allow_network {
            headers.push(("Content-Security-Policy", offline_policy(self_source)));
        }
        let config = serde_json::json!({ "page": page, "prefix": format!("/page/{token}/") });
        let html = inject_bridge(&String::from_utf8_lossy(&bytes), &config.to_string());
        Ok(PageFile {
            bytes: html.into_bytes(),
            mime: "text/html; charset=utf-8".to_string(),
            headers,
        })
    }
}

/// Lets a page use its own files, inline code and data URLs, but nothing
/// from the network.
fn offline_policy(self_source: &str) -> String {
    format!("default-src {self_source} 'unsafe-inline' 'unsafe-eval' data: blob:")
}

/// Puts the bridge script first in the document, before any of the page's
/// own scripts: right after `<head>`, else after `<html>`, else after the
/// doctype (so the page stays in standards mode), else at the very start.
fn inject_bridge(html: &str, config: &str) -> String {
    // `</script>` in a string would end the script early.
    let script = format!(
        "<script>{}</script>",
        BRIDGE.replace("__CONFIG__", &config.replace('<', "\\u003c"))
    );
    let at = tag_end(html, "head")
        .or_else(|| tag_end(html, "html"))
        .or_else(|| {
            let start = html.trim_start();
            start
                .get(..9)
                .is_some_and(|s| s.eq_ignore_ascii_case("<!doctype"))
                .then(|| html.len() - start.len() + start.find('>').map_or(0, |i| i + 1))
        })
        .unwrap_or(0);
    let mut out = String::with_capacity(html.len() + script.len());
    out.push_str(&html[..at]);
    out.push_str(&script);
    out.push_str(&html[at..]);
    out
}

/// The byte offset just past the first `<name …>` start tag.
fn tag_end(html: &str, name: &str) -> Option<usize> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{name}");
    let mut from = 0;
    while let Some(i) = lower[from..].find(&open) {
        let start = from + i;
        let after = start + open.len();
        match lower.as_bytes().get(after) {
            Some(b'>' | b' ' | b'\t' | b'\n' | b'\r' | b'/') => {
                return lower[after..].find('>').map(|j| after + j + 1);
            }
            _ => from = after,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn injected(html: &str) -> String {
        inject_bridge(html, "{}").replace(
            &format!("<script>{}</script>", BRIDGE.replace("__CONFIG__", "{}")),
            "[bridge]",
        )
    }

    #[test]
    fn the_bridge_goes_before_the_page_scripts() {
        assert_eq!(
            injected("<!doctype html><html><head><title>x</title></head></html>"),
            "<!doctype html><html><head>[bridge]<title>x</title></head></html>"
        );
        assert_eq!(
            injected("<HTML lang=en><HEAD data-x=\"1\">"),
            "<HTML lang=en><HEAD data-x=\"1\">[bridge]"
        );
        assert_eq!(
            injected("<!doctype html><html><header>h</header>"),
            "<!doctype html><html>[bridge]<header>h</header>"
        );
        assert_eq!(
            injected("  <!DOCTYPE html>\n<p>hi"),
            "  <!DOCTYPE html>[bridge]\n<p>hi"
        );
        assert_eq!(injected("<p>hi</p>"), "[bridge]<p>hi</p>");
    }

    #[test]
    fn config_cant_close_the_script() {
        let html = inject_bridge("<p>", r#"{"page":"</script><b>.html"}"#);
        assert!(html.contains(r#"{"page":"\u003c/script>\u003cb>.html"}"#));
        assert_eq!(html.matches("</script>").count(), 1);
    }

    #[test]
    fn tokens_are_random() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }
}
