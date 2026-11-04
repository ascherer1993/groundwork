//! Runs the `groundwork` binary against a copy of the fixture vault.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The fixture page's state, if someone used the page in the app.
const PAGE_STATE: &str = "Projects/Acme/demos/login-flow.page/state.json";

struct Vault {
    dir: tempfile::TempDir,
    data: tempfile::TempDir,
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

impl Vault {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/vault");
        copy_dir(&fixture, dir.path());
        // Left over from using the fixture vault in the app.
        let _ = fs::remove_dir_all(dir.path().join(".groundwork/activity"));
        let _ = fs::remove_dir_all(dir.path().join(".groundwork/page-state"));
        let _ = fs::remove_file(dir.path().join(PAGE_STATE));
        Self {
            dir,
            data: tempfile::tempdir().unwrap(),
        }
    }

    fn root(&self) -> PathBuf {
        self.dir.path().to_path_buf()
    }

    /// Runs `groundwork <args>`; returns (success, stdout, stderr).
    fn run(&self, args: &[&str]) -> (bool, String, String) {
        let out = Command::new(env!("CARGO_BIN_EXE_groundwork"))
            .args(args)
            .arg("--vault")
            .arg(self.dir.path())
            .env("GROUNDWORK_DATA_DIR", self.data.path())
            .env_remove("GROUNDWORK_VAULT")
            .output()
            .unwrap();
        (
            out.status.success(),
            String::from_utf8(out.stdout).unwrap(),
            String::from_utf8(out.stderr).unwrap(),
        )
    }

    fn ok(&self, args: &[&str]) -> String {
        let (ok, out, err) = self.run(args);
        assert!(ok, "groundwork {args:?} failed: {err}");
        out
    }

    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.dir.path().join(path)).unwrap()
    }
}

#[test]
fn notes_links_and_search() {
    let v = Vault::new();
    assert_eq!(
        v.ok(&["note", "path", "Jane Doe"]),
        "Contacts/Jane Doe.md\n"
    );
    assert!(v.ok(&["note", "read", "Welcome"]).contains("# Welcome"));
    let links = v.ok(&["links", "Welcome"]);
    assert!(links.contains("Projects/Acme/Acme.md\n"), "{links}");
    let backlinks = v.ok(&["backlinks", "Jane Doe"]);
    assert!(
        backlinks.contains("Daily/2026-11-03.md:10: - [ ] Ask [[Jane Doe]]"),
        "{backlinks}"
    );
    // Pages link to notes too.
    let backlinks = v.ok(&["backlinks", "2026-11-02 Kickoff"]);
    assert!(
        backlinks.contains("Projects/Acme/demos/login-flow.page:20: Back to Acme · Kickoff notes"),
        "{backlinks}"
    );
    let links = v.ok(&["links", "login-flow.page"]);
    assert_eq!(
        links,
        "Projects/Acme/Acme.md\nProjects/Acme/Meetings/2026-11-02 Kickoff.md\n"
    );

    // The whole vault in two calls.
    let files = v.ok(&["files"]);
    assert!(files.contains("Welcome.md\n"), "{files}");
    assert!(
        files.contains("Projects/Acme/demos/login-flow.page (page)\n"),
        "{files}"
    );
    assert!(
        !files.contains("index.html") && !files.contains(".obsidian"),
        "{files}"
    );
    assert!(!files.lines().any(|l| l == "Projects"), "{files}");
    let demos = v.ok(&["files", "--path", "Projects/Acme/demos/"]);
    assert_eq!(demos.lines().count(), 4, "{demos}");
    let all = v.ok(&["links", "--all"]);
    assert!(
        all.contains("Welcome.md -> Contacts/Jane Doe.md\n"),
        "{all}"
    );
    assert!(
        all.contains(
            "Projects/Acme/demos/Demo review.md -> Projects/Acme/demos/login-flow.page (embed)\n"
        ),
        "{all}"
    );
    assert!(
        all.contains(
            "Projects/Acme/demos/login-flow.page -> Projects/Acme/Meetings/2026-11-02 Kickoff.md\n"
        ),
        "{all}"
    );
    let (ok, _, err) = v.run(&["links"]);
    assert!(!ok && err.contains("<NOTE>"), "{err}");

    let found = v.ok(&["search", "auth", "migration"]);
    assert!(found.starts_with("Daily/2026-11-03.md:10: "), "{found}");

    let info: serde_json::Value =
        serde_json::from_str(&v.ok(&["note", "info", "Welcome", "--json"])).unwrap();
    assert_eq!(info["path"], "Welcome.md");
    assert_eq!(info["tags"][0], "meta");
    assert_eq!(info["todos"][0]["text"], "Try the quick switcher");

    let (ok, _, err) = v.run(&["note", "read", "No such note"]);
    assert!(!ok && err.contains("no note named"), "{err}");
}

