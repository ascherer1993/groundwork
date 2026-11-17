//! Setting and removing top-level frontmatter properties in a note's text,
//! or top-level keys in a YAML file, leaving everything else as it was
//! written (other properties, comments, formatting), so edits don't churn
//! notes shared with Obsidian or git.

/// A property's new value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Prop {
    Text(String),
    List(Vec<String>),
    /// A nested mapping of plain values, written as a block.
    Map(Vec<(String, String)>),
    /// Written as it is, unquoted: a number or a boolean.
    Raw(String),
    /// A key with no value (`key:`), which YAML reads as null.
    Empty,
}

impl Prop {
    pub fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }

    fn render(&self, key: &str) -> String {
        match self {
            Self::Text(v) => format!("{key}: {}\n", scalar(v, false)),
            Self::List(items) => {
                let items: Vec<String> = items.iter().map(|i| scalar(i, true)).collect();
                format!("{key}: [{}]\n", items.join(", "))
            }
            Self::Map(entries) => {
                let mut out = format!("{key}:\n");
                for (k, v) in entries {
                    out.push_str(&format!("  {k}: {}\n", scalar(v, false)));
                }
                out
            }
            Self::Raw(v) => format!("{key}: {v}\n"),
            Self::Empty => format!("{key}:\n"),
        }
    }
}

/// A YAML scalar, quoted when it would otherwise mean something else.
pub(crate) fn scalar(value: &str, in_list: bool) -> String {
    let plain = !value.is_empty()
        && value.trim() == value
        && !value.starts_with([
            '[', ']', '{', '}', '>', '|', '*', '&', '!', '%', '@', '`', '\'', '"', '#', '-', '?',
            ',',
        ])
        && !value.contains(": ")
        && !value.contains(" #")
        && !value.ends_with(':')
        && !(in_list && value.contains([',', '[', ']', '{', '}']))
        && !matches!(
            value.to_ascii_lowercase().as_str(),
            "true" | "false" | "yes" | "no" | "on" | "off" | "null" | "~"
        )
        && value.parse::<f64>().is_err();
    if plain {
        value.to_string()
    } else {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    }
}

/// Byte range of the frontmatter's body (between the fences), if any.
fn body(text: &str) -> Option<(usize, usize)> {
    let start = if text.starts_with("---\n") {
        4
    } else if text.starts_with("---\r\n") {
        5
    } else {
        return None;
    };
    let mut at = start;
    for line in text[start..].split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some((start, at));
        }
        at += line.len();
    }
    None
}

/// Sets (`Some`) or removes (`None`) each property. Properties are replaced
/// where they are, with any lines that continue them; new ones go last.
pub fn set(text: &str, changes: &[(&str, Option<Prop>)]) -> String {
    let Some((start, end)) = body(text) else {
        let added: String = changes
            .iter()
            .filter_map(|(k, v)| v.as_ref().map(|v| v.render(k)))
            .collect();
        if added.is_empty() {
            return text.to_string();
        }
        return format!("---\n{added}---\n{text}");
    };
    format!(
        "{}{}{}",
        &text[..start],
        set_in_yaml(&text[start..end], changes),
        &text[end..]
    )
}

/// The line that starts top-level property `key`, if there is one.
fn key_line(lines: &[String], key: &str) -> Option<usize> {
    let prefix = format!("{key}:");
    lines.iter().position(|l| {
        l.starts_with(&prefix)
            && l[prefix.len()..]
                .chars()
                .next()
                .is_none_or(char::is_whitespace)
    })
}

/// Renames property `from` to `to` where it is, keeping its value as
/// written. Leaves the text as it was when there's no `from`, when `to` is
/// already a property, or when `to` isn't a plain key.
pub fn rename(text: &str, from: &str, to: &str) -> String {
    let Some((start, end)) = body(text) else {
        return text.to_string();
    };
    let plain = !to.is_empty()
        && to.trim() == to
        && !to.contains([':', '\n', '\r', '#', '"', '\''])
        && !to.starts_with(['-', '[', '{', '?', '&', '*', '!', '|', '>', '%', '@', '`']);
    let mut lines: Vec<String> = text[start..end]
        .split_inclusive('\n')
        .map(str::to_string)
        .collect();
    if !plain || from == to || key_line(&lines, to).is_some() {
        return text.to_string();
    }
    let Some(i) = key_line(&lines, from) else {
        return text.to_string();
    };
    lines[i] = format!("{to}{}", &lines[i][from.len()..]);
    format!("{}{}{}", &text[..start], lines.concat(), &text[end..])
}

