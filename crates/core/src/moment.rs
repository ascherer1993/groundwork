//! Dates in moment.js format strings, as Obsidian uses them (daily notes,
//! templates). Covers the date and time tokens; week numbers come later.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use chrono::{Datelike, NaiveDate, NaiveDateTime, Timelike};
use regex::Regex;

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const WEEKDAYS: [&str; 7] = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Literal(String),
    Year4,
    Year2,
    MonthName,
    MonthShort,
    Month2,
    Month,
    Day2,
    Day,
    DayOrdinal,
    WeekdayName,
    WeekdayShort,
    Hour24Pad,
    Hour24,
    Hour12Pad,
    Hour12,
    MinutePad,
    SecondPad,
    AmPmUpper,
    AmPmLower,
}

/// Longest tokens first, so `MMMM` wins over `MM`.
const TOKENS: [(&str, Token); 19] = [
    ("YYYY", Token::Year4),
    ("MMMM", Token::MonthName),
    ("dddd", Token::WeekdayName),
    ("MMM", Token::MonthShort),
    ("ddd", Token::WeekdayShort),
    ("YY", Token::Year2),
    ("MM", Token::Month2),
    ("DD", Token::Day2),
    ("Do", Token::DayOrdinal),
    ("HH", Token::Hour24Pad),
    ("hh", Token::Hour12Pad),
    ("mm", Token::MinutePad),
    ("ss", Token::SecondPad),
    ("M", Token::Month),
    ("D", Token::Day),
    ("H", Token::Hour24),
    ("h", Token::Hour12),
    ("A", Token::AmPmUpper),
    ("a", Token::AmPmLower),
];

fn tokenize(format: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut literal = String::new();
    let mut rest = format;
    'outer: while let Some(c) = rest.chars().next() {
        if c == '['
            && let Some(end) = rest.find(']')
        {
            literal.push_str(&rest[1..end]);
            rest = &rest[end + 1..];
            continue;
        }
        for (pattern, token) in &TOKENS {
            if let Some(after) = rest.strip_prefix(pattern) {
                if !literal.is_empty() {
                    out.push(Token::Literal(std::mem::take(&mut literal)));
                }
                out.push(token.clone());
                rest = after;
                continue 'outer;
            }
        }
        literal.push(c);
        rest = &rest[c.len_utf8()..];
    }
    if !literal.is_empty() {
        out.push(Token::Literal(literal));
    }
    out
}

