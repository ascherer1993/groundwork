//! `groundwork`: the vault from the terminal, for you and for agents.
//!
//! Every command works on the vault's files directly, so the app doesn't
//! need to be running. Changes are logged to the activity log as `cli`.
//! `--json` gives machine-readable output.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use chrono::{DateTime, Duration, Local, NaiveDate};
use clap::{Args, Parser, Subcommand};
use groundwork_core::activity::{ActivitySource, read_events};
use groundwork_core::dates::parse_natural;
use groundwork_core::pages;
use groundwork_core::session::with_created_property;
use groundwork_core::setup::default_vault;
use groundwork_core::tickets::{Context, CreatedTicket, NewTicket, Ticket, TicketFilter};
use groundwork_core::todos::{DueFilter, StatusFilter, TaskChange, Todo, TodoFilter};

use groundwork_core::{CoreError, NodeKind, RecentVaults, Session, Vault, data_dir, search};
use serde::Serialize;

#[derive(Parser)]
#[command(
    name = "groundwork",
    version,
    about = "Work with a Groundwork (Obsidian-compatible) vault"
)]
struct Cli {
    /// The vault folder. By default: $GROUNDWORK_VAULT, else the vault
    /// containing the current folder, else the default vault chosen in the
    /// app ("Set up Claude Code…"), else the vault the app opened last.
    /// `groundwork vault` shows which one applies.
    #[arg(long, global = true, env = "GROUNDWORK_VAULT")]
    vault: Option<PathBuf>,
    /// Print JSON instead of text.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Read, create and inspect notes.
    #[command(subcommand)]
    Note(NoteCommand),
    /// Every note, page and other file, as the app's file tree lists them:
    /// hidden folders and the insides of `.page` bundles are left out.
    Files {
        /// Only files under this folder.
        #[arg(long)]
        path: Option<String>,
    },
    /// A note's or page's outgoing links and where they point; with `--all`,
    /// every link in the vault.
    Links {
        #[arg(required_unless_present = "all")]
        note: Option<String>,
        #[arg(long, conflicts_with = "note")]
        all: bool,
    },
    /// Notes and pages linking to a note or page, with the linking lines.
    Backlinks { note: String },
    /// Full-text search. Words must all appear; supports "phrases",
    /// -exclude, path:folder and #tag.
    Search {
        #[arg(required = true)]
        query: Vec<String>,
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
    /// List and render templates.
    #[command(subcommand)]
    Template(TemplateCommand),
    /// Print the path of a daily note, creating it from the daily template
    /// if needed.
    Daily {
        /// `today` (default), `yesterday`, `fri`, `+1d`, `nov 12`, `YYYY-MM-DD`…
        #[arg(long, default_value = "today")]
        date: String,
    },
    /// List, add and update todos.
    #[command(subcommand)]
    Todo(TodoCommand),
    /// HTML pages: read or set the state they save.
    #[command(subcommand)]
    Page(PageCommand),
    /// Which vault commands use, and why. Run this first if unsure.
    Vault,
    /// Everything an agent needs to orient itself: the ticket, its projects,
    /// the repo and worktree, the components involved (paths, commands, docs
    /// to read), the actions available, and notes worth reading. For the
    /// current folder by default.
    Context {
        /// A note (path or link name) instead of a folder.
        #[arg(long, conflicts_with = "cwd")]
        note: Option<String>,
        /// A folder: in a worktree, a repo checkout or the vault.
        #[arg(long)]
        cwd: Option<PathBuf>,
    },
    /// Projects: folders with a `.groundwork.yml`.
    #[command(subcommand)]
    Project(ProjectCommand),
    /// Code repos (`.groundwork/repos.yml`) and where they are on this machine.
    #[command(subcommand)]
    Repo(RepoCommand),
    /// Tickets: notes with `type: ticket`, each with a git worktree and a
    /// workspace.
    #[command(subcommand)]
    Ticket(TicketCommand),
    /// Who works on which code.
    #[command(subcommand)]
    Code(CodeCommand),
    /// What changed in the vault, newest last.
    Activity {
        /// `7d`, `24h` or a date (`YYYY-MM-DD`). Default: 7 days.
        #[arg(long, default_value = "7d")]
        since: String,
        /// Only paths starting with this.
        #[arg(long)]
        path: Option<String>,
        #[arg(long, default_value_t = 200)]
        limit: usize,
    },
}

#[derive(Subcommand)]
enum ProjectCommand {
    /// Every project.
    List,
    /// Makes a folder a project (making the folder, with an overview note,
    /// if it doesn't exist).
    Create {
        /// The folder, from the vault root.
        folder: String,
    },
    /// A project's folders, code and open tickets.
    Show {
        /// Its id, name or folder.
        project: String,
    },
}

#[derive(Subcommand)]
enum RepoCommand {
    /// Every repo, and where it's checked out here.
    List,
    /// A repo's components (paths, commands, docs) and the projects using each.
    Show { repo: String },
    /// Record where a repo is checked out on this machine (once per machine).
    Locate {
        repo: String,
        /// Its main checkout (any folder in it).
        path: String,
        /// Where its worktrees go. Default: `<checkout>-worktrees` beside it.
        #[arg(long)]
        worktrees: Option<String>,
    },
}

#[derive(Subcommand)]
enum TicketCommand {
    /// Make a ticket: a branch and worktree (then the repo's and components'
    /// setup), a note from the ticket template in its home project's work
    /// folder, and a workspace. Prints the note's path.
    Create {
        /// A tracker key (`INT-123`) or a URL containing one.
        #[arg(long)]
        key: Option<String>,
        #[arg(long)]
        title: Option<String>,
        /// For the branch and worktree names. Default: from the title.
        #[arg(long)]
        slug: Option<String>,
        /// A project id or name; the first is the ticket's home (repeatable).
        #[arg(long = "project")]
        projects: Vec<String>,
        /// What it touches, `repo:component` (repeatable).
        #[arg(long)]
        code: Vec<String>,
        /// Default: the one repo its code or projects use.
        #[arg(long)]
        repo: Option<String>,
        /// Turn this existing note into the ticket, where it is.
        #[arg(long)]
        note: Option<String>,
        /// Adopt this existing worktree instead of making one.
        #[arg(long)]
        adopt: Option<String>,
        /// Just the note and workspace.
        #[arg(long)]
        no_worktree: bool,
        /// Don't run the setup commands.
        #[arg(long)]
        no_setup: bool,
    },
    /// List tickets (active ones by default).
    List {
        #[arg(long)]
        repo: Option<String>,
        #[arg(long)]
        project: Option<String>,
        /// `active` (default), `closed` or `all`.
        #[arg(long)]
        status: Option<String>,
        /// `repo:component`.
        #[arg(long)]
        component: Option<String>,
    },
    /// A ticket's details and its worktree's git state.
    Show { note: String },
    /// Remove the worktree, end its terminals and mark the ticket closed.
    /// Refuses when that would lose uncommitted or unpushed work.
    Close {
        note: String,
        /// Close anyway, discarding uncommitted changes.
        #[arg(long)]
        force: bool,
    },
    /// Bring a closed ticket's worktree back (from the local or remote branch).
    Restore {
        note: String,
        #[arg(long)]
        no_setup: bool,
    },
    /// Worktrees with no ticket note (made outside Groundwork). Adopt one
    /// with `ticket create --adopt <path>`.
    Strays,
}

#[derive(Subcommand)]
enum CodeCommand {
    /// The components, projects and open tickets touching a path: a file or
    /// folder in a checkout or worktree, or `repo:relative/path`.
    Who { path: String },
}

#[derive(Subcommand)]
enum PageCommand {
    /// Print the state a page saved (`groundwork.state`) as JSON, `null` if
    /// none. `--json` adds the page and the file the state is kept in.
    State {
        /// A path or link name: `login-flow.page`, `Demos/sketch.html`.
        page: String,
        /// Replace the state with this JSON instead. `-` reads it from stdin.
        #[arg(long, allow_hyphen_values = true)]
        set: Option<String>,
    },
}

#[derive(Subcommand)]
enum NoteCommand {
    /// Print a note.
    Read { note: String },
    /// Print the vault path a note name or link resolves to.
    Path { note: String },
    /// Properties, tags, headings, links and todos of a note.
    Info { note: String },
    /// Create a note (optionally from a template) and print its path.
    Create {
        /// Vault path, e.g. `Projects/Acme/Kickoff.md` (`.md` is added if missing).
        path: String,
        #[arg(long)]
        template: Option<String>,
        /// Answers to `{{prompt:Label}}`: `--var Label=value`.
        #[arg(long = "var", value_parser = parse_var)]
        vars: Vec<(String, String)>,
        /// What `{{date}}` means (default: the note's own date, or today).
        #[arg(long)]
        date: Option<String>,
        /// The note's text, when not using a template. `-` reads it from
        /// stdin. It may start with `---` (frontmatter).
        #[arg(long, conflicts_with = "template", allow_hyphen_values = true)]
        text: Option<String>,
    },
}

#[derive(Subcommand)]
enum TemplateCommand {
    /// List the templates.
    List,
    /// Render a template (to stdout) as if inserted into a note.
    Render {
        template: String,
        /// The note it's for (sets `{{title}}`, `{{date}}`…). Default: a new note.
        #[arg(long, default_value = "Untitled.md")]
        note: String,
        #[arg(long = "var", value_parser = parse_var)]
        vars: Vec<(String, String)>,
    },
}

#[derive(Subcommand)]
enum TodoCommand {
    /// List todos (open ones by default), most urgent first.
    List(ListArgs),
    /// Add a todo, by default to today's daily note under `## Todos`.
    Add {
        #[arg(allow_hyphen_values = true)]
        text: String,
        /// `fri`, `tomorrow`, `+3d`, `nov 12`, `YYYY-MM-DD`…
        #[arg(long)]
        due: Option<String>,
        /// `p0` (highest) to `p5` (lowest); `p3` is the default.
        #[arg(long)]
        priority: Option<String>,
        /// The note to add it to.
        #[arg(long)]
        note: Option<String>,
    },
    /// Mark a todo done.
    Done { id: String },
    /// Mark a todo cancelled.
    Cancel { id: String },
    /// Open a done or cancelled todo again.
    Reopen { id: String },
    /// Set (or with `none`, clear) a todo's due date.
    Reschedule { id: String, date: String },
    /// Set a todo's priority (`p0`–`p5`).
    Priority { id: String, priority: String },
}

#[derive(Args)]
struct ListArgs {
    /// `overdue`, `today` (and before), `week` (next 7 days and before),
    /// `any` or `none`.
    #[arg(long)]
    due: Option<String>,
    /// `p1` or `p0-p1`: that priority or higher.
    #[arg(long)]
    priority: Option<String>,
    /// Tag on the todo's line or in its note's `tags:` (repeatable).
    #[arg(long)]
    tag: Vec<String>,
    /// Only notes under this path.
    #[arg(long)]
    path: Option<String>,
    /// `open` (default), `done`, `cancelled` or `all`.
    #[arg(long)]
    status: Option<String>,
    /// Only todos created at least this long ago, e.g. `14d`.
    #[arg(long)]
    stale: Option<String>,
    /// Text the todo must contain.
    #[arg(long)]
    text: Option<String>,
}

fn parse_var(s: &str) -> Result<(String, String), String> {
    s.split_once('=')
        .map(|(k, v)| (k.trim().to_string(), v.to_string()))
        .ok_or_else(|| format!("expected Label=value, got {s:?}"))
}

type Fallible<T> = Result<T, String>;

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("groundwork: {err}");
            ExitCode::FAILURE
        }
    }
}

