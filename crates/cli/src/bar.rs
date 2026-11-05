//! `done` and `log`: how command bar sessions finish, and the command log
//! they finish in (PLAN §5.10). A session learns its request from
//! `$GROUNDWORK_REQUEST`, which the app sets when it starts Claude.

use std::path::Path;

use groundwork_core::command_log::{CommandEntry, CommandLog, Outcome, REQUEST_ENV};

use crate::{Fallible, inbox, live, print_json};

/// The request this session is working on.
pub fn this_request() -> Option<String> {
    std::env::var(REQUEST_ENV).ok().filter(|r| !r.is_empty())
}

pub fn outcome_arg(text: &str) -> Result<Outcome, String> {
    match text {
        "done" => Ok(Outcome::Done),
        "needs-you" => Ok(Outcome::NeedsYou),
        "failed" => Ok(Outcome::Failed),
        _ => Err(format!(
            "not an outcome: {text:?} (done, needs-you or failed)"
        )),
    }
}

fn outcome_name(outcome: Option<Outcome>) -> &'static str {
    match outcome {
        Some(Outcome::Done) => "done",
        Some(Outcome::NeedsYou) => "needs you",
        Some(Outcome::Failed) => "failed",
        None => "no outcome",
    }
}

/// Records how the request went, tells the user (unless they're watching)
/// and, for a finished one-off, closes this tab once Claude's turn ends.
pub fn done(
    vault: &Path,
    summary: String,
    outcome: Outcome,
    link: Option<String>,
    keep_open: bool,
    json: bool,
) -> Fallible<()> {
    let id = this_request().ok_or(
        "`done` is for sessions started from Groundwork's command bar ($GROUNDWORK_REQUEST isn't set)",
    )?;
    let summary = summary.trim().to_string();
    if summary.is_empty() {
        return Err("say what you did: groundwork done \"<what you did>\"".into());
    }
    let log = CommandLog::new(vault);
    let entry = log
        .get(&id)
        .ok_or_else(|| format!("no request {id} in the command log"))?;
    let keep_open = keep_open || outcome != Outcome::Done;
    let tab = live::this_tab();

    if !entry.shown {
        // A closing tab can't be gone back to.
        let from = if keep_open { tab.clone() } else { None };
        if let Err(e) = inbox::post_notify(summary.clone(), link, from) {
            eprintln!("groundwork: couldn't tell the user ({e}); it's in the command log");
        }
    }
    let closing = !keep_open
        && tab.as_ref().is_some_and(|tab| match live::close_tab(tab) {
            Ok(()) => true,
            Err(e) => {
                eprintln!("groundwork: couldn't close this tab: {e}");
                false
            }
        });
    log.done(&id, outcome, &summary, closing)
        .map_err(|e| e.to_string())?;

    if json {
        return print_json(&serde_json::json!({ "id": id, "closing": closing }));
    }
    if closing {
        println!("Logged. This tab closes when your turn ends; there's nothing more to do.");
    } else {
        println!("Logged. The tab stays open.");
    }
    Ok(())
}

pub fn list(vault: &Path, limit: usize, json: bool) -> Fallible<()> {
    let entries = CommandLog::new(vault).list(limit);
    if json {
        return print_json(&entries);
    }
    if entries.is_empty() {
        println!("Nothing asked from the command bar yet.");
    }
    for e in &entries {
        print_entry(e);
    }
    Ok(())
}

fn print_entry(e: &CommandEntry) {
    let when = e.asked.get(..16).unwrap_or(&e.asked).replace('T', " ");
    let mut marks = vec![outcome_name(e.outcome)];
    if e.shown {
        marks.push("shown");
    }
    if e.outcome.is_some() {
        marks.push(if e.closed { "closed" } else { "left open" });
    }
    println!("{when} · {} · {}", marks.join(", "), e.prompt.trim());
    if let Some(summary) = &e.summary {
        println!("  → {summary}");
    }
    let mut about: Vec<String> = Vec::new();
    if let Some(note) = &e.context.note {
        about.push(format!("note {note}"));
    }
    if let Some(project) = &e.context.project {
        about.push(format!("project {project}"));
    }
    if let Some(workspace) = &e.context.workspace {
        about.push(format!("workspace {workspace}"));
    }
    if !about.is_empty() {
        println!("  pointed at: {}", about.join(", "));
    }
    match &e.session {
        Some(session) => println!("  id {} · claude --resume {session}", e.id),
        None => println!("  id {}", e.id),
    }
}