#[test]
fn templates_and_daily_notes() {
    let v = Vault::new();
    assert_eq!(
        v.ok(&["template", "list"]),
        "Templates/Daily.md\nTemplates/Meeting.md\nTemplates/Ticket.md\n"
    );
    // Prompts must be answered on the command line.
    let (ok, _, err) = v.run(&["note", "create", "Notes/Sync", "--template", "Meeting"]);
    assert!(!ok && err.contains("asks for Attendees"), "{err}");
    let path = v.ok(&[
        "note",
        "create",
        "Notes/Sync",
        "--template",
        "Templates/Meeting",
        "--var",
        "Attendees=Jane, Bob",
        "--date",
        "2026-11-03",
    ]);
    assert_eq!(path, "Notes/Sync.md\n");
    let text = v.read("Notes/Sync.md");
    assert!(
        text.contains("# Sync\n\n**When:** Tuesday, November 3 · **With:** Jane, Bob"),
        "{text}"
    );

    v.ok(&["note", "create", "Notes/Plain", "--text", "# Plain\n"]);
    let plain = v.read("Notes/Plain.md");
    assert!(
        plain.starts_with("---\ncreated: 20") && plain.ends_with("---\n# Plain\n"),
        "{plain}"
    );

    // Text with frontmatter: `---` isn't mistaken for a flag, and `created`
    // joins the existing properties.
    v.ok(&[
        "note",
        "create",
        "Notes/Props",
        "--text",
        "---\ntype: idea\n---\n# Props\n",
    ]);
    let props = v.read("Notes/Props.md");
    assert!(
        props.starts_with("---\ntype: idea\ncreated: 20") && props.ends_with("---\n# Props\n"),
        "{props}"
    );
    // `--text -` reads stdin.
    let mut child = Command::new(env!("CARGO_BIN_EXE_groundwork"))
        .args(["note", "create", "Notes/Piped", "--text", "-", "--vault"])
        .arg(v.root())
        .env("GROUNDWORK_DATA_DIR", v.data.path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"---\ntags: [piped]\n---\nFrom [[Jane Doe]].\n")
        .unwrap();
    assert!(child.wait().unwrap().success());
    assert!(
        v.read("Notes/Piped.md")
            .ends_with("---\nFrom [[Jane Doe]].\n")
    );
    v.ok(&["todo", "add", "-- a dashed todo", "--note", "Notes/Piped"]);
    assert!(
        v.read("Notes/Piped.md")
            .contains("- [ ] -- a dashed todo ➕ ")
    );

    assert_eq!(
        v.ok(&["daily", "--date", "2026-11-10"]),
        "Daily/2026-11-10.md\n"
    );
    assert!(v.read("Daily/2026-11-10.md").contains("[[2026-11-09]]"));
    assert_eq!(
        v.ok(&[
            "template",
            "render",
            "Daily",
            "--note",
            "Daily/2026-12-25.md"
        ])
        .lines()
        .nth(3),
        Some("# Friday, December 25")
    );
}

