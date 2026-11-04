//! Setting and removing top-level frontmatter properties in a note's text,
//! leaving everything else as it was written (other properties, comments,
//! formatting), so edits don't churn notes shared with Obsidian or git.

/// A property's new value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Prop {
    Text(String),
    List(Vec<String>),
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
        }
    }
}

/// A YAML scalar, quoted when it would otherwise mean something else.
fn scalar(value: &str, in_list: bool) -> String {
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
    let mut lines: Vec<String> = text[start..end]
        .split_inclusive('\n')
        .map(str::to_string)
        .collect();
    for (key, value) in changes {
        let prefix = format!("{key}:");
        let found = lines.iter().position(|l| {
            l.starts_with(&prefix)
                && l[prefix.len()..]
                    .chars()
                    .next()
                    .is_none_or(char::is_whitespace)
        });
        let rendered = value.as_ref().map(|v| v.render(key));
        match found {
            Some(i) => {
                let mut j = i + 1;
                while j < lines.len()
                    && (lines[j].starts_with([' ', '\t']) || lines[j].starts_with("- "))
                {
                    j += 1;
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
    format!("{}{}{}", &text[..start], lines.concat(), &text[end..])
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
}
