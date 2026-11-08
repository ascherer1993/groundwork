//! Extracts what Groundwork indexes from a Markdown note: frontmatter, links,
//! headings, block ids, tags and tasks.
//!
//! Every link keeps its exact byte range in the source, because rename/move
//! rewrites links in place. Anything inside code (fenced, indented or inline)
//! or a `%% comment %%` is ignored, as in Obsidian.

use std::ops::Range;
use std::sync::LazyLock;

use chrono::NaiveDate;
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use ts_rs::TS;

#[derive(Debug, Clone, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ParsedNote {
    /// The YAML frontmatter as JSON (an object), or `null` if absent or invalid.
    #[ts(type = "Record<string, unknown> | null")]
    pub frontmatter: Option<Value>,
    /// Byte range of the frontmatter block including its `---` fences.
    #[ts(skip)]
    #[serde(skip)]
    pub frontmatter_range: Option<Range<usize>>,
    pub links: Vec<Link>,
    pub headings: Vec<Heading>,
    pub blocks: Vec<BlockId>,
    /// Lowercase-preserving tags without `#`, frontmatter tags first, deduplicated.
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub tasks: Vec<Task>,
    /// Byte ranges that aren't prose: frontmatter, code, comments and links.
    /// Unlinked-mention search skips these.
    #[ts(skip)]
    #[serde(skip)]
    pub excluded: Vec<Range<usize>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum LinkKind {
    /// `[[target#sub|alias]]`
    Wiki,
    /// `[text](target.md#sub)`
    Markdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Link {
    pub kind: LinkKind,
    /// `![[...]]` or `![...](...)`.
    pub embed: bool,
    /// The link path as written (percent-decoded for Markdown links), without subpath.
    pub target: String,
    /// `Heading`, `Parent#Child` or `^block-id`, without the leading `#`.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subpath: Option<String>,
    /// Display text: the wikilink alias or the Markdown link text.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    /// Byte range of the whole link in the file, including `!` and brackets.
    #[ts(type = "{ start: number, end: number }")]
    pub range: Range<usize>,
    /// Zero-based line number.
    pub line: u32,
    pub in_frontmatter: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BlockId {
    pub id: String,
    pub line: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TaskStatus {
    Todo,
    Done,
    Cancelled,
    /// Any other status character, e.g. `[/]` or `[>]`.
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Task {
    pub line: u32,
    pub status: TaskStatus,
    /// The character between the brackets.
    pub status_char: String,
    /// Task text with metadata markers and block id removed.
    pub text: String,
    /// `p0`–`p5`; `p3` when no marker is present.
    pub priority: u8,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled: Option<String>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<String>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<String>,
}

static WIKILINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(!?)\[\[([^\[\]\n]+?)\]\]").unwrap());
static TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[\s,;])#([\p{L}\p{N}_/\-]+)").unwrap());
static BLOCK_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|\s)\^([A-Za-z0-9\-]+)\s*$").unwrap());
static TASK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[(.)\]\s?(.*)$").unwrap());
static TASK_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(📅|⏳|🛫|➕|✅|❌)\u{FE0F}?\s*(\d{4}-\d{2}-\d{2})").unwrap());
static TASK_PRIORITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(🔺|⏫|🔼|🔽|⏬)\u{FE0F}?").unwrap());
static TASK_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)(.)(\].*)$").unwrap());
static DONE_STAMP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*✅\u{FE0F}?\s*\d{4}-\d{2}-\d{2}").unwrap());
static CANCEL_STAMP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*❌\u{FE0F}?\s*\d{4}-\d{2}-\d{2}").unwrap());
static URL_SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9+.\-]*:").unwrap());

/// Tasks-plugin priority markers, indexed by `p` level (p3 has no marker).
pub const PRIORITY_MARKERS: [Option<&str>; 6] = [
    Some("🔺"),
    Some("⏫"),
    Some("🔼"),
    None,
    Some("🔽"),
    Some("⏬"),
];