#[test]
fn todos_round_trip() {
    let v = Vault::new();
    let id = v
        .ok(&[
            "todo",
            "add",
            "Renew passport",
            "--due",
            "2026-11-20",
            "--priority",
            "p1",
            "--note",
            "Welcome",
        ])
        .trim()
        .to_string();
    assert!(id.starts_with("Welcome.md:"), "{id}");
    assert!(
        v.read("Welcome.md")
            .contains("- [ ] Renew passport ⏫ 📅 2026-11-20 ➕ ")
    );

    let listed: Vec<serde_json::Value> =
        serde_json::from_str(&v.ok(&["todo", "list", "--priority", "p0-p1", "--json"])).unwrap();
    let texts: Vec<&str> = listed.iter().map(|t| t["text"].as_str().unwrap()).collect();
    assert_eq!(
        texts,
        [
            "Ask [[Jane Doe]] about the auth migration",
            "Renew passport"
        ]
    );

    v.ok(&["todo", "reschedule", &id, "2026-11-22"]);
    v.ok(&["todo", "done", &id]);
    assert!(v.read("Welcome.md").contains("- [x] Renew passport ⏫ ➕ "),);
    let done = v.ok(&["todo", "list", "--status", "done", "--path", "Welcome"]);
    assert!(
        done.starts_with("[x] Renew passport  (p1, due 2026-11-22, created "),
        "{done}"
    );

    // Ids carry a hash of the text, so a changed line isn't edited by mistake.
    let welcome = v
        .read("Welcome.md")
        .replace("Renew passport", "Something else");
    fs::write(v.root().join("Welcome.md"), welcome).unwrap();
    let (ok, _, err) = v.run(&["todo", "reopen", &id]);
    assert!(!ok && err.contains("changed since it was listed"), "{err}");

    // Every change is in the activity log, attributed to the CLI.
    let log = v.ok(&["activity", "--path", "Welcome"]);
    for kind in ["taskAdded", "taskRescheduled", "taskDone"] {
        assert!(
            log.lines().any(|l| l.contains(kind) && l.contains("cli")),
            "{kind} missing:\n{log}"
        );
    }
}

/// Runs `groundwork <args>` in `cwd` without `--vault`.
fn run_in(v: &Vault, cwd: &Path, args: &[&str]) -> (bool, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_groundwork"))
        .args(args)
        .current_dir(cwd)
        .env("GROUNDWORK_DATA_DIR", v.data.path())
        .env_remove("GROUNDWORK_VAULT")
        .output()
        .unwrap();
    (
        out.status.success(),
        String::from_utf8(out.stdout).unwrap(),
        String::from_utf8(out.stderr).unwrap(),
    )
}

#[test]
fn says_which_vault_it_uses_and_why() {
    let v = Vault::new();
    let elsewhere = tempfile::tempdir().unwrap();
    let root = v.root().canonicalize().unwrap();
    let (ok, _, err) = run_in(&v, elsewhere.path(), &["vault"]);
    assert!(!ok && err.contains("no vault found"), "{err}");

    // The default chosen in the app.
    groundwork_core::setup::set_default_vault(v.data.path(), &root).unwrap();
    let (_, out, _) = run_in(&v, elsewhere.path(), &["vault", "--json"]);
    let found: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(found["path"], root.to_str().unwrap());
    assert_eq!(found["source"], "the default vault set in Groundwork");

    // The folder you're in wins over the default.
    let (_, out, _) = run_in(&v, &root.join("Projects"), &["vault"]);
    assert!(
        out.ends_with("(from the vault containing the current folder)\n"),
        "{out}"
    );
    assert!(v.ok(&["vault"]).ends_with("(from --vault)\n"));

    // A default that's gone is an error, not a silent fallback.
    let gone = elsewhere.path().join("gone");
    groundwork_core::setup::set_default_vault(v.data.path(), &gone).unwrap();
    let (ok, _, err) = run_in(&v, elsewhere.path(), &["vault"]);
    assert!(!ok && err.contains("no longer exists"), "{err}");
}

#[test]
fn finds_the_vault_from_the_current_folder() {
    let v = Vault::new();
    let out = Command::new(env!("CARGO_BIN_EXE_groundwork"))
        .args(["note", "path", "Acme"])
        .current_dir(v.root().join("Projects/Acme"))
        .env("GROUNDWORK_DATA_DIR", v.data.path())
        .env_remove("GROUNDWORK_VAULT")
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        "Projects/Acme/Acme.md\n"
    );
}

