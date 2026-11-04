//! `{{…}}` templates (PLAN §5.3): a superset of Obsidian's core template
//! tags, with date offsets and anchors, prompts and a cursor marker.
//!
//! Only known tags are expanded. Unknown ones, tags inside code and escaped
//! tags (`\{{date}}`) are left as text, so templates can show the syntax.

use std::{collections::HashMap, fs, ops::Range, path::Path, sync::LazyLock};

use chrono::{Datelike, Duration, Months, NaiveDate, NaiveDateTime};
use pulldown_cmark::{CodeBlockKind, Event, Parser, Tag};
use regex::Regex;
use serde::Deserialize;

use crate::moment;

/// Obsidian's core Templates settings (`.obsidian/templates.json`, read-only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateSettings {
    /// Vault-relative folder holding the templates.
    pub folder: String,
    /// moment.js format for `{{date}}` without a format.
    pub date_format: String,
    /// moment.js format for `{{time}}` without a format.
    pub time_format: String,
}

impl Default for TemplateSettings {
    fn default() -> Self {
        Self {
            folder: "Templates".into(),
            date_format: "YYYY-MM-DD".into(),
            time_format: "HH:mm".into(),
        }
    }
}

impl TemplateSettings {
    pub fn read(root: &Path) -> Self {
        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase")]
        struct Json {
            folder: Option<String>,
            date_format: Option<String>,
            time_format: Option<String>,
        }
        let json: Json = fs::read(root.join(".obsidian/templates.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let default = Self::default();
        let set = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        Self {
            folder: set(json.folder.map(|f| f.trim_matches('/').to_string()))
                .unwrap_or(default.folder),
            date_format: set(json.date_format).unwrap_or(default.date_format),
            time_format: set(json.time_format).unwrap_or(default.time_format),
        }
    }
}

/// Everything a template can refer to.
#[derive(Debug, Clone)]
pub struct Context {
    /// The note's date: the day of a daily note, otherwise today.
    pub date: NaiveDate,
    /// The real current time.
    pub now: NaiveDateTime,
    /// Vault path of the note being written.
    pub path: String,
    /// Answers to `{{prompt:Label}}`, by label.
    pub answers: HashMap<String, String>,
    /// Context tags such as `project.name` or `ticket.key`.
    pub vars: HashMap<String, String>,
    pub settings: TemplateSettings,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub text: String,
    /// Byte offset of the first `{{cursor}}`.
    pub cursor: Option<usize>,
}

static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\\)?\{\{([^{}\n]+)\}\}").unwrap());
static DATE_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(date|time|now)(?:@(week|month|year))?((?:[+-]\d+[dwmy])*)\s*(?::(.+))?$")
        .unwrap()
});
static OFFSET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([+-])(\d+)([dwmy])").unwrap());

#[derive(Debug, PartialEq)]
enum Field<'a> {
    Date {
        kind: &'a str,
        anchor: Option<&'a str>,
        offsets: &'a str,
        format: Option<&'a str>,
    },
    Title,
    Folder,
    Path,
    Cursor,
    Prompt(&'a str),
    Var(&'a str),
}

/// What a tag's inside means, or `None` if it isn't a tag we know.
fn parse_tag<'a>(inner: &'a str, ctx_vars: &HashMap<String, String>) -> Option<Field<'a>> {
    let inner = inner.trim();
    if let Some(c) = DATE_TAG.captures(inner) {
        return Some(Field::Date {
            kind: c.get(1)?.as_str(),
            anchor: c.get(2).map(|m| m.as_str()),
            offsets: c.get(3).map_or("", |m| m.as_str()),
            format: c.get(4).map(|m| m.as_str().trim()),
        });
    }
    if let Some(label) = inner.strip_prefix("prompt:") {
        let label = label.trim();
        return (!label.is_empty()).then_some(Field::Prompt(label));
    }
    match inner {
        "title" => Some(Field::Title),
        "folder" => Some(Field::Folder),
        "path" => Some(Field::Path),
        "cursor" => Some(Field::Cursor),
        name if ctx_vars.contains_key(name) => Some(Field::Var(name)),
        _ => None,
    }
}

/// Byte ranges of fenced code blocks and inline code, where tags stay text.
fn code_ranges(text: &str) -> Vec<Range<usize>> {
    Parser::new(text)
        .into_offset_iter()
        .filter_map(|(event, range)| match event {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(_))) | Event::Code(_) => Some(range),
            _ => None,
        })
        .collect()
}

