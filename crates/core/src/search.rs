//! Full-text search over notes, and tag counts for the tags pane.
//!
//! Search reads note files on each query, like unlinked mentions do. That's
//! fast enough for personal vaults; a persistent FTS index can replace it
//! without changing these types.

use std::collections::BTreeMap;

use rayon::prelude::*;
use regex::Regex;
use serde::Serialize;
use ts_rs::TS;

use crate::index::{Index, link_name};
use crate::parse::LineIndex;
use crate::tree::NodeKind;

/// Lines shown per file.
const LINES_PER_FILE: usize = 5;
/// Characters of a long line shown before its first hit.
const LEAD: usize = 60;
const MAX_LINE: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    /// Total matches in the note, including ones not listed in `lines`.
    pub hits: u32,
    pub lines: Vec<SearchLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchLine {
    /// Zero-based line number.
    pub line: u32,
    /// The line (or a window of a long one), split into matched and plain text.
    pub segments: Vec<SearchSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchSegment {
    pub text: String,
    pub hit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TagCount {
    /// Without `#`, as first written in the vault.
    pub tag: String,
    /// Notes with the tag.
    pub count: u32,
}

/// A parsed search query. Words must all appear; `"quoted text"` is one
/// term; `-word` excludes; `path:` and `tag:` (or `#tag`) filter.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Query {
    pub terms: Vec<String>,
    pub excluded: Vec<String>,
    pub paths: Vec<String>,
    pub tags: Vec<String>,
}

impl Query {
    pub fn parse(text: &str) -> Self {
        let mut q = Self::default();
        for token in tokens(text) {
            let lower = token.to_lowercase();
            if let Some(rest) = lower.strip_prefix("path:") {
                q.paths.push(rest.to_string());
            } else if let Some(rest) = lower.strip_prefix("tag:") {
                q.tags.push(rest.trim_start_matches('#').to_string());
            } else if let Some(rest) = lower.strip_prefix('#').filter(|r| !r.is_empty()) {
                q.tags.push(rest.to_string());
            } else if let Some(rest) = token.strip_prefix('-').filter(|r| !r.is_empty()) {
                q.excluded.push(rest.to_string());
            } else {
                q.terms.push(token);
            }
        }
        q.paths.retain(|p| !p.is_empty());
        q.tags.retain(|t| !t.is_empty());
        q
    }

    pub fn is_empty(&self) -> bool {
        self.terms.is_empty() && self.paths.is_empty() && self.tags.is_empty()
    }
}

/// Splits on whitespace, keeping `"quoted text"` (also after `path:` etc.) together.
fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in text.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn pattern(term: &str) -> Regex {
    Regex::new(&format!("(?i){}", regex::escape(term))).unwrap()
}

/// Notes matching `query`, best first.
pub fn search(index: &Index, query: &str, limit: usize) -> Vec<SearchResult> {
    let q = Query::parse(query);
    if q.is_empty() {
        return Vec::new();
    }
    let terms: Vec<Regex> = q.terms.iter().map(|t| pattern(t)).collect();
    let excluded: Vec<Regex> = q.excluded.iter().map(|t| pattern(t)).collect();

    // Each note is read from disk: across the cores.
    let notes: Vec<_> = index.notes().collect();
    let mut scored: Vec<(usize, SearchResult)> = notes
        .par_iter()
        .filter_map(|&(path, note)| {
            let lower_path = path.to_lowercase();
            if !q.paths.iter().all(|p| lower_path.contains(p.as_str())) {
                return None;
            }
            let has_tag = |wanted: &String| {
                note.tags.iter().any(|t| {
                    let t = t.to_lowercase();
                    t == *wanted || t.starts_with(&format!("{wanted}/"))
                })
            };
            if !q.tags.iter().all(has_tag) {
                return None;
            }
            let title = link_name(path, NodeKind::Note).to_string();
            let text = index.read_text(path)?;
            if !terms
                .iter()
                .all(|t| t.is_match(&text) || t.is_match(&title))
            {
                return None;
            }
            if excluded
                .iter()
                .any(|t| t.is_match(&text) || t.is_match(&title))
            {
                return None;
            }

            let title_hits: usize = terms.iter().map(|t| t.find_iter(&title).count()).sum();
            let (hits, lines) = matching_lines(&text, &terms);
            let score = title_hits * 10 + hits;
            Some((
                score,
                SearchResult {
                    path: path.to_string(),
                    title,
                    hits: hits as u32,
                    lines,
                },
            ))
        })
        .collect();
    scored.sort_by(|(a, ra), (b, rb)| b.cmp(a).then_with(|| ra.path.cmp(&rb.path)));
    scored.into_iter().take(limit).map(|(_, r)| r).collect()
}

/// Every match of any term, merged where they overlap.
fn hit_ranges(line: &str, terms: &[Regex]) -> Vec<(usize, usize)> {
    let mut ranges: Vec<(usize, usize)> = terms
        .iter()
        .flat_map(|t| t.find_iter(line).map(|m| (m.start(), m.end())))
        .collect();
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in ranges {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

fn matching_lines(text: &str, terms: &[Regex]) -> (usize, Vec<SearchLine>) {
    let lines = LineIndex::new(text);
    let mut total = 0;
    let mut out = Vec::new();
    let mut offset = 0;
    for raw in text.split_inclusive('\n') {
        let line = raw.trim_end_matches(['\n', '\r']);
        let hits = hit_ranges(line, terms);
        total += hits.len();
        if !hits.is_empty() && out.len() < LINES_PER_FILE {
            out.push(SearchLine {
                line: lines.line_of(offset),
                segments: segments(line, &hits),
            });
        }
        offset += raw.len();
    }
    (total, out)
}

/// `line` split at its hits, cut to a window around the first hit if long.
fn segments(line: &str, hits: &[(usize, usize)]) -> Vec<SearchSegment> {
    let floor = |i: usize| {
        (0..=i)
            .rev()
            .find(|&i| line.is_char_boundary(i))
            .unwrap_or(0)
    };
    let mut start = 0;
    let mut end = line.len();
    if line.len() > MAX_LINE {
        start = floor(hits[0].0.saturating_sub(LEAD));
        end = floor((start + MAX_LINE).min(line.len()));
    }
    let mut out = Vec::new();
    let mut push = |text: &str, hit: bool| {
        if !text.is_empty() {
            out.push(SearchSegment {
                text: text.to_string(),
                hit,
            });
        }
    };
    if start > 0 {
        push("…", false);
    }
    let mut at = start;
    for &(s, e) in hits {
        if s >= end {
            break;
        }
        let (s, e) = (s.max(at), e.min(end));
        if s < at {
            continue;
        }
        push(&line[at..s], false);
        push(&line[s..e], true);
        at = e;
    }
    push(&line[at..end], false);
    if end < line.len() {
        push("…", false);
    }
    out
}

/// Every tag with the number of notes using it, sorted by name.
pub fn tags(index: &Index) -> Vec<TagCount> {
    let mut counts: BTreeMap<String, TagCount> = BTreeMap::new();
    for (_, note) in index.notes() {
        for tag in &note.tags {
            counts
                .entry(tag.to_lowercase())
                .or_insert_with(|| TagCount {
                    tag: tag.clone(),
                    count: 0,
                })
                .count += 1;
        }
    }
    counts.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::tests::temp_vault;

    fn paths(results: &[SearchResult]) -> Vec<&str> {
        results.iter().map(|r| r.path.as_str()).collect()
    }

    #[test]
    fn parses_queries() {
        let q = Query::parse(r#"auth "token refresh" -draft path:Projects/acme tag:#Work #urgent"#);
        assert_eq!(q.terms, ["auth", "token refresh"]);
        assert_eq!(q.excluded, ["draft"]);
        assert_eq!(q.paths, ["projects/acme"]);
        assert_eq!(q.tags, ["work", "urgent"]);
        assert!(Query::parse("  ").is_empty());
    }

    #[test]
    fn finds_notes_with_every_term_titles_first() {
        let (_dir, index) = temp_vault(&[
            ("Auth migration.md", "Plan for the migration.\n"),
            (
                "Notes.md",
                "We talked about auth.\nThe migration starts Monday.\nAuth again.\n",
            ),
            ("Other.md", "Only auth here.\n"),
        ]);
        let results = search(&index, "auth migration", 10);
        assert_eq!(paths(&results), ["Auth migration.md", "Notes.md"]);
        let notes = &results[1];
        assert_eq!(notes.hits, 3);
        assert_eq!(
            notes.lines.iter().map(|l| l.line).collect::<Vec<_>>(),
            [0, 1, 2]
        );
        assert_eq!(
            notes.lines[0].segments,
            [
                SearchSegment {
                    text: "We talked about ".into(),
                    hit: false
                },
                SearchSegment {
                    text: "auth".into(),
                    hit: true
                },
                SearchSegment {
                    text: ".".into(),
                    hit: false
                },
            ]
        );
    }

    #[test]
    fn phrases_exclusions_and_filters() {
        let (_dir, index) = temp_vault(&[
            (
                "Projects/Acme/Plan.md",
                "---\ntags: [work/acme]\n---\nToken refresh plan\n",
            ),
            ("Projects/Beta/Plan.md", "#work Token refresh draft\n"),
            ("Personal.md", "refresh the token\n"),
        ]);
        assert_eq!(
            paths(&search(&index, r#""token refresh""#, 10)),
            ["Projects/Acme/Plan.md", "Projects/Beta/Plan.md"]
        );
        assert_eq!(
            paths(&search(&index, "token -draft", 10)),
            ["Personal.md", "Projects/Acme/Plan.md"]
        );
        assert_eq!(
            paths(&search(&index, "path:acme", 10)),
            ["Projects/Acme/Plan.md"]
        );
        // A parent tag matches nested ones.
        assert_eq!(
            paths(&search(&index, "#work", 10)),
            ["Projects/Acme/Plan.md", "Projects/Beta/Plan.md"]
        );
        assert_eq!(
            paths(&search(&index, "tag:work/acme", 10)),
            ["Projects/Acme/Plan.md"]
        );
    }

    #[test]
    fn long_lines_show_a_window_around_the_hit() {
        let line = format!("{} needle {}", "a".repeat(300), "b".repeat(300));
        let (_dir, index) = temp_vault(&[("Long.md", line.as_str())]);
        let segs = &search(&index, "needle", 10)[0].lines[0].segments;
        assert_eq!(segs.first().unwrap().text, "…");
        assert_eq!(segs.last().unwrap().text, "…");
        assert!(segs.iter().any(|s| s.hit && s.text == "needle"));
        let shown: usize = segs.iter().map(|s| s.text.len()).sum();
        assert!(shown <= MAX_LINE + 6, "{shown}");
    }

    #[test]
    fn counts_tags_case_insensitively() {
        let (_dir, index) = temp_vault(&[
            ("A.md", "#Work #idea"),
            ("B.md", "---\ntags: [work]\n---\n"),
        ]);
        assert_eq!(
            tags(&index),
            [
                TagCount {
                    tag: "idea".into(),
                    count: 1
                },
                TagCount {
                    tag: "Work".into(),
                    count: 2
                },
            ]
        );
    }
}
