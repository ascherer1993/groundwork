//! `ask`, `notify` and `hook`: agents talking to the app. They go through
//! the app's socket; with the app closed, `ask` and `notify` use the inbox
//! file directly, and `ask` waits there for the answer.

use std::io::{IsTerminal, Read};
use std::time::{Duration, Instant};

use groundwork_core::data_dir;
use groundwork_core::inbox::{Inbox, InboxItem, InboxKind, NewItem};
use serde_json::{Value, json};

use crate::app::{App, CallError};
use crate::{Fallible, print_json};

/// How long a hook waits for the app: hooks hold Claude up.
const HOOK_TIMEOUT: Duration = Duration::from_secs(2);
/// How often to look at the inbox file while the app is closed.
const POLL: Duration = Duration::from_secs(1);

fn tab() -> Option<String> {
    std::env::var("GROUNDWORK_TAB_ID")
        .ok()
        .filter(|t| !t.is_empty())
}

fn vault() -> Option<String> {
    std::env::var("GROUNDWORK_VAULT")
        .ok()
        .filter(|v| !v.is_empty())
}

fn item_of(value: Value) -> Fallible<InboxItem> {
    serde_json::from_value(value).map_err(|e| format!("unexpected reply from Groundwork: {e}"))
}

/// Posts an item: through the app if it's running, else into the file.
fn post(kind: InboxKind, item: NewItem) -> Fallible<InboxItem> {
    if let Some(mut app) = App::connect(Some(Duration::from_secs(10))) {
        let method = match kind {
            InboxKind::Ask => "inbox.ask",
            _ => "inbox.notify",
        };
        let params = json!({
            "text": item.text,
            "choices": item.choices,
            "link": item.link,
            "tab": item.tab,
        });
        match app.call(method, params) {
            Ok(value) => return item_of(value),
            Err(CallError::Unreachable) => {}
            Err(e) => return Err(e.message()),
        }
    }
    eprintln!("groundwork: Groundwork isn't open; this waits in its inbox until it is.");
    Inbox::new(&data_dir())
        .add(kind, item)
        .map_err(|e| e.to_string())
}

pub fn notify(text: String, link: Option<String>, json: bool) -> Fallible<()> {
    let item = post_notify(text, link, tab())?;
    if json {
        return print_json(&item);
    }
    println!("{}", item.id);
    Ok(())
}

/// Tells the user something, from `tab` (it's where they're taken).
pub fn post_notify(text: String, link: Option<String>, tab: Option<String>) -> Fallible<InboxItem> {
    post(
        InboxKind::Notify,
        NewItem {
            text,
            link,
            tab,
            vault: vault(),
            ..Default::default()
        },
    )
}

pub fn ask(
    question: String,
    choices: Vec<String>,
    link: Option<String>,
    timeout: Option<u64>,
    no_wait: bool,
    json: bool,
) -> Fallible<()> {
    let item = post(
        InboxKind::Ask,
        NewItem {
            text: question,
            choices,
            link,
            tab: tab(),
            vault: vault(),
        },
    )?;
    if no_wait {
        if json {
            return print_json(&item);
        }
        println!("{}", item.id);
        return Ok(());
    }
    wait(&item.id, timeout, json)
}

/// Waits for the answer to a question posted with `ask --no-wait`.
pub fn wait(id: &str, timeout: Option<u64>, json: bool) -> Fallible<()> {
    let deadline = timeout.map(|s| Instant::now() + Duration::from_secs(s));
    let item = loop {
        let left = deadline.map(|d| d.saturating_duration_since(Instant::now()));
        if left == Some(Duration::ZERO) {
            dismiss(id);
            return Err(format!(
                "no answer after {} seconds; the question was withdrawn",
                timeout.unwrap_or_default()
            ));
        }
        let slice = left.map_or(Duration::from_secs(30), |l| l.min(Duration::from_secs(30)));
        if let Some(done) = wait_once(id, slice)? {
            break done;
        }
    };
    if json {
        return print_json(&item);
    }
    match item.answer {
        Some(answer) => {
            println!("{answer}");
            Ok(())
        }
        None => Err("the user dismissed the question without answering".into()),
    }
}