/// The vault to use, and why: `--vault`/`$GROUNDWORK_VAULT`, the vault
/// around the current folder, the default set in the app, or the vault the
/// app opened last.
fn find_vault(explicit: Option<PathBuf>) -> Fallible<(Vault, &'static str)> {
    let open = |path: &Path, source| {
        Vault::open(path)
            .map(|v| (v, source))
            .map_err(|e| format!("{}: {e}", path.display()))
    };
    if let Some(path) = explicit {
        let from_env = std::env::var_os("GROUNDWORK_VAULT").is_some_and(|v| path == Path::new(&v));
        return open(
            &path,
            if from_env {
                "$GROUNDWORK_VAULT"
            } else {
                "--vault"
            },
        );
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    for dir in cwd.ancestors() {
        if dir.join(".obsidian").is_dir() || dir.join(".groundwork").is_dir() {
            return open(dir, "the vault containing the current folder");
        }
    }
    if let Some(path) = default_vault(&data_dir()) {
        if !path.is_dir() {
            return Err(format!(
                "the default vault, {}, no longer exists: choose another with \"Set up Claude Code…\" in Groundwork",
                path.display()
            ));
        }
        return open(&path, "the default vault set in Groundwork");
    }
    let recent = RecentVaults::new(&data_dir()).list();
    let last = recent.first().ok_or(
        "no vault found: pass --vault, set GROUNDWORK_VAULT, run inside a vault, or choose a default vault in Groundwork",
    )?;
    open(Path::new(&last.path), "the vault Groundwork opened last")
}

fn err(e: CoreError) -> String {
    e.to_string()
}

/// A note given as a path (with or without `.md`) or a link name.
fn resolve_note(session: &Session, note: &str) -> Fallible<String> {
    let note = note.trim().trim_start_matches('/');
    let root = session.vault().root();
    for candidate in [note.to_string(), format!("{note}.md")] {
        if root.join(&candidate).is_file() && session.vault().resolve(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    session
        .index()
        .resolve(note, "")
        .ok_or_else(|| format!("no note named {note:?}"))
}

/// A page (`.html` file or `.page` bundle) given as a path or link name.
fn resolve_page(session: &Session, page: &str) -> Fallible<String> {
    let page = page.trim().trim_matches('/');
    let path =
        if session.vault().root().join(page).exists() && session.vault().resolve(page).is_ok() {
            page.to_string()
        } else {
            session
                .index()
                .resolve(page, "")
                .ok_or_else(|| format!("no page named {page:?}"))?
        };
    match pages::page_of(&path) {
        Some(p) if p == path => Ok(path),
        _ => Err(format!(
            "{path} isn't a page (an .html file or a .page folder)"
        )),
    }
}

fn print_json(value: &impl Serialize) -> Fallible<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn date_arg(text: &str) -> Fallible<NaiveDate> {
    parse_natural(text, Local::now().date_naive())
        .ok_or_else(|| format!("not a date: {text:?} (try today, fri, +3d, nov 12, YYYY-MM-DD)"))
}

fn priority_arg(text: &str) -> Fallible<u8> {
    let last = text.rsplit('-').next().unwrap_or(text);
    last.trim()
        .trim_start_matches(['p', 'P'])
        .parse::<u8>()
        .ok()
        .filter(|p| *p <= 5)
        .ok_or_else(|| format!("not a priority: {text:?} (p0–p5)"))
}

fn run(cli: Cli) -> Fallible<()> {
    let (vault, source) = find_vault(cli.vault)?;
    if let Command::Vault = cli.command {
        let path = vault.root().display().to_string();
        if cli.json {
            return print_json(&serde_json::json!({ "path": path, "source": source }));
        }
        println!("{path}\n  (from {source})");
        return Ok(());
    }
    let session = Session::open_for_tool(vault, &data_dir(), ActivitySource::Cli).map_err(err)?;
    let json = cli.json;
    match cli.command {
        Command::Note(cmd) => note(&session, cmd, json),
        Command::Files { path } => {
            let prefix = path.map(|p| format!("{}/", p.trim_matches('/')));
            let files: Vec<_> = session
                .index()
                .summaries()
                .into_iter()
                .filter(|f| f.kind != NodeKind::Folder)
                .filter(|f| {
                    prefix
                        .as_ref()
                        .is_none_or(|p| f.path.starts_with(p.as_str()))
                })
                .collect();
            if json {
                return print_json(&files);
            }
            for f in files {
                match f.kind {
                    NodeKind::Page | NodeKind::PageBundle => println!("{} (page)", f.path),
                    _ => println!("{}", f.path),
                }
            }
            Ok(())
        }
        Command::Links {
            note: Some(note), ..
        } => {
            let path = resolve_note(&session, &note)?;
            let links = session.index().outgoing(&path);
            if json {
                return print_json(&links);
            }
            for l in links {
                match l.resolved {
                    Some(to) => println!("{to}{}", if l.link.embed { " (embed)" } else { "" }),
                    None => println!("{} (missing)", l.link.target),
                }
            }
            Ok(())
        }
        Command::Links { note: None, .. } => {
            #[derive(Serialize)]
            struct Source {
                source: String,
                links: Vec<groundwork_core::index::OutgoingLink>,
            }
            let index = session.index();
            let all: Vec<Source> = index
                .paths()
                .map(|p| Source {
                    source: p.to_string(),
                    links: index.outgoing(p),
                })
                .filter(|s| !s.links.is_empty())
                .collect();
            if json {
                return print_json(&all);
            }
            for s in all {
                for l in s.links {
                    match l.resolved {
                        Some(to) if l.link.embed => println!("{} -> {to} (embed)", s.source),
                        Some(to) => println!("{} -> {to}", s.source),
                        None => println!("{} -> {} (missing)", s.source, l.link.target),
                    }
                }
            }
            Ok(())
        }
        Command::Backlinks { note } => {
            let path = resolve_note(&session, &note)?;
            let backlinks = session.index().backlinks(&path);
            if json {
                return print_json(&backlinks);
            }
            for b in backlinks {
                for l in b.links {
                    println!("{}:{}: {}", b.source, l.line + 1, l.context);
                }
            }
            Ok(())
        }
        Command::Search { query, limit } => {
            let results = search::search(&session.index(), &query.join(" "), limit);
            if json {
                return print_json(&results);
            }
            for r in results {
                if r.lines.is_empty() {
                    println!("{}", r.path);
                }
                for l in r.lines {
                    let text: String = l.segments.iter().map(|s| s.text.as_str()).collect();
                    println!("{}:{}: {}", r.path, l.line + 1, text.trim());
                }
            }
            Ok(())
        }
        Command::Template(TemplateCommand::List) => {
            let templates = session.templates();
            if json {
                return print_json(&templates);
            }
            templates.iter().for_each(|t| println!("{t}"));
            Ok(())
        }
        Command::Template(TemplateCommand::Render {
            template,
            note,
            vars,
        }) => {
            let template = resolve_note(&session, &template)?;
            let rendered = session
                .render_template(&template, &note, vars.into_iter().collect())
                .map_err(err)?;
            if json {
                return print_json(&serde_json::json!({ "text": rendered.text }));
            }
            print!("{}", rendered.text);
            Ok(())
        }
        Command::Page(PageCommand::State { page, set }) => {
            let page = resolve_page(&session, &page)?;
            if let Some(text) = set {
                let text = if text == "-" {
                    let mut stdin = String::new();
                    std::io::stdin()
                        .read_to_string(&mut stdin)
                        .map_err(|e| format!("reading the state from stdin: {e}"))?;
                    stdin
                } else {
                    text
                };
                let state: serde_json::Value = serde_json::from_str(&text)
                    .map_err(|e| format!("the state isn't JSON: {e}"))?;
                session.set_page_state(&page, &state).map_err(err)?;
            }
            let state = session.page_state(&page).map_err(err)?;
            if json {
                return print_json(&serde_json::json!({
                    "page": page,
                    "file": pages::state_path(&page),
                    "state": state,
                }));
            }
            print_json(&state)
        }
        Command::Daily { date } => {
            let (path, _) = session.daily_note(date_arg(&date)?).map_err(err)?;
            if json {
                return print_json(&serde_json::json!({ "path": path }));
            }
            println!("{path}");
            Ok(())
        }
        Command::Todo(cmd) => todo(&session, cmd, json),
        Command::Context { note, cwd } => {
            let note = note.map(|n| resolve_note(&session, &n)).transpose()?;
            let cwd = match (&note, cwd) {
                (Some(_), _) => None,
                (None, Some(c)) => Some(c),
                (None, None) => Some(std::env::current_dir().map_err(|e| e.to_string())?),
            };
            let context = session
                .context(note.as_deref(), cwd.as_deref())
                .map_err(err)?;
            if json {
                return print_json(&context);
            }
            print_context(&context);
            Ok(())
        }
        Command::Project(cmd) => project(&session, cmd, json),
        Command::Repo(cmd) => repo(&session, cmd, json),
        Command::Ticket(cmd) => ticket(&session, cmd, json),
        Command::Code(CodeCommand::Who { path }) => {
            let who = session.code_who(&path).map_err(err)?;
            if json {
                return print_json(&who);
            }
            println!("{}:{}", who.repo, who.path);
            if who.components.is_empty() {
                println!("components: none");
            } else {
                println!("components: {}", who.components.join(", "));
            }
            for p in &who.projects {
                println!("project: {} ({})", p.name, p.folder);
            }
            for t in &who.tickets {
                println!("ticket: {}", ticket_line(t));
            }
            Ok(())
        }
        Command::Vault => unreachable!("handled before opening the vault"),
        Command::Activity { since, path, limit } => {
            activity(session.vault().root(), &since, path, limit, json)
        }
    }
}

fn print_context(c: &Context) {
    if let Some(t) = &c.ticket {
        println!("Ticket: {}", ticket_line(t));
        if let Some(url) = &t.url {
            println!("  {url}");
        }
        if let Some(b) = &t.branch {
            println!("  branch {b}");
        }
    } else if let Some(n) = &c.note {
        println!("Note: {n}");
    }
    for p in &c.projects {
        match &p.overview {
            Some(o) => println!("Project: {} (overview: {o})", p.name),
            None => println!("Project: {} ({})", p.name, p.folder),
        }
    }
    if let Some(r) = &c.repo {
        println!("Repo: {} ({})", r.name, r.id);
        if let Some(d) = &r.description {
            println!("  {d}");
        }
        match (&r.worktree_path, &r.path) {
            (Some(w), _) => println!("  worktree: {w}"),
            (None, Some(p)) => println!("  checkout: {p}"),
            (None, None) => println!(
                "  not located on this machine: groundwork repo locate {} <path>",
                r.id
            ),
        }
        if !r.docs.is_empty() {
            println!("  read first: {}", r.docs.join(", "));
        }
    }
    for comp in &c.components {
        println!(
            "Component: {} ({})",
            comp.id,
            comp.abs_path.as_deref().unwrap_or(&comp.path)
        );
        if let Some(d) = &comp.description {
            println!("  {d}");
        }
        for (name, run) in &comp.commands {
            println!("  {name}: {run}");
        }
        if !comp.docs.is_empty() {
            println!("  read first: {}", comp.docs.join(", "));
        }
    }
    if !c.actions.is_empty() {
        println!("Actions:");
        for a in &c.actions {
            println!("  {} ({}): {}", a.label, a.kind, a.run);
        }
    }
    if !c.related.is_empty() {
        println!("Related notes:");
        for r in &c.related {
            println!("  {r}");
        }
    }
}

fn ticket_line(t: &Ticket) -> String {
    let mut line = match &t.key {
        Some(k) if !t.title.starts_with(k.as_str()) => format!("{k} {}", t.title),
        _ => t.title.clone(),
    };
    if !t.is_active() {
        line.push_str(" [closed]");
    }
    line.push_str(&format!(" · {}", t.path));
    line
}

fn project(session: &Session, cmd: ProjectCommand, json: bool) -> Fallible<()> {
    match cmd {
        ProjectCommand::List => {
            let projects = session.project_list().map_err(err)?;
            if json {
                return print_json(&projects);
            }
            for p in projects {
                println!("{} · {} · {}", p.id, p.name, p.folder);
            }
            Ok(())
        }
        ProjectCommand::Create { folder } => {
            let (project, _) = session.create_project(&folder).map_err(err)?;
            if json {
                return print_json(&project);
            }
            println!("{} · {} · {}", project.id, project.name, project.folder);
            Ok(())
        }
        ProjectCommand::Show { project } => {
            let config = session.config().map_err(err)?;
            let p = config
                .project(&project)
                .ok_or_else(|| format!("no project {project:?}"))?;
            let tickets = session
                .tickets(&TicketFilter {
                    project: Some(p.id.clone()),
                    ..Default::default()
                })
                .map_err(err)?;
            if json {
                return print_json(&serde_json::json!({ "project": p, "tickets": tickets }));
            }
            println!("{} ({})", p.name, p.id);
            println!("  folder: {}", p.folder);
            if let Some(o) = &p.overview {
                println!("  overview: {o}");
            }
            println!("  tickets go in: {}", p.work_folder);
            if !p.code.is_empty() {
                println!("  code: {}", p.code.join(", "));
            }
            for t in &tickets {
                println!("  ticket: {}", ticket_line(t));
            }
            Ok(())
        }
    }
}

fn repo(session: &Session, cmd: RepoCommand, json: bool) -> Fallible<()> {
    match cmd {
        RepoCommand::List => {
            let repos = session.repo_list().map_err(err)?;
            if json {
                return print_json(&repos);
            }
            for r in repos {
                match &r.location {
                    Some(l) => println!("{} · {} · {}", r.id, r.name, l.path),
                    None => println!(
                        "{} · {} · not located (groundwork repo locate {} <path>)",
                        r.id, r.name, r.id
                    ),
                }
            }
            Ok(())
        }
        RepoCommand::Show { repo } => {
            let config = session.config().map_err(err)?;
            let r = config.repo(&repo).map_err(err)?;
            let info = session
                .repo_list()
                .map_err(err)?
                .into_iter()
                .find(|i| i.id == r.id);
            let location = info.as_ref().and_then(|i| i.location.clone());
            if json {
                return print_json(
                    &serde_json::json!({ "repo": r, "location": location, "projects": info.map(|i| i.projects) }),
                );
            }
            println!("{} ({})", r.display_name(), r.id);
            if let Some(d) = &r.description {
                println!("  {d}");
            }
            match &location {
                Some(l) => println!("  checkout: {}\n  worktrees: {}", l.path, l.worktrees),
                None => println!("  not located (groundwork repo locate {} <path>)", r.id),
            }
            println!("  base branch: {}", r.git.base_branch);
            if !r.setup.is_empty() {
                println!("  setup: {}", r.setup.join(" && "));
            }
            if !r.docs.is_empty() {
                println!("  read first: {}", r.docs.join(", "));
            }
            for (name, c) in &r.components {
                let id = format!("{}:{name}", r.id);
                let users: Vec<&str> = config
                    .projects
                    .iter()
                    .filter(|p| p.code.contains(&id) || p.code.contains(&r.id))
                    .map(|p| p.name.as_str())
                    .collect();
                println!("  {name} ({})", c.path);
                if let Some(d) = &c.description {
                    println!("    {d}");
                }
                for (cmd, run) in &c.commands {
                    println!("    {cmd}: {run}");
                }
                if !users.is_empty() {
                    println!("    used by: {}", users.join(", "));
                }
            }
            Ok(())
        }
        RepoCommand::Locate {
            repo,
            path,
            worktrees,
        } => {
            session.config().map_err(err)?.repo(&repo).map_err(err)?;
            let location = session
                .repos()
                .locate(&repo, &path, worktrees.as_deref())
                .map_err(err)?;
            if json {
                return print_json(&location);
            }
            println!(
                "{repo}: {}\n  worktrees: {}",
                location.path, location.worktrees
            );
            Ok(())
        }
    }
}

fn ticket(session: &Session, cmd: TicketCommand, json: bool) -> Fallible<()> {
    match cmd {
        TicketCommand::Create {
            key,
            title,
            slug,
            projects,
            code,
            repo,
            note,
            adopt,
            no_worktree,
            no_setup,
        } => {
            let note = note.map(|n| resolve_note(session, &n)).transpose()?;
            let created = session
                .create_ticket(&NewTicket {
                    key,
                    title,
                    slug,
                    projects,
                    code,
                    repo,
                    note,
                    adopt,
                    no_worktree,
                })
                .map_err(err)?;
            report_created(&created, no_setup, json)
        }
        TicketCommand::List {
            repo,
            project,
            status,
            component,
        } => {
            let tickets = session
                .tickets(&TicketFilter {
                    repo,
                    project,
                    status,
                    component,
                })
                .map_err(err)?;
            if json {
                return print_json(&tickets);
            }
            for t in &tickets {
                println!("{}", ticket_line(t));
            }
            Ok(())
        }
        TicketCommand::Show { note } => {
            let path = resolve_note(session, &note)?;
            let ticket = session.ticket(&path).map_err(err)?;
            let git = session.ticket_git(&path).map_err(err)?;
            if json {
                return print_json(&serde_json::json!({ "ticket": ticket, "git": git }));
            }
            println!("{}", ticket_line(&ticket));
            if let Some(url) = &ticket.url {
                println!("  {url}");
            }
            if !ticket.projects.is_empty() {
                println!("  projects: {}", ticket.projects.join(", "));
            }
            if !ticket.code.is_empty() {
                println!("  code: {}", ticket.code.join(", "));
            }
            if let Some(b) = &ticket.branch {
                println!("  branch: {b}");
            }
            match (&ticket.worktree_path, git.exists) {
                (Some(w), true) => {
                    println!("  worktree: {w}");
                    let mut state = Vec::new();
                    if git.dirty {
                        state.push("uncommitted changes".to_string());
                    }
                    if git.unpushed > 0 {
                        state.push(format!("{} unpushed", git.unpushed));
                    }
                    if !git.on_remote {
                        state.push("not on the remote".into());
                    }
                    if git.behind > 0 {
                        state.push(format!("{} behind its base", git.behind));
                    }
                    if state.is_empty() {
                        state.push("clean and pushed".into());
                    }
                    println!("  git: {}", state.join(", "));
                }
                (Some(w), false) => println!("  worktree: {w} (not on disk)"),
                (None, _) if ticket.repo.is_some() && ticket.worktree.is_some() => {
                    println!("  repo not located on this machine")
                }
                _ => {}
            }
            Ok(())
        }
        TicketCommand::Close { note, force } => {
            let path = resolve_note(session, &note)?;
            let worktree = session.ticket(&path).map_err(err)?.worktree_path;
            let (ticket, _, _) = session.close_ticket(&path, force).map_err(|e| {
                let msg = err(e);
                if msg.starts_with("Not closed") {
                    format!("{msg} Use --force to close anyway.")
                } else {
                    msg
                }
            })?;
            let ended = worktree.map_or(0, |w| end_terminals_in(Path::new(&w)));
            if json {
                return print_json(
                    &serde_json::json!({ "ticket": ticket, "terminalsEnded": ended }),
                );
            }
            println!("closed {}", ticket.path);
            if ended > 0 {
                println!(
                    "  ended {ended} terminal{}",
                    if ended == 1 { "" } else { "s" }
                );
            }
            Ok(())
        }
        TicketCommand::Restore { note, no_setup } => {
            let path = resolve_note(session, &note)?;
            let created = session.restore_ticket(&path).map_err(err)?;
            report_created(&created, no_setup, json)
        }
        TicketCommand::Strays => {
            let strays = session.stray_worktrees().map_err(err)?;
            if json {
                return print_json(&strays);
            }
            for s in strays {
                println!(
                    "{} · {} · {}",
                    s.repo,
                    s.path,
                    s.branch.as_deref().unwrap_or("(detached)")
                );
            }
            Ok(())
        }
    }
}

/// Prints a new (or restored) ticket, then runs its setup unless told not to.
fn report_created(created: &CreatedTicket, no_setup: bool, json: bool) -> Fallible<()> {
    let t = &created.ticket;
    if json {
        print_json(created)?;
    } else {
        println!("{}", t.path);
        if let Some(w) = &t.worktree_path {
            println!("  worktree: {w}");
        }
        if let Some(b) = &t.branch {
            println!("  branch: {b}");
        }
    }
    if no_setup || created.setup.is_empty() {
        return Ok(());
    }
    for step in &created.setup {
        // Setup output goes to stderr, so --json output stays parseable.
        eprintln!("$ {}", step.command);
        let status = std::process::Command::new("/bin/sh")
            .args(["-c", &step.command])
            .current_dir(&step.cwd)
            .stdout(std::process::Stdio::from(std::io::stderr()))
            .status()
            .map_err(|e| format!("running setup: {e}"))?;
        if !status.success() {
            return Err(format!(
                "setup failed at `{}` (in {}); the ticket was made, finish setup by hand",
                step.command, step.cwd
            ));
        }
    }
    Ok(())
}

/// Ends terminals (in the Groundwork terminal daemon) working in `dir`.
fn end_terminals_in(dir: &Path) -> usize {
    use groundwork_terminal_daemon::client::Client;
    use groundwork_terminal_daemon::protocol::{Request, SessionInfo};
    let socket = data_dir().join("groundworkd.sock");
    if !socket.exists() {
        return 0;
    }
    let Ok(client) = Client::connect(&socket, |_| {}, || {}) else {
        return 0;
    };
    let Ok(sessions) = client.call::<Vec<SessionInfo>>(Request::List) else {
        return 0;
    };
    sessions
        .into_iter()
        .filter(|s| s.cwd.starts_with(dir))
        .filter(|s| {
            client
                .call::<()>(Request::Kill { id: s.id.clone() })
                .is_ok()
        })
        .count()
}

fn note(session: &Session, cmd: NoteCommand, json: bool) -> Fallible<()> {
    match cmd {
        NoteCommand::Read { note } => {
            let path = resolve_note(session, &note)?;
            let text = std::fs::read_to_string(session.vault().root().join(&path))
                .map_err(|e| e.to_string())?;
            if json {
                return print_json(&serde_json::json!({ "path": path, "text": text }));
            }
            print!("{text}");
            Ok(())
        }
        NoteCommand::Path { note } => {
            let path = resolve_note(session, &note)?;
            if json {
                return print_json(&serde_json::json!({ "path": path }));
            }
            println!("{path}");
            Ok(())
        }
        NoteCommand::Info { note } => {
            let path = resolve_note(session, &note)?;
            let index = session.index();
            let parsed = index.note(&path).ok_or("not a note")?;
            let backlinks: usize = index.backlinks(&path).iter().map(|b| b.links.len()).sum();
            let todos: Vec<Todo> = session
                .todos(&TodoFilter {
                    status: Some(StatusFilter::All),
                    path: Some(path.clone()),
                    ..Default::default()
                })
                .into_iter()
                .filter(|t| t.path == path)
                .collect();
            let info = serde_json::json!({
                "path": path,
                "properties": parsed.frontmatter,
                "tags": parsed.tags,
                "aliases": parsed.aliases,
                "headings": parsed.headings.iter().map(|h| &h.text).collect::<Vec<_>>(),
                "links": index.outgoing(&path).iter().map(|l| l.resolved.clone().unwrap_or_else(|| l.link.target.clone())).collect::<Vec<_>>(),
                "backlinks": backlinks,
                "todos": todos,
            });
            if json {
                return print_json(&info);
            }
            println!("path: {path}");
            if let Some(props) = &parsed.frontmatter {
                println!("properties: {props}");
            }
            if !parsed.tags.is_empty() {
                println!("tags: {}", parsed.tags.join(", "));
            }
            if !parsed.aliases.is_empty() {
                println!("aliases: {}", parsed.aliases.join(", "));
            }
            println!("headings: {}", parsed.headings.len());
            println!("links out: {}, backlinks: {backlinks}", parsed.links.len());
            let open = todos.iter().filter(|t| t.is_open()).count();
            println!("todos: {open} open of {}", todos.len());
            Ok(())
        }
        NoteCommand::Create {
            path,
            template,
            vars,
            date,
            text,
        } => {
            let path = if path.ends_with(".md") || path.ends_with(".html") {
                path
            } else {
                format!("{path}.md")
            };
            match template {
                Some(t) => {
                    let template = resolve_note(session, &t)?;
                    let date = date.as_deref().map(date_arg).transpose()?;
                    let answers: HashMap<_, _> = vars.into_iter().collect();
                    let missing: Vec<_> = session
                        .template_prompts(&template)
                        .map_err(err)?
                        .into_iter()
                        .filter(|p| !answers.contains_key(p))
                        .collect();
                    if !missing.is_empty() {
                        return Err(format!(
                            "the template asks for {}; pass --var Label=value for each",
                            missing.join(", ")
                        ));
                    }
                    session
                        .create_from_template(&template, &path, date, answers)
                        .map_err(err)?;
                }
                None => {
                    let text = match text.as_deref() {
                        Some("-") => {
                            let mut stdin = String::new();
                            std::io::stdin()
                                .read_to_string(&mut stdin)
                                .map_err(|e| format!("reading the note from stdin: {e}"))?;
                            Some(stdin)
                        }
                        _ => text,
                    };
                    let text = match text {
                        Some(t) if path.ends_with(".md") => Some(with_created_property(&t)),
                        other => other,
                    };
                    session.create_file(&path, text.as_deref()).map_err(err)?;
                }
            }
            if json {
                return print_json(&serde_json::json!({ "path": path }));
            }
            println!("{path}");
            Ok(())
        }
    }
}

fn todo_line(t: &Todo) -> String {
    let mark = match t.task.status {
        groundwork_core::parse::TaskStatus::Done => "x",
        groundwork_core::parse::TaskStatus::Cancelled => "-",
        _ => " ",
    };
    let mut meta = Vec::new();
    if t.task.priority != 3 {
        meta.push(format!("p{}", t.task.priority));
    }
    if let Some(due) = &t.task.due {
        meta.push(format!("due {due}"));
    }
    if let Some(created) = &t.task.created {
        meta.push(format!("created {created}"));
    }
    let meta = if meta.is_empty() {
        String::new()
    } else {
        format!("  ({})", meta.join(", "))
    };
    format!("[{mark}] {}{meta}\n    {}", t.task.text, t.id)
}

fn todo(session: &Session, cmd: TodoCommand, json: bool) -> Fallible<()> {
    let change = |id: &str, change: TaskChange| -> Fallible<()> {
        session.update_task(id, &change).map_err(err)?;
        if json {
            return print_json(&serde_json::json!({ "id": id, "ok": true }));
        }
        Ok(())
    };
    match cmd {
        TodoCommand::List(args) => {
            let filter = TodoFilter {
                status: args
                    .status
                    .as_deref()
                    .map(|s| match s {
                        "open" => Ok(StatusFilter::Open),
                        "done" => Ok(StatusFilter::Done),
                        "cancelled" => Ok(StatusFilter::Cancelled),
                        "all" => Ok(StatusFilter::All),
                        other => Err(format!("unknown status {other:?}")),
                    })
                    .transpose()?,
                due: args
                    .due
                    .as_deref()
                    .map(|d| match d {
                        "overdue" => Ok(DueFilter::Overdue),
                        "today" => Ok(DueFilter::Today),
                        "week" => Ok(DueFilter::Week),
                        "any" => Ok(DueFilter::Any),
                        "none" => Ok(DueFilter::None),
                        other => Err(format!("unknown --due {other:?}")),
                    })
                    .transpose()?,
                max_priority: args.priority.as_deref().map(priority_arg).transpose()?,
                tags: args.tag,
                path: args.path,
                text: args.text,
                stale_days: args
                    .stale
                    .as_deref()
                    .map(|s| {
                        s.trim_end_matches('d')
                            .parse::<u32>()
                            .map_err(|_| format!("--stale takes days, e.g. 14d, not {s:?}"))
                    })
                    .transpose()?,
            };
            let todos = session.todos(&filter);
            if json {
                return print_json(&todos);
            }
            todos.iter().for_each(|t| println!("{}", todo_line(t)));
            Ok(())
        }
        TodoCommand::Add {
            text,
            due,
            priority,
            note,
        } => {
            let due = due.as_deref().map(date_arg).transpose()?;
            let priority = priority
                .as_deref()
                .map(priority_arg)
                .transpose()?
                .unwrap_or(3);
            let note = note.map(|n| resolve_note(session, &n)).transpose()?;
            let (id, _) = session
                .add_task(note.as_deref(), &text, due, priority)
                .map_err(err)?;
            if json {
                return print_json(&serde_json::json!({ "id": id }));
            }
            println!("{id}");
            Ok(())
        }
        TodoCommand::Done { id } => change(&id, TaskChange::Done),
        TodoCommand::Cancel { id } => change(&id, TaskChange::Cancel),
        TodoCommand::Reopen { id } => change(&id, TaskChange::Reopen),
        TodoCommand::Reschedule { id, date } => {
            let date = match date.as_str() {
                "none" | "" => None,
                d => Some(date_arg(d)?.to_string()),
            };
            change(&id, TaskChange::Due { date })
        }
        TodoCommand::Priority { id, priority } => change(
            &id,
            TaskChange::Priority {
                priority: priority_arg(&priority)?,
            },
        ),
    }
}

fn activity(
    root: &Path,
    since: &str,
    path: Option<String>,
    limit: usize,
    json: bool,
) -> Fallible<()> {
    let now = Local::now();
    let cutoff = if let Some(days) = since.strip_suffix('d').and_then(|n| n.parse::<i64>().ok()) {
        now - Duration::days(days)
    } else if let Some(hours) = since.strip_suffix('h').and_then(|n| n.parse::<i64>().ok()) {
        now - Duration::hours(hours)
    } else {
        let date = date_arg(since)?;
        date.and_hms_opt(0, 0, 0)
            .and_then(|d| d.and_local_timezone(Local).single())
            .ok_or("bad --since date")?
    };
    let mut events: Vec<_> = read_events(root)
        .into_iter()
        .filter(|e| {
            DateTime::parse_from_rfc3339(&e.ts).is_ok_and(|t| t >= cutoff)
                && path.as_ref().is_none_or(|p| e.path.starts_with(p.as_str()))
        })
        .collect();
    let skip = events.len().saturating_sub(limit);
    events.drain(..skip);
    if json {
        return print_json(&events);
    }
    for e in events {
        let kind = serde_json::to_value(e.kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        let source = serde_json::to_value(e.source)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        let detail = match (&e.task, &e.from) {
            (Some(task), _) => format!("  {task}"),
            (None, Some(from)) => format!("  (from {from})"),
            _ => String::new(),
        };
        println!("{}  {kind:<16} {source:<8} {}{detail}", e.ts, e.path);
    }
    Ok(())
}
