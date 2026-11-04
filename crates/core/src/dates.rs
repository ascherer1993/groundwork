//! Loose dates as people type them: `@fri`, `--due tomorrow`, `nov 12`.
//! `app/src/markdown/dates.ts` mirrors this for the editor; keep the two
//! in step (they share the test cases below).

use chrono::{Datelike, Duration, Months, NaiveDate, Weekday};

const WEEKDAYS: [(&str, Weekday); 7] = [
    ("monday", Weekday::Mon),
    ("tuesday", Weekday::Tue),
    ("wednesday", Weekday::Wed),
    ("thursday", Weekday::Thu),
    ("friday", Weekday::Fri),
    ("saturday", Weekday::Sat),
    ("sunday", Weekday::Sun),
];
const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/// A name or its first three letters or more: `fri`, `frid`, `friday`.
fn named(word: &str, name: &str) -> bool {
    word.len() >= 3 && name.starts_with(word)
}

/// Parses `today`, `tomorrow`, `yesterday`, weekday names (the next one
/// after today), `+3d`/`+2w`/`+1m`/`+1y`, `nov 12` or `12 nov` (the next
/// one from today), and `YYYY-MM-DD`. Case-insensitive.
pub fn parse_natural(text: &str, today: NaiveDate) -> Option<NaiveDate> {
    let text = text.trim().to_lowercase();
    match text.as_str() {
        "today" | "tod" => return Some(today),
        "tomorrow" | "tom" | "tmr" => return today.succ_opt(),
        "yesterday" => return today.pred_opt(),
        _ => {}
    }
    if let Ok(date) = NaiveDate::parse_from_str(&text, "%Y-%m-%d") {
        return Some(date);
    }
    if let Some((_, weekday)) = WEEKDAYS.iter().find(|(name, _)| named(&text, name)) {
        let ahead =
            (weekday.num_days_from_monday() + 7 - today.weekday().num_days_from_monday()) % 7;
        let ahead = if ahead == 0 { 7 } else { ahead };
        return Some(today + Duration::days(ahead.into()));
    }
    if let Some(rest) = text.strip_prefix('+') {
        let unit = rest.chars().last()?;
        let n: u32 = rest[..rest.len() - 1].parse().ok()?;
        return match unit {
            'd' => today.checked_add_signed(Duration::days(n.into())),
            'w' => today.checked_add_signed(Duration::weeks(n.into())),
            'm' => today.checked_add_months(Months::new(n)),
            'y' => today.checked_add_months(Months::new(n.checked_mul(12)?)),
            _ => None,
        };
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    let (month, day) = match words.as_slice() {
        [a, b] => match (month_of(a), b.parse::<u32>(), a.parse::<u32>(), month_of(b)) {
            (Some(m), Ok(d), _, _) | (_, _, Ok(d), Some(m)) => (m, d),
            _ => return None,
        },
        _ => return None,
    };
    let this_year = NaiveDate::from_ymd_opt(today.year(), month, day)?;
    if this_year >= today {
        Some(this_year)
    } else {
        NaiveDate::from_ymd_opt(today.year() + 1, month, day)
    }
}

fn month_of(word: &str) -> Option<u32> {
    MONTHS
        .iter()
        .position(|m| named(word, m))
        .map(|i| i as u32 + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_what_people_type() {
        // Tuesday.
        let today = NaiveDate::from_ymd_opt(2026, 11, 3).unwrap();
        let cases = [
            ("today", "2026-11-03"),
            ("Tomorrow", "2026-11-04"),
            ("tom", "2026-11-04"),
            ("yesterday", "2026-11-02"),
            ("fri", "2026-11-06"),
            ("friday", "2026-11-06"),
            ("tue", "2026-11-10"),
            ("mon", "2026-11-09"),
            ("+3d", "2026-11-06"),
            ("+2w", "2026-11-17"),
            ("+1m", "2026-12-03"),
            ("+1y", "2027-11-03"),
            ("nov 12", "2026-11-12"),
            ("12 November", "2026-11-12"),
            ("jan 5", "2027-01-05"),
            ("nov 1", "2027-11-01"),
            ("2026-12-25", "2026-12-25"),
        ];
        for (text, want) in cases {
            assert_eq!(
                parse_natural(text, today).map(|d| d.to_string()).as_deref(),
                Some(want),
                "{text}"
            );
        }
        for bad in ["", "fr", "someday", "+3x", "feb 30", "nov", "2026-13-01"] {
            assert_eq!(parse_natural(bad, today), None, "{bad}");
        }
    }
}