pub fn parse(text: &str) -> ParsedNote {
    let lines = LineIndex::new(text);
    let (frontmatter_range, frontmatter) = split_frontmatter(text);
    let body_start = frontmatter_range.as_ref().map_or(0, |r| r.end);

    let mut note = ParsedNote {
        frontmatter_range: frontmatter_range.clone(),
        ..Default::default()
    };

    let mut excluded = Vec::new();
    let mut markdown_links = Vec::new();
    scan_body(
        &text[body_start..],
        body_start,
        &lines,
        &mut excluded,
        &mut markdown_links,
        &mut note.headings,
    );
    excluded.extend(comment_ranges(text, body_start, &excluded));
    excluded.sort_by_key(|r| r.start);
    let is_excluded = |range: &Range<usize>| {
        excluded
            .iter()
            .any(|e| range.start < e.end && e.start < range.end)
    };

    // Wikilinks, in the body and in frontmatter values (Obsidian indexes both).
    for caps in WIKILINK.captures_iter(text) {
        let whole = caps.get(0).unwrap();
        let range = whole.range();
        if is_excluded(&range) {
            continue;
        }
        let in_frontmatter = frontmatter_range
            .as_ref()
            .is_some_and(|fm| fm.contains(&range.start));
        let (target, subpath, alias) = split_wikilink(&caps[2]);
        note.links.push(Link {
            kind: LinkKind::Wiki,
            embed: !caps[1].is_empty(),
            target,
            subpath,
            alias,
            line: lines.line_of(range.start),
            range,
            in_frontmatter,
        });
    }
    for link in markdown_links {
        if !is_excluded(&link.range) {
            note.links.push(link);
        }
    }
    note.links.sort_by_key(|l| l.range.start);

    // Line-based items: tasks, block ids, inline tags.
    let mut tags = Vec::new();
    if let Some(Value::Object(map)) = &frontmatter {
        tags.extend(string_list(map, &["tags", "tag"]));
        note.aliases = string_list(map, &["aliases", "alias"]);
    }
    for (line_no, line_range) in lines.ranges(text) {
        if line_range.start < body_start || is_excluded(&line_range) {
            continue;
        }
        let line = &text[line_range.clone()];
        if let Some(caps) = TASK.captures(line) {
            note.tasks.push(parse_task(line_no, &caps[1], &caps[2]));
        }
        if let Some(caps) = BLOCK_ID.captures(line) {
            note.blocks.push(BlockId {
                id: caps[1].to_string(),
                line: line_no,
            });
        }
        for caps in TAG.captures_iter(line) {
            let m = caps.get(1).unwrap();
            let abs = line_range.start + m.start() - 1..line_range.start + m.end();
            let tag = m.as_str().trim_end_matches('/');
            if !tag.is_empty()
                && !tag.chars().all(|c| c.is_ascii_digit())
                && !is_excluded(&abs)
                && !note.links.iter().any(|l| l.range.contains(&abs.start))
            {
                tags.push(tag.to_string());
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    note.tags = tags
        .into_iter()
        .filter(|t| seen.insert(t.to_lowercase()))
        .collect();
    note.frontmatter = frontmatter;
    excluded.extend(frontmatter_range);
    excluded.extend(note.links.iter().map(|l| l.range.clone()));
    excluded.sort_by_key(|r| r.start);
    note.excluded = excluded;
    note
}

/// Checks an open task (adding `✅ today` before any block id) or unchecks a
/// done one (removing its `✅` stamp). `None` if the line isn't a task.
pub fn toggle_task_line(line: &str, today: &str) -> Option<String> {
    let caps = TASK_PREFIX.captures(line)?;
    let status = if matches!(&caps[2], "x" | "X") {
        ' '
    } else {
        'x'
    };
    set_task_status(line, status, today)
}

/// Sets a task's status character, keeping the stamps in step: `x` adds
/// `✅ today`, `-` adds `❌ today`, anything else removes both.
pub fn set_task_status(line: &str, status: char, today: &str) -> Option<String> {
    let caps = TASK_PREFIX.captures(line)?;
    let (prefix, old, rest) = (&caps[1], &caps[2], &caps[3]);
    let new = status.to_string();
    if old.eq_ignore_ascii_case(&new) {
        return Some(line.to_string());
    }
    // `rest` starts with the closing `]`.
    let body = DONE_STAMP.replace_all(&rest[1..], "");
    let body = CANCEL_STAMP.replace_all(&body, "").into_owned();
    let body = match status {
        'x' | 'X' => insert_meta(&body, &format!("✅ {today}")),
        '-' => insert_meta(&body, &format!("❌ {today}")),
        _ => body,
    };
    Some(format!("{prefix}{status}]{body}"))
}

/// Sets (or with `None` removes) a task's date for `marker` (`📅`, `⏳`, `➕`…).
pub fn set_task_date(line: &str, marker: &str, date: Option<&str>) -> Option<String> {
    let caps = TASK_PREFIX.captures(line)?;
    let (prefix, status, rest) = (&caps[1], &caps[2], &caps[3]);
    let existing = Regex::new(&format!(
        r"\s*{marker}\u{{FE0F}}?\s*\d{{4}}-\d{{2}}-\d{{2}}"
    ))
    .ok()?;
    let body = existing.replace_all(&rest[1..], "").into_owned();
    let body = match date {
        Some(date) => insert_meta(&body, &format!("{marker} {date}")),
        None => body,
    };
    Some(format!("{prefix}{status}]{body}"))
}

/// Sets a task's priority, `p0`–`p5` (p3 removes the marker).
pub fn set_task_priority(line: &str, priority: u8) -> Option<String> {
    let caps = TASK_PREFIX.captures(line)?;
    let (prefix, status, rest) = (&caps[1], &caps[2], &caps[3]);
    let without = Regex::new(r"\s*(?:🔺|⏫|🔼|🔽|⏬)\u{FE0F}?").unwrap();
    let body = without.replace_all(&rest[1..], "").into_owned();
    let body = match PRIORITY_MARKERS
        .get(usize::from(priority))
        .copied()
        .flatten()
    {
        Some(marker) => insert_meta(&body, marker),
        None => body,
    };
    Some(format!("{prefix}{status}]{body}"))
}

/// Appends a metadata marker to a task's text, before any block id.
fn insert_meta(body: &str, meta: &str) -> String {
    let body = body.trim_end();
    match BLOCK_ID.find(body) {
        Some(m) => format!(
            "{} {meta}{}",
            body[..m.start()].trim_end(),
            &body[m.start()..]
        ),
        None if body.is_empty() => format!(" {meta}"),
        None => format!("{body} {meta}"),
    }
}

/// A new task line: `- [ ] text 🔼 📅 due ➕ created`.
pub fn new_task_line(text: &str, priority: u8, due: Option<&str>, created: &str) -> String {
    let mut line = format!("- [ ] {}", text.trim());
    if let Some(marker) = PRIORITY_MARKERS
        .get(usize::from(priority))
        .copied()
        .flatten()
    {
        line = format!("{line} {marker}");
    }
    if let Some(due) = due {
        line = format!("{line} 📅 {due}");
    }
    format!("{line} ➕ {created}")
}

/// A todo as typed: its text, with `@date` and `!p1` (or `@p1`) pulled
/// out, as are the `📅 date` and priority markers the editor's completions
/// insert. Mirrors `parseTodoInput` in `app/src/markdown/todos.ts`.
pub fn todo_input(input: &str, today: NaiveDate) -> (String, Option<NaiveDate>, Option<u8>) {
    static DUE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"📅\u{FE0F}?\s*(\d{4}-\d{2}-\d{2})").unwrap());
    // Two-word dates first (`@nov 12`), then one word.
    static TYPED_DATES: LazyLock<[Regex; 2]> = LazyLock::new(|| {
        [
            Regex::new(r"(?:^|\s)@(\w+ \d{1,2})(?:\s|$)").unwrap(),
            Regex::new(r"(?:^|\s)@(\S+)").unwrap(),
        ]
    });
    static TYPED_PRIORITY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)(?:^|\s)[!@]p([0-5])(?:\s|$)").unwrap());

    let mut due = DUE
        .captures(input)
        .and_then(|c| NaiveDate::parse_from_str(&c[1], "%Y-%m-%d").ok());
    let mut priority = TASK_PRIORITY.captures(input).and_then(|c| {
        PRIORITY_MARKERS
            .iter()
            .position(|m| *m == Some(&c[1]))
            .map(|p| p as u8)
    });
    let text = DUE.replace_all(input, " ");
    let mut text = TASK_PRIORITY.replace_all(&text, " ").into_owned();
    for re in TYPED_DATES.iter() {
        let found = re.captures(&text).and_then(|c| {
            let date = crate::dates::parse_natural(&c[1], today)?;
            Some((c.get(0).unwrap().range(), date))
        });
        if let Some((range, date)) = found {
            due = Some(date);
            text.replace_range(range, " ");
            break;
        }
    }
    if let Some(c) = TYPED_PRIORITY.captures(&text) {
        priority = c[1].parse().ok();
        let range = c.get(0).unwrap().range();
        text.replace_range(range, " ");
    }
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (text, due, priority)
}

