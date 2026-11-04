//! Runs the `groundwork` binary against a copy of the fixture vault.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

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
        let _ = fs::remove_dir_all(dir.path().join(".groundwork/activity"));
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