/// Waits up to `slice` for an answer: on the app if it's running, else by
/// looking at the file. `None` while there's none yet.
fn wait_once(id: &str, slice: Duration) -> Fallible<Option<InboxItem>> {
    if let Some(mut app) = App::connect(Some(slice + Duration::from_secs(10))) {
        let params = json!({ "id": id, "timeoutMs": slice.as_millis() as u64 });
        match app.call("inbox.wait", params) {
            Ok(value) => {
                let item = item_of(value)?;
                return Ok(item.done.then_some(item));
            }
            Err(CallError::Api { code, message }) if code == "not_found" => {
                return Err(format!("the question is gone from the inbox ({message})"));
            }
            Err(CallError::Api { message, .. }) => return Err(message),
            // The app closed while waiting: carry on with the file.
            Err(CallError::Unreachable) => {}
        }
    }
    let item = Inbox::new(&data_dir())
        .get(id)
        .ok_or("the question is gone from the inbox")?;
    if item.done {
        return Ok(Some(item));
    }
    std::thread::sleep(POLL.min(slice));
    Ok(None)
}

fn dismiss(id: &str) {
    if let Some(mut app) = App::connect(Some(HOOK_TIMEOUT))
        && app.call("inbox.answer", json!({ "id": id })).is_ok()
    {
        return;
    }
    let _ = Inbox::new(&data_dir()).answer(id, None);
}

/// Reports a hook to the app. Never fails: a hook that errors gets in
/// Claude's way, and outside a Groundwork terminal there's nothing to do.
/// `context` gives SessionStart's context; `started` hears the terminal
/// and Claude's session as one starts.
pub fn hook(
    event: &str,
    context: impl FnOnce() -> Option<String>,
    started: impl FnOnce(&str, Option<&str>),
) {
    let Some(tab) = tab() else { return };
    // Claude Code passes the hook's details as JSON on stdin.
    let mut input = String::new();
    if !std::io::stdin().is_terminal() {
        let _ = std::io::stdin().read_to_string(&mut input);
    }
    let input: Value = serde_json::from_str(&input).unwrap_or(Value::Null);
    // Claude's reminder after a minute idle at its prompt: Stop already said
    // it finished, so it isn't worth an inbox item. Permission prompts are.
    if event == "notification" && is_idle_reminder(&input) {
        return;
    }

    if event == "session-start" {
        started(&tab, input["session_id"].as_str());
        print_session_start(context());
    }
    if let Some(mut app) = App::connect(Some(HOOK_TIMEOUT)) {
        let _ = app.call(
            "agent.hook",
            json!({
                "tab": tab,
                "event": event,
                "session": input["session_id"].as_str(),
                "message": input["message"].as_str(),
            }),
        );
    }
}

fn is_idle_reminder(input: &Value) -> bool {
    input["notification_type"] == "idle_prompt"
        || input["message"]
            .as_str()
            .is_some_and(|m| m.starts_with("Claude is waiting for your input"))
}

/// What SessionStart adds to Claude's context in a Groundwork terminal.
fn print_session_start(context: Option<String>) {
    let vault = vault().unwrap_or_else(|| "the one `groundwork vault` reports".into());
    println!(
        "This session is running in a terminal tab inside Groundwork, the user's notes app (an Obsidian-compatible vault with HTML pages and terminals). The vault is {vault}. It's open beside this terminal, and notes you write appear there as you save them.\n\
         Before reading, writing or describing anything in the vault (notes, todos, daily notes, templates, HTML pages), load the groundwork skill. It covers the vault's conventions, what the app shows and renders, and the `groundwork` CLI, which is already on PATH.\n\
         When you need the user to decide something while they may be elsewhere, `groundwork ask` puts the question in Groundwork's inbox and waits for the answer; `groundwork notify` tells them something without waiting."
    );
    if let Some(context) = context.filter(|c| !c.trim().is_empty()) {
        println!(
            "\nWhere this terminal is, from `groundwork context` (run `groundwork context --json` for more):\n{}",
            context.trim_end()
        );
    }
}