#[test]
fn reads_and_sets_page_state() {
    let v = Vault::new();
    assert_eq!(v.ok(&["page", "state", "login-flow.page"]), "null\n");
    v.ok(&[
        "page",
        "state",
        "login-flow.page",
        "--set",
        r#"{"reviewed": true}"#,
    ]);
    assert_eq!(
        v.read("Projects/Acme/demos/login-flow.page/state.json"),
        "{\n  \"reviewed\": true\n}\n"
    );

    // A single-file page keeps its state under .groundwork/.
    let set = v.ok(&[
        "page",
        "state",
        "Projects/Acme/demos/sketch.html",
        "--set",
        "[1, 2]",
        "--json",
    ]);
    let set: serde_json::Value = serde_json::from_str(&set).unwrap();
    assert_eq!(set["page"], "Projects/Acme/demos/sketch.html");
    assert_eq!(
        set["file"],
        ".groundwork/page-state/Projects/Acme/demos/sketch.html.json"
    );
    assert_eq!(set["state"], serde_json::json!([1, 2]));

    let (ok, _, err) = v.run(&["page", "state", "Welcome"]);
    assert!(!ok && err.contains("isn't a page"), "{err}");
    let (ok, _, err) = v.run(&["page", "state", "login-flow.page", "--set", "{nope"]);
    assert!(!ok && err.contains("isn't JSON"), "{err}");
}

#[test]
fn the_plugin_hooks_speak_only_inside_groundwork() {
    let plugin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../claude-plugin");
    let hooks: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(plugin.join("hooks/hooks.json")).unwrap())
            .unwrap();
    for (event, arg) in [
        ("SessionStart", "session-start"),
        ("UserPromptSubmit", "prompt"),
        ("Notification", "notification"),
        ("Stop", "stop"),
    ] {
        let command = hooks["hooks"][event][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert_eq!(
            command,
            format!("\"${{CLAUDE_PLUGIN_ROOT}}/hooks/run\" {arg}")
        );
    }

    let data = tempfile::tempdir().unwrap();
    // The built CLI first on PATH, as in a Groundwork terminal.
    let bin = Path::new(env!("CARGO_BIN_EXE_groundwork"))
        .parent()
        .unwrap();
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    let run = |event: &str, tab: Option<&str>| {
        let mut cmd = Command::new(plugin.join("hooks/run"));
        cmd.arg(event)
            .env("PATH", &path)
            .env("GROUNDWORK_VAULT", "/Users/me/Notes")
            .env("GROUNDWORK_DATA_DIR", data.path())
            // No app is listening: the hooks still succeed.
            .env("GROUNDWORK_SOCKET", data.path().join("none.sock"))
            .env_remove("GROUNDWORK_TAB_ID")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped());
        if let Some(tab) = tab {
            cmd.env("GROUNDWORK_TAB_ID", tab);
        }
        let mut child = cmd.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(br#"{"session_id":"s-1","message":"hi"}"#)
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        String::from_utf8(out.stdout).unwrap()
    };
    let inside = run("session-start", Some("t0123"));
    assert!(inside.contains("The vault is /Users/me/Notes."), "{inside}");
    assert!(inside.contains("load the groundwork skill"), "{inside}");
    assert!(inside.contains("groundwork ask"), "{inside}");
    assert_eq!(run("session-start", None), "");
    // UserPromptSubmit output would become context: it says nothing.
    assert_eq!(run("prompt", Some("t0123")), "");
}