fn ordinal(n: u32) -> String {
    let suffix = match (n % 10, n % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

/// Formats `date` with a moment.js format string.
pub fn format(date: NaiveDate, format: &str) -> String {
    format_datetime(date.and_time(Default::default()), format)
}

/// Formats a date and time with a moment.js format string.
pub fn format_datetime(dt: NaiveDateTime, format: &str) -> String {
    let date = dt.date();
    let month = date.month0() as usize;
    let weekday = date.weekday().num_days_from_monday() as usize;
    let hour12 = match dt.hour() % 12 {
        0 => 12,
        h => h,
    };
    let pm = dt.hour() >= 12;
    tokenize(format)
        .into_iter()
        .map(|token| match token {
            Token::Literal(s) => s,
            Token::Year4 => format!("{:04}", date.year()),
            Token::Year2 => format!("{:02}", date.year().rem_euclid(100)),
            Token::MonthName => MONTHS[month].to_string(),
            Token::MonthShort => MONTHS[month][..3].to_string(),
            Token::Month2 => format!("{:02}", date.month()),
            Token::Month => date.month().to_string(),
            Token::Day2 => format!("{:02}", date.day()),
            Token::Day => date.day().to_string(),
            Token::DayOrdinal => ordinal(date.day()),
            Token::WeekdayName => WEEKDAYS[weekday].to_string(),
            Token::WeekdayShort => WEEKDAYS[weekday][..3].to_string(),
            Token::Hour24Pad => format!("{:02}", dt.hour()),
            Token::Hour24 => dt.hour().to_string(),
            Token::Hour12Pad => format!("{hour12:02}"),
            Token::Hour12 => hour12.to_string(),
            Token::MinutePad => format!("{:02}", dt.minute()),
            Token::SecondPad => format!("{:02}", dt.second()),
            Token::AmPmUpper => (if pm { "PM" } else { "AM" }).into(),
            Token::AmPmLower => (if pm { "pm" } else { "am" }).into(),
        })
        .collect()
}

/// Reads a date written in `format`. Returns `None` unless the whole text
/// matches and names a real date (weekday names must agree with it).
/// A format's tokens and the pattern that reads it.
type Compiled = Arc<(Vec<Token>, Regex)>;

/// A format, compiled once: the todo views ask about every note in the vault.
fn compiled(format: &str) -> Option<Compiled> {
    static CACHE: LazyLock<Mutex<HashMap<String, Compiled>>> = LazyLock::new(Default::default);
    if let Some(found) = CACHE.lock().unwrap().get(format) {
        return Some(found.clone());
    }
    let tokens = tokenize(format);
    let mut pattern = String::from("^");
    for token in &tokens {
        pattern.push_str(&match token {
            Token::Literal(s) => regex::escape(s),
            Token::Year4 => r"(\d{4})".into(),
            Token::Year2
            | Token::Month2
            | Token::Day2
            | Token::Hour24Pad
            | Token::Hour12Pad
            | Token::MinutePad
            | Token::SecondPad => r"(\d{2})".into(),
            Token::Month | Token::Day | Token::Hour24 | Token::Hour12 => r"(\d{1,2})".into(),
            Token::AmPmUpper | Token::AmPmLower => r"([AaPp][Mm])".into(),
            Token::DayOrdinal => r"(\d{1,2})(?:st|nd|rd|th)".into(),
            Token::MonthName | Token::MonthShort | Token::WeekdayName | Token::WeekdayShort => {
                r"([A-Za-z]+)".into()
            }
        });
    }
    pattern.push('$');
    let made = Arc::new((tokens, Regex::new(&pattern).ok()?));
    CACHE
        .lock()
        .unwrap()
        .insert(format.to_string(), made.clone());
    Some(made)
}

pub fn parse(text: &str, format: &str) -> Option<NaiveDate> {
    let compiled = compiled(format)?;
    let (tokens, regex) = &*compiled;
    let caps = regex.captures(text)?;

    let (mut year, mut month, mut day) = (None, None, None);
    let mut groups = caps.iter().skip(1).flatten().map(|m| m.as_str());
    for token in tokens {
        if matches!(token, Token::Literal(_)) {
            continue;
        }
        let value = groups.next()?;
        let number = || value.parse::<u32>().ok();
        let month_index = |len: usize| {
            MONTHS
                .iter()
                .position(|m| value.eq_ignore_ascii_case(&m[..len.min(m.len())]))
                .map(|i| i as u32 + 1)
        };
        match token {
            Token::Year4 => year = Some(value.parse::<i32>().ok()?),
            Token::Year2 => year = Some(2000 + value.parse::<i32>().ok()?),
            Token::Month2 | Token::Month => month = Some(number()?),
            Token::MonthName => month = Some(month_index(usize::MAX)?),
            Token::MonthShort => month = Some(month_index(3)?),
            Token::Day2 | Token::Day | Token::DayOrdinal => day = Some(number()?),
            // Daily note names are dates; a time in the name is ignored.
            _ => {}
        }
    }
    let date = NaiveDate::from_ymd_opt(year?, month?, day?)?;
    // Round-trip, so weekday names and zero padding have to agree too.
    (self::format(date, format) == text).then_some(date)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn formats_common_tokens() {
        let date = d(2026, 11, 3);
        assert_eq!(format(date, "YYYY-MM-DD"), "2026-11-03");
        assert_eq!(
            format(date, "dddd, MMMM Do YYYY"),
            "Tuesday, November 3rd 2026"
        );
        assert_eq!(format(date, "ddd D MMM YY"), "Tue 3 Nov 26");
        assert_eq!(
            format(date, "YYYY/MM/[Week of] M-D"),
            "2026/11/Week of 11-3"
        );
    }

    #[test]
    fn parses_what_it_formats() {
        for fmt in [
            "YYYY-MM-DD",
            "DD.MM.YYYY",
            "dddd, MMMM Do YYYY",
            "YYYY/MM/YYYY-MM-DD",
            "[Daily] D MMM YY",
        ] {
            let date = d(2026, 2, 21);
            assert_eq!(parse(&format(date, fmt), fmt), Some(date), "{fmt}");
        }
    }

    #[test]
    fn rejects_near_misses() {
        assert_eq!(parse("2026-11-3", "YYYY-MM-DD"), None);
        assert_eq!(parse("2026-02-30", "YYYY-MM-DD"), None);
        assert_eq!(
            parse("Monday, November 3rd 2026", "dddd, MMMM Do YYYY"),
            None
        );
        assert_eq!(parse("Meeting notes", "YYYY-MM-DD"), None);
        assert_eq!(parse("2026-11-03 Kickoff", "YYYY-MM-DD"), None);
    }

    #[test]
    fn formats_times() {
        let dt = d(2026, 11, 3).and_hms_opt(14, 5, 9).unwrap();
        assert_eq!(format_datetime(dt, "YYYY-MM-DDTHH:mm"), "2026-11-03T14:05");
        assert_eq!(format_datetime(dt, "h:mm:ss a"), "2:05:09 pm");
        assert_eq!(format_datetime(dt, "hh A, H[h]"), "02 PM, 14h");
        let midnight = d(2026, 11, 3).and_hms_opt(0, 30, 0).unwrap();
        assert_eq!(format_datetime(midnight, "h:mm A"), "12:30 AM");
    }

    #[test]
    fn ordinals() {
        let got: Vec<_> = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23]
            .into_iter()
            .map(ordinal)
            .collect();
        assert_eq!(
            got,
            [
                "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd"
            ]
        );
    }
}