/// Sets (`Some`) or removes (`None`) top-level keys of a YAML document, as
/// [`set`] does for a note's frontmatter.
pub fn set_in_yaml(yaml: &str, changes: &[(&str, Option<Prop>)]) -> String {
    let mut lines: Vec<String> = yaml.split_inclusive('\n').map(str::to_string).collect();
    for (key, value) in changes {
        let found = key_line(&lines, key);
        let rendered = value.as_ref().map(|v| v.render(key));
        match found {
            Some(i) => {
                let continues = |l: &str| l.starts_with([' ', '\t']) || l.starts_with("- ");
                let mut j = i + 1;
                while j < lines.len() {
                    if continues(&lines[j]) && !lines[j].trim().is_empty() {
                        j += 1;
                        continue;
                    }
                    // Blank lines inside the value, not after it.
                    let blank = lines[j..]
                        .iter()
                        .take_while(|l| l.trim().is_empty())
                        .count();
                    if blank > 0 && lines.get(j + blank).is_some_and(|l| continues(l)) {
                        j += blank;
                    } else {
                        break;
                    }
                }
                match rendered {
                    Some(r) => drop(lines.splice(i..j, [r])),
                    None => drop(lines.drain(i..j)),
                }
            }
            None => {
                if let Some(r) = rendered {
                    if lines.last().is_some_and(|l| !l.ends_with('\n')) {
                        lines.last_mut().unwrap().push('\n');
                    }
                    lines.push(r);
                }
            }
        }
    }
    lines.concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_and_removes_properties_in_place() {
        let text = "---\ntype: ticket\n# a comment\ntags:\n  - a\n  - b\nstatus: active\n---\n# Body\nstatus: not a property\n";
        let out = set(
            text,
            &[
                ("status", Some(Prop::text("closed"))),
                ("tags", None),
                ("closed", Some(Prop::text("2026-11-04"))),
                (
                    "projects",
                    Some(Prop::List(vec!["[[Acme]]".into(), "[[Empower]]".into()])),
                ),
            ],
        );
        assert_eq!(
            out,
            "---\ntype: ticket\n# a comment\nstatus: closed\nclosed: 2026-11-04\nprojects: [\"[[Acme]]\", \"[[Empower]]\"]\n---\n# Body\nstatus: not a property\n"
        );
        // Prefixes of other keys aren't matched.
        let out = set(
            "---\nstatuses: x\n---\n",
            &[("status", Some(Prop::text("a")))],
        );
        assert_eq!(out, "---\nstatuses: x\nstatus: a\n---\n");
    }

    #[test]
    fn adds_frontmatter_when_missing() {
        assert_eq!(
            set("# Note\n", &[("workspace", Some(Prop::text("ws-1")))]),
            "---\nworkspace: ws-1\n---\n# Note\n"
        );
        assert_eq!(set("# Note\n", &[("workspace", None)]), "# Note\n");
        assert_eq!(
            set("---\n---\nx", &[("a", Some(Prop::text("b")))]),
            "---\na: b\n---\nx"
        );
    }

    #[test]
    fn quotes_what_yaml_would_misread() {
        assert_eq!(scalar("TEAM-123", false), "TEAM-123");
        assert_eq!(
            scalar("https://x.y/browse/T-1", false),
            "https://x.y/browse/T-1"
        );
        assert_eq!(scalar("acme:web", true), "acme:web");
        assert_eq!(scalar("[[Acme]]", true), "\"[[Acme]]\"");
        assert_eq!(scalar("yes", false), "\"yes\"");
        assert_eq!(scalar("2026", false), "\"2026\"");
        assert_eq!(scalar("a: b", false), "\"a: b\"");
        assert_eq!(scalar("say \"hi\"", false), "say \"hi\"");
        assert_eq!(scalar("\"q\"", false), "\"\\\"q\\\"\"");
        assert_eq!(scalar("", false), "\"\"");
    }

    #[test]
    fn writes_numbers_booleans_and_empty_values_unquoted() {
        let text = "---\ntitle: x\n---\n";
        assert_eq!(
            set(
                text,
                &[
                    ("done", Some(Prop::Raw("true".into()))),
                    ("count", Some(Prop::Raw("3".into()))),
                    ("links", Some(Prop::Empty)),
                ],
            ),
            "---\ntitle: x\ndone: true\ncount: 3\nlinks:\n---\n"
        );
        // A block list is replaced whole.
        assert_eq!(
            set(
                "---\ntags:\n  - a\n  - b\nx: 1\n---\n",
                &[("tags", Some(Prop::Empty))]
            ),
            "---\ntags:\nx: 1\n---\n"
        );
    }

    #[test]
    fn renames_properties_in_place() {
        let text =
            "---\ntype: person\n# who\nteams:\n  - \"[[Platform]]\"\nrole: x\n---\nteams: body\n";
        assert_eq!(
            rename(text, "teams", "team"),
            "---\ntype: person\n# who\nteam:\n  - \"[[Platform]]\"\nrole: x\n---\nteams: body\n"
        );
        assert_eq!(
            rename(text, "role", "due date"),
            "---\ntype: person\n# who\nteams:\n  - \"[[Platform]]\"\ndue date: x\n---\nteams: body\n"
        );
        // Taken names, missing keys, keys YAML would misread, no frontmatter.
        assert_eq!(rename(text, "role", "type"), text);
        assert_eq!(rename(text, "nope", "other"), text);
        assert_eq!(rename(text, "role", "a: b"), text);
        assert_eq!(rename(text, "role", "- x"), text);
        assert_eq!(rename(text, "role", ""), text);
        assert_eq!(rename("# No properties\n", "a", "b"), "# No properties\n");
    }

    #[test]
    fn edits_blocks_in_a_yaml_file() {
        let yaml = "# Settings\nwork_folder: Work\n\ndaily_notes:\n  folder: Old\n\n  # note\n  format: YYYY\n\nactions: []\n";
        let map = |f: &str| Some(Prop::Map(vec![("folder".into(), f.into())]));
        assert_eq!(
            set_in_yaml(yaml, &[("daily_notes", map("Daily"))]),
            "# Settings\nwork_folder: Work\n\ndaily_notes:\n  folder: Daily\n\nactions: []\n"
        );
        assert_eq!(
            set_in_yaml(yaml, &[("daily_notes", None)]),
            "# Settings\nwork_folder: Work\n\n\nactions: []\n"
        );
        assert_eq!(
            set_in_yaml("a: 1", &[("daily_notes", map("Journal/Days"))]),
            "a: 1\ndaily_notes:\n  folder: Journal/Days\n"
        );
    }
}