/// Calls `f` for each tag outside code, with the match range, whether it was
/// escaped and its inside.
fn each_tag(text: &str, mut f: impl FnMut(Range<usize>, bool, &str)) {
    let code = code_ranges(text);
    for m in TAG.captures_iter(text) {
        let whole = m.get(0).unwrap();
        if code.iter().any(|r| r.contains(&whole.start())) {
            continue;
        }
        f(
            whole.range(),
            m.get(1).is_some(),
            m.get(2).unwrap().as_str(),
        );
    }
}

/// The `{{prompt:…}}` labels in a template, in order, without repeats.
pub fn prompts(template: &str) -> Vec<String> {
    let mut labels: Vec<String> = Vec::new();
    each_tag(template, |_, escaped, inner| {
        if let Some(Field::Prompt(label)) = parse_tag(inner, &HashMap::new())
            && !escaped
            && !labels.iter().any(|l| l == label)
        {
            labels.push(label.to_string());
        }
    });
    labels
}

/// `date` moved by `@anchor` and then by `+1d-2w…`.
fn shift(date: NaiveDate, anchor: Option<&str>, offsets: &str) -> Option<NaiveDate> {
    let mut date = match anchor {
        Some("week") => date - Duration::days(date.weekday().num_days_from_monday().into()),
        Some("month") => date.with_day(1)?,
        Some("year") => date.with_ordinal(1)?,
        _ => date,
    };
    for c in OFFSET.captures_iter(offsets) {
        let n: u32 = c[2].parse().ok()?;
        let plus = &c[1] == "+";
        date = match &c[3] {
            "d" | "w" => {
                let days = i64::from(n) * if &c[3] == "w" { 7 } else { 1 };
                date.checked_add_signed(Duration::days(if plus { days } else { -days }))?
            }
            unit => {
                let months = Months::new(if unit == "y" { n.checked_mul(12)? } else { n });
                if plus {
                    date.checked_add_months(months)?
                } else {
                    date.checked_sub_months(months)?
                }
            }
        };
    }
    Some(date)
}

fn expand(tag: &Field, ctx: &Context) -> Option<String> {
    let name = ctx.path.rsplit('/').next().unwrap_or(&ctx.path);
    Some(match tag {
        Field::Date {
            kind,
            anchor,
            offsets,
            format,
        } => {
            let s = &ctx.settings;
            let (dt, default) = match *kind {
                "date" => (
                    shift(ctx.date, *anchor, offsets)?.and_time(ctx.now.time()),
                    s.date_format.clone(),
                ),
                "time" => (ctx.now, s.time_format.clone()),
                _ => (
                    shift(ctx.now.date(), *anchor, offsets)?.and_time(ctx.now.time()),
                    "YYYY-MM-DDTHH:mm".to_string(),
                ),
            };
            moment::format_datetime(dt, format.unwrap_or(&default))
        }
        Field::Title => name.rsplit_once('.').map_or(name, |(stem, _)| stem).into(),
        Field::Folder => ctx.path.rsplit_once('/').map_or("", |(dir, _)| dir).into(),
        Field::Path => ctx.path.clone(),
        Field::Cursor => String::new(),
        Field::Prompt(label) => ctx.answers.get(*label).cloned().unwrap_or_default(),
        Field::Var(name) => ctx.vars.get(*name)?.clone(),
    })
}