/// Parses one line as a task (line number 0).
pub fn parse_task_line(line: &str) -> Option<Task> {
    let caps = TASK.captures(line)?;
    Some(parse_task(0, &caps[1], &caps[2]))
}

/// Returns the frontmatter's byte range (fences included) and its parsed value.
fn split_frontmatter(text: &str) -> (Option<Range<usize>>, Option<Value>) {
    let first_line_end = text.find('\n').map_or(text.len(), |i| i + 1);
    if text[..first_line_end].trim_end() != "---" {
        return (None, None);
    }
    let mut offset = first_line_end;
    for line in text[first_line_end..].split_inclusive('\n') {
        let trimmed = line.trim_end();
        if trimmed == "---" || trimmed == "..." {
            let yaml = &text[first_line_end..offset];
            let range = 0..offset + line.len();
            let value = if yaml.trim().is_empty() {
                Some(Value::Object(Map::new()))
            } else {
                serde_saphyr::from_str::<Value>(yaml)
                    .ok()
                    .filter(Value::is_object)
            };
            return (Some(range), value);
        }
        offset += line.len();
    }
    (None, None)
}

/// Walks the Markdown body with pulldown-cmark, collecting code ranges (to
/// exclude), Markdown links and headings. Offsets are shifted by `base`.
fn scan_body(
    body: &str,
    base: usize,
    lines: &LineIndex,
    excluded: &mut Vec<Range<usize>>,
    links: &mut Vec<Link>,
    headings: &mut Vec<Heading>,
) {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_MATH;
    let mut heading: Option<(u8, usize, String)> = None;
    let mut link: Option<(bool, String, Range<usize>, String)> = None;

    for (event, range) in Parser::new_ext(body, options).into_offset_iter() {
        let abs = base + range.start..base + range.end;
        match event {
            // Start events span the whole element: fenced or indented code blocks.
            Event::Start(Tag::CodeBlock(_))
            | Event::Code(_)
            | Event::InlineMath(_)
            | Event::DisplayMath(_) => excluded.push(abs),
            Event::Start(Tag::Heading { level, .. }) => {
                heading = Some((heading_level(level), abs.start, String::new()));
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((level, start, text)) = heading.take() {
                    headings.push(Heading {
                        level,
                        text: strip_block_id(text.trim()).to_string(),
                        line: lines.line_of(start),
                    });
                }
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                link = Some((false, dest_url.to_string(), abs, String::new()));
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                link = Some((true, dest_url.to_string(), abs, String::new()));
            }
            Event::End(TagEnd::Link) | Event::End(TagEnd::Image) => {
                if let Some((embed, dest, range, text)) = link.take()
                    && let Some(link) = markdown_link(embed, &dest, range, text, lines)
                {
                    links.push(link);
                }
            }
            Event::Text(t) => {
                if let Some((_, _, text)) = heading.as_mut() {
                    text.push_str(&t);
                }
                if let Some((_, _, _, text)) = link.as_mut() {
                    text.push_str(&t);
                }
            }
            _ => {}
        }
    }
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// A Markdown link to a vault file (or `#anchor` in the same note); external URLs are skipped.
fn markdown_link(
    embed: bool,
    dest: &str,
    range: Range<usize>,
    text: String,
    lines: &LineIndex,
) -> Option<Link> {
    let dest = dest.trim().trim_start_matches('<').trim_end_matches('>');
    if dest.is_empty() || URL_SCHEME.is_match(dest) {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(dest)
        .decode_utf8_lossy()
        .into_owned();
    let (target, subpath) = match decoded.split_once('#') {
        Some((t, s)) => (t.to_string(), Some(s.to_string()).filter(|s| !s.is_empty())),
        None => (decoded, None),
    };
    Some(Link {
        kind: LinkKind::Markdown,
        embed,
        target,
        subpath,
        alias: Some(text).filter(|t| !t.is_empty()),
        line: lines.line_of(range.start),
        range,
        in_frontmatter: false,
    })
}

/// Splits `target#subpath|alias`. `\|` (used inside tables) also separates the alias.
pub fn split_wikilink(inner: &str) -> (String, Option<String>, Option<String>) {
    let (link, alias) = match inner.find('|') {
        Some(i) => {
            let link = inner[..i].strip_suffix('\\').unwrap_or(&inner[..i]);
            (link, Some(inner[i + 1..].to_string()))
        }
        None => (inner, None),
    };
    let (target, subpath) = match link.split_once('#') {
        Some((t, s)) => (t, Some(s.to_string()).filter(|s| !s.is_empty())),
        None => (link, None),
    };
    (target.trim().to_string(), subpath, alias)
}

/// `%% … %%` comment ranges (inline or spanning lines) outside code.
fn comment_ranges(text: &str, body_start: usize, code: &[Range<usize>]) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut search = body_start;
    while let Some(start) = text[search..].find("%%").map(|i| search + i) {
        if let Some(c) = code.iter().find(|c| c.contains(&start)) {
            search = c.end;
            continue;
        }
        let end = text[start + 2..]
            .find("%%")
            .map_or(text.len(), |i| start + 2 + i + 2);
        ranges.push(start..end);
        search = end;
    }
    ranges
}

fn strip_block_id(text: &str) -> &str {
    BLOCK_ID
        .find(text)
        .map_or(text, |m| text[..m.start()].trim_end())
}

fn parse_task(line: u32, status_char: &str, rest: &str) -> Task {
    let status = match status_char {
        " " => TaskStatus::Todo,
        "x" | "X" => TaskStatus::Done,
        "-" => TaskStatus::Cancelled,
        _ => TaskStatus::Other,
    };
    let mut task = Task {
        line,
        status,
        status_char: status_char.to_string(),
        text: String::new(),
        priority: 3,
        due: None,
        scheduled: None,
        created: None,
        done: None,
        cancelled: None,
    };
    for caps in TASK_DATE.captures_iter(rest) {
        let date = Some(caps[2].to_string());
        match &caps[1] {
            "📅" => task.due = date,
            "⏳" => task.scheduled = date,
            "➕" => task.created = date,
            "✅" => task.done = date,
            "❌" => task.cancelled = date,
            _ => {}
        }
    }
    if let Some(caps) = TASK_PRIORITY.captures(rest) {
        task.priority = PRIORITY_MARKERS
            .iter()
            .position(|m| *m == Some(&caps[1]))
            .unwrap_or(3) as u8;
    }
    let text = TASK_DATE.replace_all(rest, "");
    let text = TASK_PRIORITY.replace_all(&text, "");
    // 🛫 start dates and 🔁 recurrence aren't modelled yet; drop their markers from the text.
    task.text = strip_block_id(
        text.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .as_str(),
    )
    .to_string();
    task
}

/// Reads a frontmatter field that may be a list or a comma/space separated string.
fn string_list(map: &Map<String, Value>, keys: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for key in keys {
        match map.get(*key) {
            Some(Value::Array(items)) => {
                out.extend(items.iter().filter_map(value_to_string));
            }
            Some(Value::String(s)) => {
                let split: Vec<&str> = if *key == "aliases" || *key == "alias" {
                    s.split(',').collect()
                } else {
                    s.split([',', ' ']).collect()
                };
                out.extend(split.into_iter().map(str::to_string));
            }
            _ => {}
        }
    }
    out.into_iter()
        .map(|s| s.trim().trim_start_matches('#').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Maps byte offsets to zero-based line numbers.
pub struct LineIndex {
    starts: Vec<usize>,
}

impl LineIndex {
    pub fn new(text: &str) -> Self {
        let mut starts = vec![0];
        starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        Self { starts }
    }

    pub fn line_of(&self, offset: usize) -> u32 {
        (self.starts.partition_point(|&s| s <= offset) - 1) as u32
    }

    /// `(line number, byte range without the newline)` for every line.
    fn ranges<'a>(&'a self, text: &'a str) -> impl Iterator<Item = (u32, Range<usize>)> + 'a {
        self.starts.iter().enumerate().map(move |(i, &start)| {
            let end = self.starts.get(i + 1).map_or(text.len(), |&next| next - 1);
            let end = if end > start && text.as_bytes()[end - 1] == b'\r' {
                end - 1
            } else {
                end
            };
            (i as u32, start..end.max(start))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wikis(note: &ParsedNote) -> Vec<(&str, Option<&str>, Option<&str>, bool)> {
        note.links
            .iter()
            .filter(|l| l.kind == LinkKind::Wiki)
            .map(|l| {
                (
                    l.target.as_str(),
                    l.subpath.as_deref(),
                    l.alias.as_deref(),
                    l.embed,
                )
            })
            .collect()
    }

    #[test]
    fn wikilink_forms() {
        let note = parse(
            "[[A]] [[B|Bee]] [[C#Heading]] [[D#^blk|alias]] ![[img.png]] [[Folder/E]] [[#Local]]",
        );
        assert_eq!(
            wikis(&note),
            [
                ("A", None, None, false),
                ("B", None, Some("Bee"), false),
                ("C", Some("Heading"), None, false),
                ("D", Some("^blk"), Some("alias"), false),
                ("img.png", None, None, true),
                ("Folder/E", None, None, false),
                ("", Some("Local"), None, false),
            ]
        );
    }

    #[test]
    fn link_ranges_cover_the_whole_link() {
        let text = "See ![[Note|x]] here";
        let link = &parse(text).links[0];
        assert_eq!(&text[link.range.clone()], "![[Note|x]]");
    }

    #[test]
    fn escaped_pipe_in_tables() {
        let note = parse("| a | [[Note\\|Alias]] |\n|---|---|\n");
        assert_eq!(wikis(&note), [("Note", None, Some("Alias"), false)]);
    }

    #[test]
    fn ignores_links_in_code_and_comments() {
        let text = "`[[Inline]]`\n\n```\n[[Fenced]]\n```\n\n    [[Indented]]\n\n%% [[Comment]] %%\n\n%%\n[[Multi]]\n%%\n\n[[Real]]";
        let note = parse(text);
        assert_eq!(wikis(&note), [("Real", None, None, false)]);
    }

    #[test]
    fn markdown_links() {
        let text = "[Daily](Daily/2026-11-03.md) [Sp](My%20Note.md#Part) ![pic](a.png) [web](https://x.y) [anchor](#top)";
        let note = parse(text);
        let md: Vec<_> = note
            .links
            .iter()
            .map(|l| {
                (
                    l.target.as_str(),
                    l.subpath.as_deref(),
                    l.alias.as_deref(),
                    l.embed,
                )
            })
            .collect();
        assert_eq!(
            md,
            [
                ("Daily/2026-11-03.md", None, Some("Daily"), false),
                ("My Note.md", Some("Part"), Some("Sp"), false),
                ("a.png", None, Some("pic"), true),
                ("", Some("top"), Some("anchor"), false),
            ]
        );
        assert_eq!(
            &text[note.links[1].range.clone()],
            "[Sp](My%20Note.md#Part)"
        );
    }

    #[test]
    fn frontmatter_fields_and_links() {
        let text = "---\ntags: [meta, project]\naliases: Jane, J. Doe\npeople: [\"[[Jane Doe]]\"]\n---\n# Title #inline\n\nBody #body #123 [[Body Link]]";
        let note = parse(text);
        assert_eq!(note.tags, ["meta", "project", "inline", "body"]);
        assert_eq!(note.aliases, ["Jane", "J. Doe"]);
        let links: Vec<_> = note
            .links
            .iter()
            .map(|l| (l.target.as_str(), l.in_frontmatter))
            .collect();
        assert_eq!(links, [("Jane Doe", true), ("Body Link", false)]);
        assert_eq!(note.frontmatter.unwrap()["tags"][0], "meta");
        assert_eq!(
            &text[note.frontmatter_range.unwrap()],
            "---\ntags: [meta, project]\naliases: Jane, J. Doe\npeople: [\"[[Jane Doe]]\"]\n---\n"
        );
    }

    #[test]
    fn invalid_frontmatter_is_null_but_still_fenced() {
        let note = parse("---\n: : bad\n  - [\n---\nbody");
        assert!(note.frontmatter.is_none());
        assert!(note.frontmatter_range.is_some());
    }

    #[test]
    fn headings_and_blocks() {
        let note =
            parse("# One\n\nPara ^para-1\n\n## Two ^h2\n\n- item ^item\n```\n^not-a-block\n```");
        let headings: Vec<_> = note
            .headings
            .iter()
            .map(|h| (h.level, h.text.as_str(), h.line))
            .collect();
        assert_eq!(headings, [(1, "One", 0), (2, "Two", 4)]);
        let blocks: Vec<_> = note.blocks.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(blocks, ["para-1", "h2", "item"]);
    }

    #[test]
    fn tags_can_start_a_line() {
        let note = parse("#work on this\n# Heading\n##double\n");
        assert_eq!(note.tags, ["work"]);
    }

    #[test]
    fn tags_skip_urls_and_links() {
        let note = parse("see http://x.y/#frag and [[Note#Sec]] and #real/nested and (#paren)");
        assert_eq!(note.tags, ["real/nested"]);
    }

    #[test]
    fn tasks_with_metadata() {
        let text = "- [ ] Ask [[Jane]] ⏫ 📅 2026-11-05 ➕ 2026-11-03 ^t1\n- [x] Done thing ✅ 2026-11-03\n  - [-] Dropped ❌ 2026-11-02\n1. [/] In progress\n> - [ ] Quoted\n- not a task";
        let note = parse(text);
        let tasks: Vec<_> = note
            .tasks
            .iter()
            .map(|t| (t.line, t.status, t.text.as_str(), t.priority))
            .collect();
        assert_eq!(
            tasks,
            [
                (0, TaskStatus::Todo, "Ask [[Jane]]", 1),
                (1, TaskStatus::Done, "Done thing", 3),
                (2, TaskStatus::Cancelled, "Dropped", 3),
                (3, TaskStatus::Other, "In progress", 3),
                (4, TaskStatus::Todo, "Quoted", 3),
            ]
        );
        let first = &note.tasks[0];
        assert_eq!(first.due.as_deref(), Some("2026-11-05"));
        assert_eq!(first.created.as_deref(), Some("2026-11-03"));
        assert_eq!(note.tasks[1].done.as_deref(), Some("2026-11-03"));
        assert_eq!(note.tasks[2].cancelled.as_deref(), Some("2026-11-02"));
    }

    #[test]
    fn priority_levels() {
        for (marker, level) in [
            ("🔺", 0),
            ("⏫", 1),
            ("🔼", 2),
            ("", 3),
            ("🔽", 4),
            ("⏬", 5),
        ] {
            let note = parse(&format!("- [ ] x {marker}"));
            assert_eq!(note.tasks[0].priority, level, "{marker}");
        }
    }

    #[test]
    fn tasks_in_code_are_ignored() {
        assert!(parse("```\n- [ ] nope\n```").tasks.is_empty());
    }

    #[test]
    fn crlf_lines() {
        let note = parse("- [ ] one ^b1\r\n- [x] two\r\n");
        assert_eq!(note.tasks.len(), 2);
        assert_eq!(note.blocks[0].id, "b1");
    }

    #[test]
    fn edits_task_lines() {
        let line = "  - [ ] Ask [[Jane]] ⏫ 📅 2026-11-05 ➕ 2026-11-03 ^t1";
        assert_eq!(
            set_task_status(line, 'x', "2026-11-04").unwrap(),
            "  - [x] Ask [[Jane]] ⏫ 📅 2026-11-05 ➕ 2026-11-03 ✅ 2026-11-04 ^t1"
        );
        let cancelled = set_task_status(line, '-', "2026-11-04").unwrap();
        assert_eq!(
            cancelled,
            "  - [-] Ask [[Jane]] ⏫ 📅 2026-11-05 ➕ 2026-11-03 ❌ 2026-11-04 ^t1"
        );
        assert_eq!(
            set_task_status(&cancelled, ' ', "2026-11-04").unwrap(),
            line
        );
        assert_eq!(
            set_task_date(line, "📅", Some("2026-11-20")).unwrap(),
            "  - [ ] Ask [[Jane]] ⏫ ➕ 2026-11-03 📅 2026-11-20 ^t1"
        );
        assert_eq!(
            set_task_date("- [ ] Plain", "📅", None).unwrap(),
            "- [ ] Plain"
        );
        assert_eq!(
            set_task_priority(line, 3).unwrap(),
            "  - [ ] Ask [[Jane]] 📅 2026-11-05 ➕ 2026-11-03 ^t1"
        );
        assert_eq!(
            set_task_priority("- [ ] Plain", 0).unwrap(),
            "- [ ] Plain 🔺"
        );
        assert_eq!(set_task_status("not a task", 'x', "2026-11-04"), None);
        assert_eq!(
            toggle_task_line("- [x] Done ✅ 2026-11-01", "2026-11-04").unwrap(),
            "- [ ] Done"
        );
    }

    #[test]
    fn builds_new_task_lines() {
        assert_eq!(
            new_task_line(" Call Bob ", 1, Some("2026-11-06"), "2026-11-03"),
            "- [ ] Call Bob ⏫ 📅 2026-11-06 ➕ 2026-11-03"
        );
        assert_eq!(
            new_task_line("Plain", 3, None, "2026-11-03"),
            "- [ ] Plain ➕ 2026-11-03"
        );
        let task = parse_task_line("- [ ] Call Bob ⏫ 📅 2026-11-06").unwrap();
        assert_eq!((task.text.as_str(), task.priority), ("Call Bob", 1));
    }

    #[test]
    fn todo_input_pulls_out_dates_and_priorities() {
        // Tuesday.
        let today = NaiveDate::from_ymd_opt(2026, 11, 3).unwrap();
        let date = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
        let cases = [
            (
                "Call Bob @2026-11-06 !p1",
                "Call Bob",
                "2026-11-06",
                Some(1),
            ),
            ("Call Bob @tomorrow", "Call Bob", "2026-11-04", None),
            ("@fri Call Bob !P0", "Call Bob", "2026-11-06", Some(0)),
            (
                "Call Bob @nov 12 about it",
                "Call Bob about it",
                "2026-11-12",
                None,
            ),
            // What the completions insert.
            (
                "Call Bob 📅 2026-11-06 ⏫",
                "Call Bob",
                "2026-11-06",
                Some(1),
            ),
            ("Call Bob @p4", "Call Bob", "", Some(4)),
            (
                "Email jane@example.com about it",
                "Email jane@example.com about it",
                "",
                None,
            ),
            ("Ask @someone first", "Ask @someone first", "", None),
            ("Wow!p1", "Wow!p1", "", None),
        ];
        for (input, text, due, priority) in cases {
            assert_eq!(
                todo_input(input, today),
                (text.to_string(), date(due), priority),
                "{input}"
            );
        }
    }
}