#[test]
fn hooks_report_permission_prompts_but_not_idle_reminders() {
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixListener;

    let data = tempfile::tempdir().unwrap();
    let socket = data.path().join("app.sock");
    // A stand-in for the app: records each request and says ok.
    let listener = UnixListener::bind(&socket).unwrap();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
    {
        let seen = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                seen.lock()
                    .unwrap()
                    .push(serde_json::from_str(&line).unwrap());
                writeln!(stream, r#"{{"ok":null}}"#).unwrap();
            }
        });
    }
    let hook = |input: &str| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_groundwork"))
            .args(["hook", "notification"])
            .env("GROUNDWORK_DATA_DIR", data.path())
            .env("GROUNDWORK_SOCKET", &socket)
            .env("GROUNDWORK_TAB_ID", "t1")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        assert!(child.wait().unwrap().success());
    };
    hook(
        r#"{"session_id":"s","message":"Claude is waiting for your input","notification_type":"idle_prompt"}"#,
    );
    hook(r#"{"session_id":"s","message":"Claude is waiting for your input"}"#);
    hook(
        r#"{"session_id":"s","message":"Claude needs your permission to use Bash","notification_type":"permission_prompt"}"#,
    );
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert_eq!(seen[0]["method"], "agent.hook");
    assert_eq!(seen[0]["params"]["tab"], "t1");
    assert_eq!(seen[0]["params"]["session"], "s");
    assert_eq!(
        seen[0]["params"]["message"],
        "Claude needs your permission to use Bash"
    );
}

