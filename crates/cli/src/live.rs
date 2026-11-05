//! `open`, `workspace` and `tab`: commands that act on the running app's
//! window, through its socket. Unlike the rest of the CLI they need the app,
//! and they work on the vault it has open.

use std::path::Path;
use std::time::Duration;

use groundwork_core::workspaces::Workspace;
use groundwork_protocol::TabInfo;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::app::App;
use crate::{Fallible, print_json};

/// Long enough for the window to start a terminal.
const TIMEOUT: Duration = Duration::from_secs(30);
/// Between typing text into a tab and pressing Enter, so a program that
/// tells pastes from typing (Claude Code) takes the Enter as submitting.
const BEFORE_ENTER: Duration = Duration::from_millis(150);

fn call<T: DeserializeOwned>(method: &str, params: Value) -> Fallible<T> {
    let mut app =
        App::connect(Some(TIMEOUT)).ok_or("Groundwork isn't running; this needs the app open")?;
    let value = app.call(method, params).map_err(|e| e.message())?;
    serde_json::from_value(value).map_err(|e| format!("unexpected reply from Groundwork: {e}"))
}

/// The terminal this runs in (`GROUNDWORK_TAB_ID`).
fn this_tab() -> Option<String> {
    std::env::var("GROUNDWORK_TAB_ID")
        .ok()
        .filter(|t| !t.is_empty())
}

fn tab_or_this(tab: Option<String>) -> Fallible<String> {
    tab.or_else(this_tab).ok_or_else(|| {
        "which tab? Pass --tab (see `groundwork tab list`), or run this in a Groundwork terminal"
            .into()
    })
}

/// A folder as the app needs it: absolute (`~/…` is fine).
fn absolute(folder: &str) -> Fallible<String> {
    if folder.starts_with('~') || Path::new(folder).is_absolute() {
        return Ok(folder.into());
    }
    let full = std::env::current_dir()
        .map_err(|e| e.to_string())?
        .join(folder);
    let full = full
        .canonicalize()
        .map_err(|_| format!("no folder at {}", full.display()))?;
    Ok(full.display().to_string())
}

pub fn open(target: String, line: Option<u32>, json: bool) -> Fallible<()> {
    // A file named from here (`open ./notes/x.md`) rather than by its name.
    let target = match Path::new(&target).canonicalize() {
        Ok(full) if full.is_file() => full.display().to_string(),
        _ => target,
    };
    let path: String = call("app.open", json!({ "target": target, "line": line }))?;
    if json {
        return print_json(&json!({ "path": path }));
    }
    println!("Opened {path}");
    Ok(())
}

fn workspaces() -> Fallible<Vec<Workspace>> {
    call("workspace.list", Value::Null)
}

pub fn workspace_list(json: bool) -> Fallible<()> {
    let list = workspaces()?;
    if json {
        return print_json(&list);
    }
    for w in list {
        let note = w.note.map(|n| format!(" · {n}")).unwrap_or_default();
        println!("{} · {} · {}{note}", w.id, w.name, w.cwd);
    }
    Ok(())
}

pub fn workspace_create(name: String, cwd: Option<String>, open: bool, json: bool) -> Fallible<()> {
    let cwd = cwd.as_deref().map(absolute).transpose()?;
    let workspace: Workspace = call("workspace.create", json!({ "name": name, "cwd": cwd }))?;
    if open {
        call::<Value>("app.showWorkspace", json!({ "workspace": workspace.id }))?;
    }
    if json {
        return print_json(&workspace);
    }
    println!("{}", workspace.id);
    Ok(())
}

pub fn workspace_open(workspace: String, json: bool) -> Fallible<()> {
    let workspace: Workspace = call("app.showWorkspace", json!({ "workspace": workspace }))?;
    if json {
        return print_json(&workspace);
    }
    println!("Showing {}", workspace.name);
    Ok(())
}

pub fn tab_list(json: bool) -> Fallible<()> {
    let tabs: Vec<TabInfo> = call("app.tabs", Value::Null)?;
    if json {
        return print_json(&tabs);
    }
    let names = workspaces().unwrap_or_default();
    let here = this_tab();
    for t in tabs {
        let workspace = names
            .iter()
            .find(|w| w.id == t.workspace)
            .map_or(t.workspace.as_str(), |w| w.name.as_str());
        let mut marks = Vec::new();
        if t.shown {
            marks.push("on screen");
        }
        if here.as_deref() == Some(t.terminal.as_str()) {
            marks.push("this tab");
        }
        let marks = if marks.is_empty() {
            String::new()
        } else {
            format!(" ({})", marks.join(", "))
        };
        println!("{} · {workspace} · {}{marks}", t.terminal, t.title);
    }
    Ok(())
}

pub fn tab_new(
    workspace: Option<String>,
    cwd: Option<String>,
    cmd: Option<String>,
    background: bool,
    json: bool,
) -> Fallible<()> {
    // By default it joins the workspace this runs in.
    let workspace = workspace.or_else(|| {
        std::env::var("GROUNDWORK_WORKSPACE_ID")
            .ok()
            .filter(|w| !w.is_empty())
    });
    let cwd = cwd.as_deref().map(absolute).transpose()?;
    let tab: TabInfo = call(
        "app.newTab",
        json!({ "workspace": workspace, "cwd": cwd, "run": cmd, "background": background }),
    )?;
    print_tab(&tab, json)
}

pub fn tab_fork(tab: Option<String>, background: bool, json: bool) -> Fallible<()> {
    let tab = tab_or_this(tab)?;
    let forked: TabInfo = call(
        "agent.fork",
        json!({ "tab": tab, "background": background }),
    )?;
    print_tab(&forked, json)
}

fn print_tab(tab: &TabInfo, json: bool) -> Fallible<()> {
    if json {
        return print_json(tab);
    }
    println!("{}", tab.terminal);
    Ok(())
}

pub fn tab_send(text: String, tab: Option<String>, enter: bool) -> Fallible<()> {
    let tab = tab_or_this(tab)?;
    call::<Value>("terminal.input", json!({ "id": tab, "data": text }))?;
    if enter {
        std::thread::sleep(BEFORE_ENTER);
        call::<Value>("terminal.input", json!({ "id": tab, "data": "\r" }))?;
    }
    Ok(())
}

pub fn tab_read(tab: Option<String>, lines: Option<u32>, json: bool) -> Fallible<()> {
    let tab = tab_or_this(tab)?;
    let text: String = call("terminal.read", json!({ "id": tab, "lines": lines }))?;
    if json {
        return print_json(&json!({ "tab": tab, "text": text }));
    }
    println!("{text}");
    Ok(())
}
