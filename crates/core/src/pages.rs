//! HTML pages: where their state is kept, the links in them, and the
//! vault's page settings.
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

use crate::parse::{Link, LinkKind};
use crate::tree::{NodeKind, classify};
use crate::{CoreError, Result};

/// Links from a page to other vault files: `<a href="[[Note]]">` and
/// relative hrefs like `../Plan.md`, the ones the bridge opens in the app.
/// `page` is the page's vault path and `html` its document (a bundle's
/// `index.html`).
///
/// Wikilinks come back as written. Relative hrefs come back resolved to vault
/// paths (as Markdown links), since they're relative to the document, which
/// for a bundle is inside it. Links within the bundle, to the web, and
/// anchors on the page are left out. Ranges cover the `href` value.
pub fn links(html: &str, page: &str) -> Vec<Link> {
    let bundle = classify(page.rsplit('/').next().unwrap_or(page), true) == NodeKind::PageBundle;
    let dir = if bundle {
        page
    } else {
        page.rsplit_once('/').map_or("", |(dir, _)| dir)
    };
    let lower = html.to_ascii_lowercase();
    let mut links = Vec::new();
    let mut pos = 0;
    while let Some(found) = lower[pos..].find("<a") {
        let after = pos + found + 2;
        pos = after;
        if !matches!(
            lower.as_bytes().get(after),
            Some(b' ' | b'\t' | b'\n' | b'\r')
        ) {
            continue;
        }
        let Some(tag_len) = lower[after..].find('>') else {
            break;
        };
        let tag_end = after + tag_len;
        pos = tag_end;
        let Some(value) = attribute(&lower[after..tag_end], "href") else {
            continue;
        };
        let range = after + value.start..after + value.end;
        let href = html[range.clone()].trim().replace("&amp;", "&");
        let text_end = lower[tag_end..]
            .find("</a")
            .map_or(tag_end, |i| tag_end + i);
        let text = plain_text(&html[(tag_end + 1).min(text_end)..text_end]);
        let line = html[..range.start].matches('\n').count() as u32;
        let link = |kind, target: String, subpath: Option<String>, alias: Option<String>| Link {
            kind,
            embed: false,
            target,
            subpath: subpath.filter(|s| !s.is_empty()),
            alias: alias.filter(|a| !a.is_empty()),
            range: range.clone(),
            line,
            in_frontmatter: false,
        };

        if let Some(inner) = href.strip_prefix("[[").and_then(|h| h.strip_suffix("]]")) {
            let (target, alias) = match inner.split_once('|') {
                Some((t, a)) => (t, Some(a.to_string())),
                None => (inner, None),
            };
            let (target, subpath) = match target.split_once('#') {
                Some((t, s)) => (t, Some(s.to_string())),
                None => (target, None),
            };
            links.push(link(
                LinkKind::Wiki,
                target.trim().to_string(),
                subpath,
                alias.or(Some(text)),
            ));
            continue;
        }
        // Web links, other schemes, server paths and anchors on this page.
        let scheme = href.find(':').is_some_and(|c| !href[..c].contains('/'));
        if href.is_empty() || scheme || href.starts_with('/') || href.starts_with('#') {
            continue;
        }
        let (rel, fragment) = match href.split_once('#') {
            Some((r, f)) => (r, Some(f.to_string())),
            None => (href.as_str(), None),
        };
        let rel = rel.split('?').next().unwrap_or_default();
        let rel = percent_encoding::percent_decode_str(rel).decode_utf8_lossy();
        let Some(target) = crate::index::join_normalized(dir, &rel) else {
            continue;
        };
        if target.is_empty() || (bundle && target.starts_with(&format!("{page}/"))) {
            continue;
        }
        links.push(link(LinkKind::Markdown, target, fragment, Some(text)));
    }
    links
}

/// The byte range of `name`'s value in a lowercased tag's attributes.
fn attribute(tag: &str, name: &str) -> Option<std::ops::Range<usize>> {
    let bytes = tag.as_bytes();
    let mut from = 0;
    while let Some(i) = tag[from..].find(name) {
        let start = from + i;
        from = start + name.len();
        if start > 0 && !bytes[start - 1].is_ascii_whitespace() {
            continue;
        }
        let mut j = from;
        while bytes.get(j).is_some_and(u8::is_ascii_whitespace) {
            j += 1;
        }
        if bytes.get(j) != Some(&b'=') {
            continue;
        }
        j += 1;
        while bytes.get(j).is_some_and(u8::is_ascii_whitespace) {
            j += 1;
        }
        return match bytes.get(j) {
            Some(&quote @ (b'"' | b'\'')) => {
                let end = tag[j + 1..].find(quote as char)? + j + 1;
                Some(j + 1..end)
            }
            Some(_) => {
                let end = tag[j..]
                    .find(|c: char| c.is_ascii_whitespace())
                    .map_or(tag.len(), |e| j + e);
                Some(j..end)
            }
            None => None,
        };
    }
    None
}

/// HTML as plain text: tags dropped, whitespace collapsed.
pub fn plain_text(html: &str) -> String {
    let mut text = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                text.push(' ');
            }
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    let text = text
        .replace("&amp;", "&")
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

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

    #[test]
    fn finds_links_to_vault_files_in_pages() {
        let html = r##"<html><body>
<p><a href="../../Acme.md">Back to <b>Acme</b></a> · <A class="x" HREF='[[2026-11-02 Kickoff#Agenda|kickoff]]'>Kickoff</A></p>
<a href="other.html">in the bundle</a> <a href="./img/a.png">also</a>
<a href="https://example.com">web</a> <a href="mailto:a@b.c">mail</a> <a href="#top">top</a>
<a href="/page/x">server</a> <abbr title="x">not a link</abbr> <a>no href</a>
<a href="../Notes%20Here.md?x=1#Part">spaces</a>
</body></html>"##;
        let links = links(html, "Projects/Acme/demos/login-flow.page");
        let summary: Vec<_> = links
            .iter()
            .map(|l| {
                (
                    l.kind,
                    l.target.as_str(),
                    l.subpath.as_deref(),
                    l.alias.as_deref(),
                    l.line,
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                (
                    LinkKind::Markdown,
                    "Projects/Acme/Acme.md",
                    None,
                    Some("Back to Acme"),
                    1
                ),
                (
                    LinkKind::Wiki,
                    "2026-11-02 Kickoff",
                    Some("Agenda"),
                    Some("kickoff"),
                    1
                ),
                (
                    LinkKind::Markdown,
                    "Projects/Acme/demos/Notes Here.md",
                    Some("Part"),
                    Some("spaces"),
                    5
                ),
            ]
        );
        assert_eq!(&html[links[0].range.clone()], "../../Acme.md");

        // A single file's links are relative to its folder; it has no bundle.
        let single = links_of(r#"<a href="../Acme.md">Acme</a> <a href="x.html">x</a>"#);
        assert_eq!(single, ["Projects/Acme.md", "Projects/demos/x.html"]);
        // Links can't leave the vault.
        assert!(links_of(r#"<a href="../../../../x.md">x</a>"#).is_empty());
    }

    fn links_of(html: &str) -> Vec<String> {
        links(html, "Projects/demos/sketch.html")
            .into_iter()
            .map(|l| l.target)
            .collect()
    }
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