#[test]
fn ask_and_notify_use_the_inbox_while_the_app_is_closed() {
    use groundwork_core::inbox::{Inbox, InboxKind};

    let data = tempfile::tempdir().unwrap();
    let cli = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_groundwork"))
            .args(args)
            .env("GROUNDWORK_DATA_DIR", data.path())
            .env("GROUNDWORK_SOCKET", data.path().join("none.sock"))
            .env("GROUNDWORK_TAB_ID", "t9")
            .env_remove("GROUNDWORK_VAULT")
            .output()
            .unwrap()
    };

    let out = cli(&["notify", "Reorganised Meetings/", "--link", "[[Meetings]]"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let inbox = Inbox::new(data.path());
    let open = inbox.open();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].kind, InboxKind::Notify);
    assert_eq!(open[0].link.as_deref(), Some("[[Meetings]]"));
    assert_eq!(open[0].tab.as_deref(), Some("t9"));

    // Someone answers in the file, as the app would once it opens.
    let answerer = {
        let dir = data.path().to_path_buf();
        std::thread::spawn(move || {
            let inbox = Inbox::new(&dir);
            for _ in 0..100 {
                if let Some(q) = inbox.open().into_iter().find(|i| i.kind == InboxKind::Ask) {
                    inbox.answer(&q.id, Some("staging".into())).unwrap();
                    return q;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            panic!("no question appeared");
        })
    };
    let out = cli(&[
        "ask",
        "Which env?",
        "--choice",
        "staging",
        "--choice",
        "prod",
    ]);
    let question = answerer.join().unwrap();
    assert_eq!(question.choices, ["staging", "prod"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8(out.stdout).unwrap(), "staging\n");

    // Unanswered, it gives up and withdraws the question.
    let out = cli(&["ask", "Anyone?", "--timeout", "1"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("no answer after 1 seconds"));
    assert!(inbox.open().iter().all(|i| i.text != "Anyone?"));
}

/// A git repo with one commit on `main`, pushed to a bare `origin`.
fn git_repo(dir: &Path) -> PathBuf {
    let git = |cwd: &Path, args: &[&str]| {
        let out = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    let repo = dir.join("acme");
    fs::create_dir_all(repo.join("apps/web")).unwrap();
    git(dir, &["init", "-q", "--bare", "-b", "main", "origin.git"]);
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["config", "user.name", "Test"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    fs::write(repo.join("apps/web/index.js"), "\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "first"]);
    git(
        &repo,
        &[
            "remote",
            "add",
            "origin",
            dir.join("origin.git").to_str().unwrap(),
        ],
    );
    git(&repo, &["push", "-q", "-u", "origin", "main"]);
    fs::canonicalize(repo).unwrap()
}

#[test]
fn tickets_from_create_to_close() {
    let v = Vault::new();
    let code = tempfile::tempdir().unwrap();
    let repo = git_repo(code.path());

    assert_eq!(v.ok(&["project", "list"]), "acme · Acme · Projects/Acme\n");
    let repos = v.ok(&["repo", "list"]);
    assert!(
        repos.contains("not located (groundwork repo locate acme-platform <path>)"),
        "{repos}"
    );
    let (ok, _, err) = v.run(&[
        "ticket",
        "create",
        "--key",
        "TEAM-7",
        "--title",
        "Fix signup",
        "--project",
        "acme",
    ]);
    assert!(
        !ok && err.contains("acme-platform repo hasn't been located"),
        "{err}"
    );

    let located = v.ok(&[
        "repo",
        "locate",
        "acme-platform",
        repo.join("apps").to_str().unwrap(),
    ]);
    assert!(located.contains("acme-worktrees"), "{located}");
    let show = v.ok(&["repo", "show", "acme-platform"]);
    assert!(
        show.contains("web (apps/web)") && show.contains("used by: Acme"),
        "{show}"
    );

    // The fixture's setup is `npm install`; skip it here.
    let created = v.ok(&[
        "ticket",
        "create",
        "--key",
        "TEAM-7",
        "--title",
        "Fix signup",
        "--project",
        "acme",
        "--code",
        "acme-platform:web",
        "--no-setup",
    ]);
    let wt = repo
        .with_file_name("acme-worktrees")
        .join("TEAM-7-fix-signup");
    assert_eq!(
        created,
        format!(
            "Projects/Acme/Work/TEAM-7 Fix signup.md\n  worktree: {}\n  branch: TEAM-7-fix-signup\n",
            wt.display()
        )
    );
    assert!(wt.join("apps/web/index.js").is_file());
    let list = v.ok(&["ticket", "list", "--project", "Acme"]);
    assert!(
        list.contains("TEAM-7 Fix signup · Projects/Acme/Work/TEAM-7 Fix signup.md"),
        "{list}"
    );

    // Context from inside the worktree, as an agent there would ask.
    let (ok, context, err) = run_in(
        &v,
        &wt.join("apps/web"),
        &["context", "--vault", v.root().to_str().unwrap()],
    );
    assert!(ok, "{err}");
    assert!(context.contains("Ticket: TEAM-7 Fix signup"), "{context}");
    assert!(
        context.contains(&format!("  worktree: {}", wt.display())),
        "{context}"
    );
    assert!(
        context.contains("Component: acme-platform:web"),
        "{context}"
    );
    assert!(
        context.contains("  dev: npm run dev -w apps/web"),
        "{context}"
    );
    assert!(context.contains("Projects/Acme/Acme.md"), "{context}");
    let json: serde_json::Value =
        serde_json::from_str(&v.ok(&["context", "--note", "TEAM-7 Fix signup", "--json"])).unwrap();
    assert_eq!(json["ticket"]["branch"], "TEAM-7-fix-signup");

    let who = v.ok(&[
        "code",
        "who",
        wt.join("apps/web/index.js").to_str().unwrap(),
    ]);
    assert!(
        who.contains("components: acme-platform:web") && who.contains("project: Acme"),
        "{who}"
    );
    assert!(who.contains("ticket: TEAM-7 Fix signup"), "{who}");

    let show = v.ok(&["ticket", "show", "TEAM-7 Fix signup"]);
    assert!(show.contains("git: not on the remote"), "{show}");
    let (ok, _, err) = v.run(&["ticket", "close", "TEAM-7 Fix signup"]);
    assert!(
        !ok && err.contains("its branch isn't on the remote. Use --force"),
        "{err}"
    );
    assert!(
        v.ok(&["ticket", "close", "TEAM-7 Fix signup", "--force"])
            .starts_with("closed ")
    );
    assert!(!wt.exists());
    assert!(
        v.read("Projects/Acme/Work/TEAM-7 Fix signup.md")
            .contains("status: closed\n")
    );
    assert!(!v.ok(&["ticket", "list"]).contains("TEAM-7"));
    assert!(
        v.ok(&["ticket", "list", "--status", "closed"])
            .contains("TEAM-7 Fix signup [closed]")
    );

    v.ok(&["ticket", "restore", "TEAM-7 Fix signup", "--no-setup"]);
    assert!(wt.is_dir());
}