/// Expands the tags in `template`. Unanswered prompts become empty.
pub fn render(template: &str, ctx: &Context) -> Rendered {
    let mut text = String::with_capacity(template.len());
    let mut cursor = None;
    let mut last = 0;
    each_tag(template, |range, escaped, inner| {
        let Some(tag) = parse_tag(inner, &ctx.vars) else {
            return;
        };
        text.push_str(&template[last..range.start]);
        last = range.end;
        if escaped {
            text.push_str(&template[range.start + 1..range.end]);
            return;
        }
        if tag == Field::Cursor {
            cursor.get_or_insert(text.len());
        }
        match expand(&tag, ctx) {
            Some(value) => text.push_str(&value),
            None => text.push_str(&template[range]),
        }
    });
    text.push_str(&template[last..]);
    Rendered { text, cursor }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Context {
        Context {
            date: NaiveDate::from_ymd_opt(2026, 11, 3).unwrap(),
            now: NaiveDate::from_ymd_opt(2026, 11, 3)
                .unwrap()
                .and_hms_opt(9, 41, 0)
                .unwrap(),
            path: "Meetings/Acme sync.md".into(),
            answers: HashMap::from([("Attendees".into(), "Jane, Bob".into())]),
            vars: HashMap::from([("ticket.key".into(), "TEAM-123".into())]),
            settings: TemplateSettings::default(),
        }
    }

    fn r(template: &str) -> String {
        render(template, &ctx()).text
    }

    #[test]
    fn dates_follow_the_plan_table() {
        assert_eq!(r("{{date}}"), "2026-11-03");
        assert_eq!(r("{{date:dddd, MMMM D}}"), "Tuesday, November 3");
        assert_eq!(r("{{date+1d}} / {{date-1d}}"), "2026-11-04 / 2026-11-02");
        assert_eq!(
            r("{{date+2w}} {{date-1m}} {{date+1y}}"),
            "2026-11-17 2026-10-03 2027-11-03"
        );
        assert_eq!(r("{{date+1m-1d}}"), "2026-12-02");
        assert_eq!(r("{{date@week}} {{date@month}}"), "2026-11-02 2026-11-01");
        assert_eq!(r("{{date@week+4d:ddd D}}"), "Fri 6");
        assert_eq!(r("{{time}} {{time:h:mm a}}"), "09:41 9:41 am");
        assert_eq!(r("{{now:YYYY-MM-DD HH:mm}}"), "2026-11-03 09:41");
        assert_eq!(r("{{ date : YYYY }}"), "2026");
    }

    #[test]
    fn date_is_the_notes_date_and_now_is_real() {
        let mut c = ctx();
        c.date = NaiveDate::from_ymd_opt(2026, 12, 25).unwrap();
        assert_eq!(
            render("{{date}} {{now:YYYY-MM-DD}}", &c).text,
            "2026-12-25 2026-11-03"
        );
    }

    #[test]
    fn month_offsets_clamp_like_moment() {
        let mut c = ctx();
        c.date = NaiveDate::from_ymd_opt(2026, 1, 31).unwrap();
        assert_eq!(render("{{date+1m}}", &c).text, "2026-02-28");
    }

    #[test]
    fn note_tags_prompts_and_context() {
        assert_eq!(
            r("{{title}} in {{folder}} ({{path}})"),
            "Acme sync in Meetings (Meetings/Acme sync.md)"
        );
        assert_eq!(
            r("With {{prompt:Attendees}}; {{prompt:Agenda}}."),
            "With Jane, Bob; ."
        );
        assert_eq!(
            r("{{ticket.key}} {{ticket.title}}"),
            "TEAM-123 {{ticket.title}}"
        );
    }

    #[test]
    fn leaves_unknown_escaped_and_code_alone() {
        assert_eq!(r("{{foo}} {{#each items}}"), "{{foo}} {{#each items}}");
        assert_eq!(r(r"\{{date}} {{date}}"), "{{date}} 2026-11-03");
        assert_eq!(r("`{{date}}` {{date}}"), "`{{date}}` 2026-11-03");
        assert_eq!(
            r("```jinja\n{{date}}\n```\n{{date}}"),
            "```jinja\n{{date}}\n```\n2026-11-03"
        );
        assert_eq!(r("{{date+1q}}"), "{{date+1q}}");
    }

    #[test]
    fn cursor_is_removed_and_reported() {
        let out = render("# {{title}}\n\n{{cursor}}\n\nEnd {{cursor}}", &ctx());
        assert_eq!(out.text, "# Acme sync\n\n\n\nEnd ");
        assert_eq!(out.cursor, Some("# Acme sync\n\n".len()));
    }

    #[test]
    fn lists_prompts_once_in_order() {
        let t = "{{prompt:Who}} {{prompt:What}} {{prompt:Who}} `{{prompt:Code}}` \\{{prompt:No}}";
        assert_eq!(prompts(t), ["Who", "What"]);
    }

    #[test]
    fn reads_settings_with_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            TemplateSettings::read(dir.path()),
            TemplateSettings::default()
        );
        fs::create_dir(dir.path().join(".obsidian")).unwrap();
        fs::write(
            dir.path().join(".obsidian/templates.json"),
            r#"{"folder": "/Meta/Templates/", "dateFormat": "DD.MM.YYYY"}"#,
        )
        .unwrap();
        let s = TemplateSettings::read(dir.path());
        assert_eq!(s.folder, "Meta/Templates");
        assert_eq!(s.date_format, "DD.MM.YYYY");
        assert_eq!(s.time_format, "HH:mm");
    }
}
