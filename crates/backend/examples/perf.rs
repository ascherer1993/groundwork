//! Times the requests the app makes, against a vault: for the performance
//! pass (PLAN Phase 8). Make a big vault with `scripts/make-big-vault`, then
//!
//!     cargo run --release -p groundwork-backend --example perf -- <vault> [--runs 5]
//!
//! It works on a copy's worth of care: writes go to a scratch note it makes
//! and removes, and a rename it undoes. Each request runs `--runs` times;
//! it prints the median and the slowest.

use std::path::Path;
use std::time::{Duration, Instant};

use groundwork_backend::Backend;
use groundwork_protocol::Host;
use serde_json::{Value, json};

fn main() {
    let mut args = std::env::args().skip(1);
    let vault = args.next().expect("usage: perf <vault> [--runs 5]");
    let mut runs = 5;
    while let Some(arg) = args.next() {
        if arg == "--runs" {
            runs = args
                .next()
                .and_then(|r| r.parse().ok())
                .expect("--runs <n>");
        }
    }
    let data = tempfile::tempdir().unwrap();
    let backend = Backend::new(
        Host::DevServer,
        data.path().to_path_buf(),
        std::sync::Arc::new(|_| {}),
    );
    let call = |method: &str, params: Value| -> Value {
        backend
            .handle_value(json!({ "method": method, "params": params }))
            .unwrap_or_else(|e| panic!("{method}: {e:?}"))
    };

    let started = Instant::now();
    call("vault.open", json!({ "path": vault }));
    println!(
        "{:<34} {:>9}",
        "vault.open (first, no snapshot)",
        ms(started.elapsed())
    );

    // Targets: the most linked-to note, a daily note, a project.
    let files = call("index.files", Value::Null);
    let paths: Vec<String> = files
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap().to_string())
        .collect();
    let notes = paths.iter().filter(|p| p.ends_with(".md")).count();
    println!("{} files, {notes} notes\n", paths.len());
    let person = paths
        .iter()
        .filter(|p| p.starts_with("Contacts/"))
        .max_by_key(|p| {
            call("links.backlinks", json!({ "path": p }))
                .as_array()
                .map_or(0, Vec::len)
        })
        .cloned()
        .unwrap_or_else(|| paths[0].clone());
    let daily = paths
        .iter()
        .rev()
        .find(|p| p.starts_with("Daily/"))
        .cloned()
        .unwrap_or_else(|| paths[0].clone());
    let projects = call("project.list", Value::Null);
    let project = projects[0]["id"].as_str().unwrap_or("").to_string();
    let text = call("file.read", json!({ "path": person }))["text"]
        .as_str()
        .unwrap_or("")
        .to_string();
    println!("most linked: {person}\ndaily: {daily}\nproject: {project}\n");

    let time = |label: &str, f: &dyn Fn() -> Value| {
        let mut times = Vec::new();
        let mut size = 0;
        for _ in 0..runs {
            let t = Instant::now();
            let out = f();
            times.push(t.elapsed());
            size = out.to_string().len();
        }
        times.sort();
        println!(
            "{label:<34} {:>9} {:>9}  {:>8} KB",
            ms(times[times.len() / 2]),
            ms(*times.last().unwrap()),
            size / 1024
        );
    };
    println!(
        "{:<34} {:>9} {:>9}  {:>11}",
        "request", "median", "slowest", "reply"
    );
    time("vault.tree", &|| call("vault.tree", Value::Null));
    time("index.files", &|| call("index.files", Value::Null));
    time("index.tags", &|| call("index.tags", Value::Null));
    time("file.read", &|| {
        call("file.read", json!({ "path": person }))
    });
    time("index.note", &|| {
        call("index.note", json!({ "path": person }))
    });
    time("links.backlinks (most linked)", &|| {
        call("links.backlinks", json!({ "path": person }))
    });
    time("links.unlinked (most linked)", &|| {
        call("links.unlinked", json!({ "path": person }))
    });
    time("links.outgoing", &|| {
        call("links.outgoing", json!({ "path": daily }))
    });
    time("search.query (2 words)", &|| {
        call("search.query", json!({ "query": "deploy latency" }))
    });
    time("search.query (rare phrase)", &|| {
        call(
            "search.query",
            json!({ "query": "\"vendor contract customer\"" }),
        )
    });
    time("search.query (#tag)", &|| {
        call("search.query", json!({ "query": "#risk" }))
    });
    time("todo.list (open)", &|| {
        call("todo.list", json!({ "filter": {} }))
    });
    time("todo.day", &|| call("todo.day", json!({ "path": daily })));
    time("context.get", &|| {
        call("context.get", json!({ "note": daily }))
    });
    time("project.list", &|| call("project.list", Value::Null));
    time("project.view", &|| {
        call("project.view", json!({ "project": project }))
    });
    time("who.knows", &|| {
        call("who.knows", json!({ "topic": "migration" }))
    });
    time("ticket.list", &|| {
        call("ticket.list", json!({ "filter": {} }))
    });

    // Writes: a scratch note, saved as if typed into.
    let scratch = "zz-perf-scratch.md";
    call(
        "file.create",
        json!({ "path": scratch, "text": "# Scratch\n" }),
    );
    let n = std::cell::Cell::new(0);
    time("file.write (a save)", &|| {
        n.set(n.get() + 1);
        call(
            "file.write",
            json!({ "path": scratch, "text": format!("# Scratch\n\n{text}\n{}\n", n.get()) }),
        )
    });
    time("file.write (most linked)", &|| {
        call("file.write", json!({ "path": person, "text": text }))
    });
    call("file.delete", json!({ "path": scratch }));

    // A rename that rewrites every link to the most linked note, then back.
    let name = Path::new(&person).file_stem().unwrap().to_string_lossy();
    let renamed = person.replace(&*name, &format!("{name} Renamed"));
    let t = Instant::now();
    let out = call("file.rename", json!({ "from": person, "to": renamed }));
    println!(
        "{:<34} {:>9}            ({} files rewritten)",
        "file.rename (most linked)",
        ms(t.elapsed()),
        out["updatedNotes"].as_array().map_or(0, Vec::len)
    );
    call("file.rename", json!({ "from": renamed, "to": person }));

    // Opening again, with the snapshot the first open saved.
    call("vault.close", Value::Null);
    let t = Instant::now();
    call("vault.open", json!({ "path": vault }));
    println!("{:<34} {:>9}", "vault.open (again)", ms(t.elapsed()));
}

fn ms(d: Duration) -> String {
    format!("{:.1} ms", d.as_secs_f64() * 1000.0)
}
