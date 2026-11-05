//! "Who knows about X": the people around the notes a topic turns up. A
//! search finds the notes (by meaning when smart search is set up, else by
//! their words); each person they link to (in the text or `people:`) gains
//! the note's weight, and a person whose own note matches gains it twice.

use std::collections::HashMap;

use serde::Serialize;
use ts_rs::TS;

use crate::project_view::is_person;
use crate::search;
use crate::tickets::{file_stem, fm_str};
use crate::{Result, Session};

/// Notes looked at for a topic.
const NOTES: usize = 25;
/// Notes listed as the reason for each person.
const REASONS: usize = 4;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WhoKnows {
    /// Whether the notes were found by meaning (qmd) rather than by words.
    pub smart: bool,
    /// Most likely first.
    pub people: Vec<Knower>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Knower {
    pub path: String,
    pub name: String,
    pub role: Option<String>,
    pub company: Option<String>,
    pub score: f64,
    /// The matching notes that point to them, best first.
    pub notes: Vec<String>,
}

impl Session {
    /// The people most connected to the notes about `topic`.
    pub fn who_knows(&self, topic: &str, limit: usize) -> Result<WhoKnows> {
        let smart = self.qmd().collection().is_some();
        let hits: Vec<(String, f64)> = if smart {
            self.smart_search(topic, NOTES)?
                .into_iter()
                .map(|r| (r.path, r.score.max(0.01)))
                .collect()
        } else {
            self.word_hits(topic)
        };

        let index = self.index();
        let mut people: HashMap<String, Knower> = HashMap::new();
        let mut credit = |person: &str, note: &str, weight: f64| {
            let Some(fm) = index.note(person).map(|n| n.frontmatter.as_ref()) else {
                return;
            };
            let k = people.entry(person.to_string()).or_insert_with(|| Knower {
                path: person.to_string(),
                name: file_stem(person).to_string(),
                role: fm_str(fm, "role"),
                company: fm_str(fm, "company"),
                score: 0.0,
                notes: Vec::new(),
            });
            k.score += weight;
            if !k.notes.iter().any(|n| n == note) {
                k.notes.push(note.to_string());
            }
        };
        for (note, weight) in &hits {
            let fm = index.note(note).and_then(|n| n.frontmatter.as_ref());
            if is_person(note, fm) {
                credit(note, note, weight * 2.0);
                continue;
            }
            let mut seen = Vec::new();
            for link in index.outgoing(note) {
                let Some(target) = link.resolved else {
                    continue;
                };
                let target_fm = index.note(&target).and_then(|n| n.frontmatter.as_ref());
                if target != *note && !seen.contains(&target) && is_person(&target, target_fm) {
                    credit(&target, note, *weight);
                    seen.push(target);
                }
            }
        }
        let mut people: Vec<Knower> = people.into_values().collect();
        people.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| a.name.cmp(&b.name))
        });
        people.truncate(limit);
        for p in &mut people {
            p.notes.truncate(REASONS);
        }
        Ok(WhoKnows { smart, people })
    }

    /// Notes with all the topic's words, else with any of them; earlier
    /// results weigh more.
    fn word_hits(&self, topic: &str) -> Vec<(String, f64)> {
        let index = self.index();
        let mut found = search::search(&index, topic, NOTES);
        if found.is_empty() {
            let mut any: HashMap<String, u32> = HashMap::new();
            for word in topic.split_whitespace().filter(|w| w.len() > 2) {
                for r in search::search(&index, word, NOTES) {
                    *any.entry(r.path).or_default() += r.hits;
                }
            }
            let mut any: Vec<(String, u32)> = any.into_iter().collect();
            any.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            return any
                .into_iter()
                .take(NOTES)
                .enumerate()
                .map(|(i, (p, _))| (p, 1.0 / (i as f64 + 1.0)))
                .collect();
        }
        found
            .drain(..)
            .enumerate()
            .map(|(i, r)| (r.path, 1.0 / (i as f64 + 1.0)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use crate::qmd::tests::fake;
    use crate::test_vault::session;

    #[test]
    fn people_linked_from_the_notes_found() {
        let (_dir, s) = session();
        // By words: the vendor call and the kickoff are about the contract.
        let who = s.who_knows("contract", 5).unwrap();
        assert!(!who.smart);
        let names: Vec<&str> = who.people.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names[..2], ["Sam Lee", "Jane Doe"]);
        let sam = &who.people[0];
        assert_eq!(sam.role.as_deref(), Some("Account manager"));
        assert!(sam.notes.contains(&"Contacts/Sam Lee.md".to_string()));
        assert!(
            sam.notes
                .contains(&"Events/2026-11-04 Vendor call.md".to_string())
        );
        // No note has every word: any of them will do.
        assert!(!s.who_knows("SSO contract", 5).unwrap().people.is_empty());
    }

    #[test]
    fn by_meaning_once_smart_search_is_set_up() {
        let (dir, s) = session();
        let _qmd = fake(dir.path());
        s.qmd().setup().unwrap();
        let who = s.who_knows("contract terms", 5).unwrap();
        assert!(who.smart);
        assert_eq!(who.people[0].name, "Sam Lee");
        assert!(who.people.iter().any(|p| p.name == "Jane Doe"));
    }
}
