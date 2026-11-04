//! Tickets: notes with `type: ticket` frontmatter, each with (usually) a git
//! worktree in its repo's worktree folder and a workspace whose terminals
//! open there. Also project membership, `context` for agents, `code who`,
//! and the actions available for a note. See PLAN §4.3–4.7 and §5.6.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::config::{ActionDef, Config, Project, Repo, slugify};
use crate::frontmatter::{self, Prop};
use crate::git::{self, GitState};
use crate::parse::LinkKind;
use crate::session::FileChange;
use crate::workspaces::Workspace;
use crate::{CoreError, Result, Session};

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Ticket {
    pub path: String,
    /// The note's name.
    pub title: String,
    pub key: Option<String>,
    /// The tracker's page for it.
    pub url: Option<String>,
    /// `active` or `closed`.
    pub status: String,
    pub closed: Option<String>,
    /// Project ids; the first is its home.
    pub projects: Vec<String>,
    /// What it touches: `repo` or `repo:component`.
    pub code: Vec<String>,
    pub repo: Option<String>,
    /// The worktree's folder name.
    pub worktree: Option<String>,
    pub branch: Option<String>,
    pub workspace: Option<String>,
    /// Where the worktree is (or would be) on this machine, once the repo is located.
    pub worktree_path: Option<String>,
}

impl Ticket {
    pub fn is_active(&self) -> bool {
        self.status != "closed"
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct TicketFilter {
    #[ts(optional)]
    pub repo: Option<String>,
    #[ts(optional)]
    pub project: Option<String>,
    /// `active` (the default), `closed` or `all`.
    #[ts(optional)]
    pub status: Option<String>,
    /// `repo:component`.
    #[ts(optional)]
    pub component: Option<String>,
}

/// What a new ticket is. Everything is optional, but it needs a key, a title
/// or a slug to be named.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct NewTicket {
    /// A tracker key, or a URL with one in it.
    #[ts(optional)]
    pub key: Option<String>,
    #[ts(optional)]
    pub title: Option<String>,
    /// For the branch and worktree names; from the title by default.
    #[ts(optional)]
    pub slug: Option<String>,
    /// Project ids or names; the first is its home.
    #[ts(optional, as = "Option<Vec<String>>")]
    pub projects: Vec<String>,
    #[ts(optional, as = "Option<Vec<String>>")]
    pub code: Vec<String>,
    /// From `code` or the projects' code when they use one repo.
    #[ts(optional)]
    pub repo: Option<String>,
    /// An existing note to turn into the ticket ("Add worktree").
    #[ts(optional)]
    pub note: Option<String>,
    /// An existing worktree (absolute) to adopt instead of making one.
    #[ts(optional)]
    pub adopt: Option<String>,
    /// Make the note without a worktree.
    #[ts(optional, as = "Option<bool>")]
    pub no_worktree: bool,
}

/// A command to run in a new worktree (repo and component setup).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SetupStep {
    pub cwd: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreatedTicket {
    pub ticket: Ticket,
    pub workspace: Option<Workspace>,
    /// Setup for the new worktree, not yet run: the app runs it in the
    /// workspace's first terminal, the CLI in its own output.
    pub setup: Vec<SetupStep>,
    /// Byte offset of the template's `{{cursor}}`, for a new note.
    pub cursor: Option<usize>,
    #[serde(skip)]
    #[ts(skip)]
    pub changes: Vec<FileChange>,
}

/// A worktree with no ticket note, made outside Groundwork.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StrayWorktree {
    pub repo: String,
    pub path: String,
    pub branch: Option<String>,
    /// A tracker key in its branch or folder name.
    pub key: Option<String>,
}

/// A project, briefly.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectRef {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub overview: Option<String>,
}

impl From<&Project> for ProjectRef {
    fn from(p: &Project) -> Self {
        Self {
            id: p.id.clone(),
            name: p.name.clone(),
            folder: p.folder.clone(),
            overview: p.overview.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RepoContext {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub base_branch: String,
    /// The main checkout, once located.
    pub path: Option<String>,
    /// The ticket's worktree, when there is one on disk.
    pub worktree_path: Option<String>,
    /// Where to start reading, relative to the repo.
    pub docs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ComponentContext {
    /// `repo:component`.
    pub id: String,
    /// Relative to the repo.
    pub path: String,
    /// In the worktree (or the main checkout), when the repo is located.
    pub abs_path: Option<String>,
    pub description: Option<String>,
    pub commands: BTreeMap<String, String>,
    pub docs: Vec<String>,
}

/// An action ready to run here, with its variables filled in.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Action {
    pub id: String,
    pub label: String,
    /// `shell`, `terminal` or `url`.
    pub kind: String,
    pub run: String,
    /// Absolute.
    pub cwd: String,
    /// Where it's defined: `built-in`, `vault`, `project:<id>`, `repo:<id>`
    /// or `component:<repo>:<component>`.
    pub source: String,
}

/// Everything an agent (or the app) needs to know about a place: a note, or
/// a folder in a worktree, a checkout or the vault.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Context {
    /// The note it's about, if any.
    pub note: Option<String>,
    pub ticket: Option<Ticket>,
    pub projects: Vec<ProjectRef>,
    pub repo: Option<RepoContext>,
    pub components: Vec<ComponentContext>,
    pub actions: Vec<Action>,
    /// Notes worth reading: the ticket's links, the projects' overviews and
    /// their most recently changed notes.
    pub related: Vec<String>,
}

/// Who works on a path in a repo.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CodeOwners {
    pub repo: String,
    /// Relative to the repo.
    pub path: String,
    /// `repo:component` ids covering the path.
    pub components: Vec<String>,
    pub projects: Vec<ProjectRef>,
    pub tickets: Vec<Ticket>,
}

/// A repo, for lists.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RepoInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub home_project: Option<String>,
    /// Component names.
    pub components: Vec<String>,
    /// Where it is on this machine, once located.
    pub location: Option<crate::repos::RepoLocation>,
    /// Projects whose code uses it.
    pub projects: Vec<String>,
}

/// A project, for lists.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub overview: Option<String>,
    pub work_folder: String,
    pub code: Vec<String>,
}

/// How many recently changed project notes `context` lists.
const RECENT_NOTES: usize = 5;

fn fm_str(fm: Option<&Value>, key: &str) -> Option<String> {
    match fm?.get(key)? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn fm_list(fm: Option<&Value>, key: &str) -> Vec<String> {
    match fm.and_then(|f| f.get(key)) {
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.trim().to_string()],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn file_stem(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name)
}

/// Fills in `{{key}}`, `{{slug}}` and `{{title}}`. Without a key, `{{key}}`
/// goes along with the separator after (or before) it.
fn name_format(format: &str, key: Option<&str>, slug: &str, title: &str) -> String {
    let mut out = format.to_string();
    if key.is_none() {
        for (from, to) in [
            ("{{key}}-", ""),
            ("{{key}}_", ""),
            ("{{key}}/", ""),
            ("{{key}} ", ""),
            ("-{{key}}", ""),
            ("_{{key}}", ""),
            (" {{key}}", ""),
        ] {
            out = out.replace(from, to);
        }
    }
    let out = out
        .replace("{{key}}", key.unwrap_or(""))
        .replace("{{slug}}", slug)
        .replace("{{title}}", title);
    out.trim_matches(|c: char| c == '-' || c == '_' || c.is_whitespace())
        .to_string()
}

/// A note name without characters file systems or links object to.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' | '[' | ']' => ' ',
            c => c,
        })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// "fix-login" → "Fix login".
fn title_from_slug(slug: &str) -> String {
    let words = slug.replace(['-', '_'], " ");
    let mut chars = words.trim().chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Fills `{{name}}` variables; `None` if one this context can't fill is left.
fn expand(text: &str, vars: &HashMap<String, String>) -> Option<String> {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let Some(len) = rest[start..].find("}}") else {
            break;
        };
        let name = rest[start + 2..start + len].trim();
        out.push_str(&rest[..start]);
        match vars.get(name) {
            Some(value) => out.push_str(value),
            None if name.contains('.') => return None,
            None => out.push_str(&rest[start..start + len + 2]),
        }
        rest = &rest[start + len + 2..];
    }
    out.push_str(rest);
    Some(out)
}

impl Session {
    pub fn config(&self) -> Result<Config> {
        Config::load(self.vault().root())
    }

    pub fn repo_list(&self) -> Result<Vec<RepoInfo>> {
        let config = self.config()?;
        let locations = self.repos().all();
        Ok(config
            .repos
            .values()
            .map(|r| RepoInfo {
                id: r.id.clone(),
                name: r.display_name().to_string(),
                description: r.description.clone(),
                home_project: r.home_project.clone(),
                components: r.components.keys().cloned().collect(),
                location: locations.get(&r.id).cloned(),
                projects: config
                    .projects
                    .iter()
                    .filter(|p| {
                        p.code
                            .iter()
                            .any(|c| c.split(':').next() == Some(r.id.as_str()))
                    })
                    .map(|p| p.id.clone())
                    .collect(),
            })
            .collect())
    }

    pub fn project_list(&self) -> Result<Vec<ProjectInfo>> {
        Ok(self
            .config()?
            .projects
            .into_iter()
            .map(|p| ProjectInfo {
                id: p.id,
                name: p.name,
                folder: p.folder,
                overview: p.overview,
                work_folder: p.work_folder,
                code: p.code,
            })
            .collect())
    }

    /// The projects a note belongs to: those linked in its `projects:`
    /// frontmatter (by overview note, id or name), then the project folder
    /// it's in.
    pub fn note_projects(&self, config: &Config, path: &str) -> Vec<String> {
        let index = self.index();
        let fm = index.note(path).and_then(|n| n.frontmatter.as_ref());
        let mut ids: Vec<String> = Vec::new();
        for item in fm_list(fm, "projects") {
            let inner = item
                .strip_prefix("[[")
                .and_then(|s| s.strip_suffix("]]"))
                .map(|s| s.split(['|', '#']).next().unwrap_or(s));
            let project = match inner {
                Some(target) => index.resolve(target, path).and_then(|resolved| {
                    config
                        .projects
                        .iter()
                        .find(|p| p.overview.as_deref() == Some(resolved.as_str()))
                        .or_else(|| config.project(file_stem(&resolved)))
                }),
                None => config.project(&item),
            };
            if let Some(p) = project
                && !ids.contains(&p.id)
            {
                ids.push(p.id.clone());
            }
        }
        if let Some(p) = config.project_of_folder(path)
            && !ids.contains(&p.id)
        {
            ids.push(p.id.clone());
        }
        ids
    }

    fn ticket_of(&self, config: &Config, path: &str) -> Option<Ticket> {
        let fm = {
            let index = self.index();
            let fm = index.note(path)?.frontmatter.clone()?;
            if fm.get("type").and_then(Value::as_str) != Some("ticket") {
                return None;
            }
            fm
        };
        let fm = Some(&fm);
        let key = fm_str(fm, "ticket");
        let url = fm_str(fm, "jira")
            .or_else(|| fm_str(fm, "url"))
            .or_else(|| {
                let key = key.as_deref()?;
                Some(config.tracker_for(key)?.url_for(key))
            });
        let repo = fm_str(fm, "repo");
        let worktree = fm_str(fm, "worktree");
        let worktree_path = match (&repo, &worktree) {
            (Some(r), Some(w)) => self
                .repos()
                .get(r)
                .map(|l| l.worktree(w).display().to_string()),
            _ => None,
        };
        Some(Ticket {
            path: path.to_string(),
            title: file_stem(path).to_string(),
            key,
            url,
            status: fm_str(fm, "status").unwrap_or_else(|| "active".into()),
            closed: fm_str(fm, "closed"),
            projects: self.note_projects(config, path),
            code: fm_list(fm, "code"),
            repo,
            worktree,
            branch: fm_str(fm, "branch"),
            workspace: fm_str(fm, "workspace"),
            worktree_path,
        })
    }

    /// The ticket note at `path`.
    pub fn ticket(&self, path: &str) -> Result<Ticket> {
        self.ticket_of(&self.config()?, path)
            .ok_or_else(|| CoreError::NotFound(format!("{path} isn't a ticket")))
    }

    /// Ticket notes matching `filter`, by key then title.
    pub fn tickets(&self, filter: &TicketFilter) -> Result<Vec<Ticket>> {
        let config = self.config()?;
        let paths: Vec<String> = self
            .index()
            .notes()
            .filter(|(_, n)| {
                n.frontmatter
                    .as_ref()
                    .and_then(|f| f.get("type"))
                    .and_then(Value::as_str)
                    == Some("ticket")
            })
            .map(|(p, _)| p.to_string())
            .collect();
        let project = match &filter.project {
            Some(p) => Some(
                config
                    .project(p)
                    .ok_or_else(|| CoreError::NotFound(format!("no project {p:?}")))?
                    .id
                    .clone(),
            ),
            None => None,
        };
        let mut tickets: Vec<Ticket> = paths
            .iter()
            .filter_map(|p| self.ticket_of(&config, p))
            .filter(|t| match filter.status.as_deref().unwrap_or("active") {
                "all" => true,
                "closed" => !t.is_active(),
                _ => t.is_active(),
            })
            .filter(|t| {
                filter
                    .repo
                    .as_ref()
                    .is_none_or(|r| t.repo.as_ref() == Some(r))
            })
            .filter(|t| project.as_ref().is_none_or(|p| t.projects.contains(p)))
            .filter(|t| filter.component.as_ref().is_none_or(|c| t.code.contains(c)))
            .collect();
        tickets.sort_by(|a, b| {
            (a.key.is_none(), &a.key, &a.title).cmp(&(b.key.is_none(), &b.key, &b.title))
        });
        Ok(tickets)
    }

    /// The ticket's worktree's git state (all defaults when there's none).
    pub fn ticket_git(&self, path: &str) -> Result<GitState> {
        let config = self.config()?;
        let ticket = self.ticket(path)?;
        let (Some(repo), Some(wt)) = (&ticket.repo, &ticket.worktree_path) else {
            return Ok(GitState::default());
        };
        let base = config.repo(repo).map(|r| r.git.base_branch.clone())?;
        let mut state = git::state(Path::new(wt), &base);
        if state.exists && state.branch.is_none() {
            state.branch = ticket.branch;
        }
        Ok(state)
    }

    /// Creates a ticket: its worktree (unless adopting one or there's no
    /// repo), its note (or turns an existing note into it), and a workspace.
    pub fn create_ticket(&self, new: &NewTicket) -> Result<CreatedTicket> {
        let config = self.config()?;
        fn given(s: &Option<String>) -> Option<&str> {
            s.as_deref().map(str::trim).filter(|s| !s.is_empty())
        }

        // The key and its tracker.
        let (key, tracker) = match given(&new.key) {
            Some(text) => match config.find_key(text) {
                Some((key, tracker)) => (Some(key), Some(tracker)),
                None if text.contains("://") => {
                    return Err(CoreError::InvalidPath(format!(
                        "no tracker in .groundwork/config.yml matches {text}"
                    )));
                }
                None => (Some(text.to_string()), None),
            },
            None => (None, None),
        };
        let url = key.as_deref().and_then(|k| tracker.map(|t| t.url_for(k)));

        // Projects, code and repo, each filling in from the others.
        let mut projects: Vec<&Project> = Vec::new();
        for name in &new.projects {
            let project = config
                .project(name)
                .ok_or_else(|| CoreError::NotFound(format!("no project {name:?}")))?;
            if !projects.iter().any(|p| p.id == project.id) {
                projects.push(project);
            }
        }
        if projects.is_empty()
            && let Some(note) = given(&new.note)
        {
            for id in self.note_projects(&config, note) {
                projects.extend(config.project(&id));
            }
        }
        for code in &new.code {
            config.component(code)?;
        }
        let repo_of = |code: &String| code.split(':').next().unwrap_or(code).to_string();
        let repo_id = match given(&new.repo) {
            Some(r) => Some(config.repo(r)?.id.clone()),
            None => {
                let mut repos: Vec<String> = new.code.iter().map(repo_of).collect();
                if repos.is_empty() {
                    repos = projects
                        .iter()
                        .flat_map(|p| p.code.iter().map(repo_of))
                        .collect();
                }
                repos.sort();
                repos.dedup();
                match repos.as_slice() {
                    [one] => Some(one.clone()),
                    [] => None,
                    _ => {
                        return Err(CoreError::InvalidPath(format!(
                            "which repo? the ticket could use {}",
                            repos.join(" or ")
                        )));
                    }
                }
            }
        };
        let repo: Option<&Repo> = repo_id.as_deref().map(|r| config.repo(r)).transpose()?;
        if projects.is_empty()
            && let Some(home) = repo.and_then(|r| r.home_project.as_deref())
        {
            projects.extend(config.project(home));
        }
        let home = projects.first().copied();

        // Names.
        let existing_note = given(&new.note).map(str::to_string);
        if let Some(note) = &existing_note
            && self.ticket_of(&config, note).is_some()
        {
            return Err(CoreError::Conflict(format!("{note} is already a ticket")));
        }
        let adopt = given(&new.adopt).map(crate::workspaces::expand_home);
        let mut title = given(&new.title).map(str::to_string);
        let mut slug = given(&new.slug).map(slugify);
        if let Some(path) = &adopt
            && slug.is_none()
        {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
            let name = name.unwrap_or_default();
            let rest = match &key {
                Some(k) => name.replacen(k.as_str(), "", 1),
                None => name,
            };
            slug = Some(slugify(&rest)).filter(|s| !s.is_empty());
        }
        if title.is_none() {
            title = match (&existing_note, &slug) {
                (Some(note), _) => {
                    let stem = file_stem(note);
                    let stem = key
                        .as_deref()
                        .map_or(stem, |k| stem.strip_prefix(k).map_or(stem, str::trim_start));
                    Some(stem.to_string())
                }
                (None, Some(s)) => Some(title_from_slug(s)),
                (None, None) => None,
            };
        }
        let title = title.unwrap_or_default();
        let slug = slug.unwrap_or_else(|| slugify(&title));
        if key.is_none() && slug.is_empty() {
            return Err(CoreError::InvalidPath(
                "give the ticket a key, a title or a slug".into(),
            ));
        }

        // The worktree.
        let mut setup = Vec::new();
        let mut worktree: Option<(String, PathBuf, String)> = None;
        if let Some(repo) = repo.filter(|_| !new.no_worktree) {
            let location = self.repos().require(&repo.id)?;
            let branch_name = name_format(&repo.git.branch_format, key.as_deref(), &slug, &title);
            let wt_name = name_format(&repo.git.worktree_name, key.as_deref(), &slug, &title);
            match &adopt {
                Some(path) => {
                    let path = std::fs::canonicalize(path).map_err(|_| {
                        CoreError::NotFound(format!("no worktree at {}", path.display()))
                    })?;
                    let found = git::worktrees(location.path())?
                        .into_iter()
                        .find(|w| std::fs::canonicalize(&w.path).ok().as_ref() == Some(&path))
                        .ok_or_else(|| {
                            CoreError::NotFound(format!(
                                "{} isn't a worktree of {}",
                                path.display(),
                                repo.id
                            ))
                        })?;
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    if Path::new(&location.worktrees).join(&name) != path
                        && std::fs::canonicalize(&location.worktrees).ok()
                            != path.parent().map(Path::to_path_buf)
                    {
                        return Err(CoreError::InvalidPath(format!(
                            "{} isn't in the repo's worktree folder, {}",
                            path.display(),
                            location.worktrees
                        )));
                    }
                    worktree = Some((name, path, found.branch.unwrap_or(branch_name)));
                }
                None => {
                    let path = location.worktree(&wt_name);
                    git::add_worktree(location.path(), &path, &branch_name, &repo.git.base_branch)?;
                    setup = setup_steps(&config, repo, &new.code, &location.path, &path);
                    worktree = Some((wt_name, path, branch_name));
                }
            }
        }

        // The note.
        let mut changes = Vec::new();
        let mut cursor = None;
        let path = match &existing_note {
            Some(note) => {
                self.vault().resolve(note)?;
                note.clone()
            }
            None => {
                let folder = home.map_or(config.work_folder.as_str(), |p| p.work_folder.as_str());
                let name = match tracker {
                    Some(t) if !t.note_name.is_empty() => {
                        name_format(&t.note_name, key.as_deref(), &slug, &title)
                    }
                    _ => name_format("{{key}} {{title}}", key.as_deref(), &slug, &title),
                };
                let path = self.available_path(folder, &safe_name(&name), ".md");
                let template = home
                    .and_then(|p| p.tickets.template.clone())
                    .or_else(|| tracker.and_then(|t| t.template.clone()))
                    .unwrap_or_else(|| "Templates/Ticket.md".into());
                let vars: HashMap<String, String> = [
                    ("ticket.key", key.clone().unwrap_or_default()),
                    ("ticket.title", title.clone()),
                    ("ticket.slug", slug.clone()),
                    ("jira.url", url.clone().unwrap_or_default()),
                    (
                        "project.name",
                        home.map(|p| p.name.clone()).unwrap_or_default(),
                    ),
                    ("repo.id", repo_id.clone().unwrap_or_default()),
                ]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect();
                if self.vault().resolve(&template)?.is_file() {
                    let (c, ch) = self.create_from_template_with(&template, &path, vars)?;
                    cursor = c;
                    changes.extend(ch);
                } else {
                    let text = format!("# {}\n\n", file_stem(&path));
                    changes.extend(
                        self.create_file(
                            &path,
                            Some(&crate::session::with_created_property(&text)),
                        )?,
                    );
                }
                path
            }
        };

        // The workspace.
        let cwd = match &worktree {
            Some((_, p, _)) => p.display().to_string(),
            None => self.default_folder(home.map(|p| p.folder.as_str()).unwrap_or(&path)),
        };
        let workspace = self
            .workspaces()
            .create_for(file_stem(&path), &cwd, Some(&path))?;

        // The frontmatter.
        let project_links: Vec<String> = projects
            .iter()
            .map(|p| self.project_link(p, &path))
            .collect();
        let mut props: Vec<(&str, Option<Prop>)> = vec![("type", Some(Prop::text("ticket")))];
        if let Some(k) = &key {
            props.push(("ticket", Some(Prop::text(k))));
        }
        if let Some(u) = &url {
            props.push(("jira", Some(Prop::text(u))));
        }
        if !project_links.is_empty() {
            props.push(("projects", Some(Prop::List(project_links))));
        }
        if !new.code.is_empty() {
            props.push(("code", Some(Prop::List(new.code.clone()))));
        }
        if let Some(r) = &repo_id {
            props.push(("repo", Some(Prop::text(r))));
        }
        if let Some((name, _, branch)) = &worktree {
            props.push(("worktree", Some(Prop::text(name))));
            props.push(("branch", Some(Prop::text(branch))));
        }
        props.push(("status", Some(Prop::text("active"))));
        props.push(("workspace", Some(Prop::text(&workspace.id))));
        changes.extend(self.set_properties(&path, &props)?);

        let ticket = self.ticket(&path)?;
        Ok(CreatedTicket {
            ticket,
            workspace: Some(workspace),
            setup,
            cursor,
            changes,
        })
    }

    /// Closes a ticket: removes its worktree (refusing, unless `force`, when
    /// that would lose work), forgets its workspace and marks it closed. The
    /// note stays where it is. Returns the workspace it had, whose terminals
    /// the caller ends.
    pub fn close_ticket(
        &self,
        path: &str,
        force: bool,
    ) -> Result<(Ticket, Option<String>, Vec<FileChange>)> {
        let config = self.config()?;
        let ticket = self.ticket(path)?;
        if !ticket.is_active() {
            return Err(CoreError::Conflict(format!(
                "{} is already closed",
                ticket.title
            )));
        }
        if let (Some(repo), Some(wt)) = (&ticket.repo, &ticket.worktree_path) {
            let wt = Path::new(wt);
            if wt.exists() {
                let repo = config.repo(repo)?;
                let location = self.repos().require(&repo.id)?;
                let warnings = git::state(wt, &repo.git.base_branch).warnings();
                if !warnings.is_empty() && !force {
                    return Err(CoreError::Conflict(format!(
                        "Not closed: {}.",
                        warnings.join(", ")
                    )));
                }
                git::remove_worktree(location.path(), wt, force)?;
            }
        }
        let workspace = ticket.workspace.clone();
        if let Some(id) = &workspace {
            let _ = self.workspaces().delete(id);
        }
        let today = Local::now().format("%Y-%m-%d").to_string();
        let changes = self.set_properties(
            path,
            &[
                ("status", Some(Prop::text("closed"))),
                ("closed", Some(Prop::text(today))),
                ("workspace", None),
            ],
        )?;
        Ok((self.ticket(path)?, workspace, changes))
    }

    /// Reopens a closed ticket: its worktree again (from the local or remote
    /// branch), a new workspace, and `status: active`.
    pub fn restore_ticket(&self, path: &str) -> Result<CreatedTicket> {
        let config = self.config()?;
        let ticket = self.ticket(path)?;
        if ticket.is_active() {
            return Err(CoreError::Conflict(format!(
                "{} isn't closed",
                ticket.title
            )));
        }
        let mut setup = Vec::new();
        let cwd = match (&ticket.repo, &ticket.worktree, &ticket.branch) {
            (Some(repo), Some(name), Some(branch)) => {
                let repo = config.repo(repo)?;
                let location = self.repos().require(&repo.id)?;
                let wt = location.worktree(name);
                if !wt.exists() {
                    git::add_worktree(location.path(), &wt, branch, &repo.git.base_branch)?;
                    setup = setup_steps(&config, repo, &ticket.code, &location.path, &wt);
                }
                wt.display().to_string()
            }
            _ => {
                let home = ticket.projects.first().and_then(|p| config.project(p));
                self.default_folder(home.map_or(path, |p| p.folder.as_str()))
            }
        };
        let workspace = self
            .workspaces()
            .create_for(&ticket.title, &cwd, Some(path))?;
        let changes = self.set_properties(
            path,
            &[
                ("status", Some(Prop::text("active"))),
                ("closed", None),
                ("workspace", Some(Prop::text(&workspace.id))),
            ],
        )?;
        Ok(CreatedTicket {
            ticket: self.ticket(path)?,
            workspace: Some(workspace),
            setup,
            cursor: None,
            changes,
        })
    }

    /// Worktrees of located repos that no ticket note refers to.
    pub fn stray_worktrees(&self) -> Result<Vec<StrayWorktree>> {
        let config = self.config()?;
        let known: Vec<PathBuf> = self
            .tickets(&TicketFilter {
                status: Some("all".into()),
                ..Default::default()
            })?
            .into_iter()
            .filter_map(|t| t.worktree_path.map(PathBuf::from))
            .collect();
        let mut strays = Vec::new();
        for (id, location) in self.repos().all() {
            if !config.repos.contains_key(&id) {
                continue;
            }
            let Ok(list) = git::worktrees(location.path()) else {
                continue;
            };
            for wt in list {
                let real = std::fs::canonicalize(&wt.path).unwrap_or(wt.path.clone());
                if known
                    .iter()
                    .any(|k| std::fs::canonicalize(k).unwrap_or(k.clone()) == real)
                {
                    continue;
                }
                let name = real.file_name().map(|n| n.to_string_lossy().into_owned());
                let key = wt
                    .branch
                    .as_deref()
                    .and_then(|b| config.find_key(b))
                    .or_else(|| config.find_key(name.as_deref()?))
                    .map(|(k, _)| k);
                strays.push(StrayWorktree {
                    repo: id.clone(),
                    path: real.display().to_string(),
                    branch: wt.branch,
                    key,
                });
            }
        }
        Ok(strays)
    }

    /// A workspace for any note, linked both ways (`workspace:` in the note,
    /// the note in the workspace). Its terminals start in the ticket's
    /// worktree, else the note's project folder, else the note's folder.
    pub fn note_workspace(&self, path: &str) -> Result<(Workspace, Vec<FileChange>)> {
        self.vault().resolve(path)?;
        let index_has = self.index().note(path).is_some();
        if !index_has {
            return Err(CoreError::NotFound(path.to_string()));
        }
        let config = self.config()?;
        let existing = {
            let index = self.index();
            fm_str(
                index.note(path).and_then(|n| n.frontmatter.as_ref()),
                "workspace",
            )
        };
        if let Some(id) = existing
            && let Some(ws) = self.workspaces().list().into_iter().find(|w| w.id == id)
        {
            return Ok((ws, Vec::new()));
        }
        let cwd = match self.ticket_of(&config, path).and_then(|t| t.worktree_path) {
            Some(wt) if Path::new(&wt).is_dir() => wt,
            _ => {
                let project = self
                    .note_projects(&config, path)
                    .first()
                    .and_then(|id| config.project(id))
                    .map(|p| p.folder.clone());
                self.default_folder(project.as_deref().unwrap_or(path))
            }
        };
        let workspace = self
            .workspaces()
            .create_for(file_stem(path), &cwd, Some(path))?;
        let changes =
            self.set_properties(path, &[("workspace", Some(Prop::text(&workspace.id)))])?;
        Ok((workspace, changes))
    }

    /// Deletes a workspace, and the `workspace:` link to it from its note.
    pub fn delete_workspace(&self, id: &str) -> Result<Vec<FileChange>> {
        let note = self
            .workspaces()
            .list()
            .into_iter()
            .find(|w| w.id == id)
            .and_then(|w| w.note);
        self.workspaces().delete(id)?;
        let Some(note) = note else {
            return Ok(Vec::new());
        };
        let linked = {
            let index = self.index();
            fm_str(
                index.note(&note).and_then(|n| n.frontmatter.as_ref()),
                "workspace",
            )
        };
        if linked.as_deref() == Some(id) {
            return self.set_properties(&note, &[("workspace", None)]);
        }
        Ok(Vec::new())
    }

    /// Context for a note, or for a folder (absolute) on this machine.
    pub fn context(&self, note: Option<&str>, cwd: Option<&Path>) -> Result<Context> {
        let config = self.config()?;
        let mut note = note.map(str::to_string);
        let mut repo_id: Option<String> = None;
        let mut in_checkout: Option<PathBuf> = None;
        if note.is_none()
            && let Some(cwd) = cwd
        {
            let cwd = std::fs::canonicalize(cwd).unwrap_or(cwd.to_path_buf());
            let root = std::fs::canonicalize(self.vault().root())
                .unwrap_or(self.vault().root().to_path_buf());
            if let Ok(rel) = cwd.strip_prefix(&root) {
                let rel = rel.to_string_lossy().into_owned();
                // A folder in the vault: its project (as if a note inside it).
                let projects: Vec<ProjectRef> = config
                    .project_of_folder(&format!("{rel}/x"))
                    .map(ProjectRef::from)
                    .into_iter()
                    .collect();
                return Ok(self.finish_context(&config, None, None, projects, None, None));
            }
            for (id, location) in self.repos().all() {
                let trees = std::fs::canonicalize(&location.worktrees)
                    .unwrap_or(PathBuf::from(&location.worktrees));
                if let Ok(rel) = cwd.strip_prefix(&trees)
                    && let Some(name) = rel.components().next()
                {
                    let name = name.as_os_str().to_string_lossy().into_owned();
                    let ticket = self
                        .tickets(&TicketFilter {
                            repo: Some(id.clone()),
                            status: Some("all".into()),
                            ..Default::default()
                        })?
                        .into_iter()
                        .find(|t| t.worktree.as_deref() == Some(name.as_str()));
                    repo_id = Some(id.clone());
                    in_checkout = Some(trees.join(&name));
                    note = ticket.map(|t| t.path);
                    break;
                }
                if cwd.starts_with(location.path()) {
                    repo_id = Some(id.clone());
                    in_checkout = Some(location.path().to_path_buf());
                    break;
                }
            }
        }
        let ticket = note.as_deref().and_then(|n| self.ticket_of(&config, n));
        let projects: Vec<ProjectRef> = match &note {
            Some(n) => self
                .note_projects(&config, n)
                .iter()
                .filter_map(|id| config.project(id))
                .map(ProjectRef::from)
                .collect(),
            None => Vec::new(),
        };
        let repo_id = ticket.as_ref().and_then(|t| t.repo.clone()).or(repo_id);
        Ok(self.finish_context(&config, note, ticket, projects, repo_id, in_checkout))
    }

    fn finish_context(
        &self,
        config: &Config,
        note: Option<String>,
        ticket: Option<Ticket>,
        projects: Vec<ProjectRef>,
        repo_id: Option<String>,
        checkout: Option<PathBuf>,
    ) -> Context {
        let repo = repo_id.as_deref().and_then(|r| config.repos.get(r));
        let location = repo.and_then(|r| self.repos().get(&r.id));
        // Where the code is: the ticket's worktree if it's on disk, else
        // the folder we were asked about, else the main checkout.
        let worktree = ticket
            .as_ref()
            .and_then(|t| t.worktree_path.clone())
            .filter(|p| Path::new(p).is_dir());
        let code_root = worktree
            .clone()
            .map(PathBuf::from)
            .or(checkout)
            .or_else(|| location.as_ref().map(|l| l.path().to_path_buf()));

        // The code involved: the ticket's, else its projects', else the repo's.
        let mut code: Vec<String> = ticket.as_ref().map(|t| t.code.clone()).unwrap_or_default();
        if code.is_empty() {
            code = projects
                .iter()
                .filter_map(|p| config.project(&p.id))
                .flat_map(|p| p.code.clone())
                .collect();
        }
        if code.is_empty()
            && let Some(repo) = repo
        {
            code = repo
                .components
                .keys()
                .map(|c| format!("{}:{c}", repo.id))
                .collect();
        }
        let mut components = Vec::new();
        for id in &code {
            let Ok((r, Some((name, c)))) = config.component(id) else {
                continue;
            };
            let abs = (Some(r.id.as_str()) == repo.map(|r| r.id.as_str()))
                .then(|| {
                    code_root
                        .as_ref()
                        .map(|root| root.join(&c.path).display().to_string())
                })
                .flatten();
            components.push(ComponentContext {
                id: format!("{}:{name}", r.id),
                path: c.path.clone(),
                abs_path: abs,
                description: c.description.clone(),
                commands: c.commands.clone(),
                docs: c.docs.clone(),
            });
        }

        let repo_context = repo.map(|r| RepoContext {
            id: r.id.clone(),
            name: r.display_name().to_string(),
            description: r.description.clone(),
            base_branch: r.git.base_branch.clone(),
            path: location.as_ref().map(|l| l.path.clone()),
            worktree_path: worktree.clone(),
            docs: r.docs.clone(),
        });

        // Related notes.
        let mut related: Vec<String> = Vec::new();
        let push = |related: &mut Vec<String>, p: String| {
            if Some(&p) != note.as_ref() && !related.contains(&p) {
                related.push(p);
            }
        };
        if let Some(n) = &note {
            let index = self.index();
            for link in index.outgoing(n) {
                if let Some(target) = link.resolved {
                    push(&mut related, target);
                }
            }
        }
        for p in &projects {
            if let Some(o) = &p.overview {
                push(&mut related, o.clone());
            }
        }
        {
            let index = self.index();
            let mut recent: Vec<(std::time::SystemTime, String)> = index
                .notes()
                .filter(|(path, n)| {
                    projects
                        .iter()
                        .any(|p| path.starts_with(&format!("{}/", p.folder)))
                        && n.frontmatter
                            .as_ref()
                            .and_then(|f| f.get("type"))
                            .and_then(Value::as_str)
                            != Some("ticket")
                })
                .filter_map(|(path, _)| Some((index.get(path)?.mtime?, path.to_string())))
                .collect();
            recent.sort_by_key(|r| std::cmp::Reverse(r.0));
            for (_, p) in recent.into_iter().take(RECENT_NOTES) {
                push(&mut related, p);
            }
        }

        let actions = self.actions(
            config,
            ticket.as_ref(),
            &projects,
            repo,
            &components,
            code_root.as_deref(),
            location.as_ref().map(|l| l.path()),
            note.as_deref(),
        );
        Context {
            note,
            ticket,
            projects,
            repo: repo_context,
            components,
            actions,
            related,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn actions(
        &self,
        config: &Config,
        ticket: Option<&Ticket>,
        projects: &[ProjectRef],
        repo: Option<&Repo>,
        components: &[ComponentContext],
        code_root: Option<&Path>,
        checkout: Option<&Path>,
        note: Option<&str>,
    ) -> Vec<Action> {
        let vault = self.vault().root().display().to_string();
        let mut vars: HashMap<String, String> = HashMap::new();
        vars.insert("vault.path".into(), vault.clone());
        if let Some(n) = note {
            vars.insert("note.path".into(), n.into());
        }
        if let Some(c) = checkout {
            vars.insert("repo.path".into(), c.display().to_string());
        }
        let worktree = ticket
            .and_then(|t| t.worktree_path.clone())
            .filter(|p| Path::new(p).is_dir());
        if let Some(w) = &worktree {
            vars.insert("worktree.path".into(), w.clone());
        }
        if let Some(t) = ticket {
            vars.insert("ticket.title".into(), t.title.clone());
            if let Some(k) = &t.key {
                vars.insert("ticket.key".into(), k.clone());
            }
            if let Some(u) = &t.url {
                vars.insert("jira.url".into(), u.clone());
            }
        }
        if let Some(p) = projects.first() {
            vars.insert(
                "project.folder".into(),
                self.vault().root().join(&p.folder).display().to_string(),
            );
            vars.insert("project.name".into(), p.name.clone());
        }
        let default_cwd = code_root
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| vault.clone());

        let mut actions: Vec<Action> = Vec::new();
        if let Some(w) = &worktree {
            actions.push(Action {
                id: "open-vscode".into(),
                label: "Open in VS Code".into(),
                kind: "shell".into(),
                run: format!("code {}", shell_quote(w)),
                cwd: w.clone(),
                source: "built-in".into(),
            });
        }
        if let Some(url) = ticket.and_then(|t| t.url.clone()) {
            actions.push(Action {
                id: "open-ticket".into(),
                label: "Open Jira ticket".into(),
                kind: "url".into(),
                run: url,
                cwd: default_cwd.clone(),
                source: "built-in".into(),
            });
        }
        let mut add =
            |def: &ActionDef, source: String, vars: &HashMap<String, String>, cwd: &str| {
                if !matches!(def.kind.as_str(), "shell" | "terminal" | "url" | "") {
                    return; // Agent actions come with Phase 6.
                }
                let Some(run) = expand(&def.run, vars) else {
                    return;
                };
                let cwd = match &def.cwd {
                    Some(c) => match expand(c, vars) {
                        Some(c) => c,
                        None => return,
                    },
                    None => cwd.to_string(),
                };
                let id = if def.id.is_empty() {
                    slugify(&def.label)
                } else {
                    def.id.clone()
                };
                if actions.iter().any(|a| a.id == id) {
                    return;
                }
                actions.push(Action {
                    id,
                    label: if def.label.is_empty() {
                        def.id.clone()
                    } else {
                        def.label.clone()
                    },
                    kind: if def.kind.is_empty() {
                        "shell".into()
                    } else {
                        def.kind.clone()
                    },
                    run,
                    cwd,
                    source,
                });
            };
        for def in &config.actions {
            add(def, "vault".into(), &vars, &default_cwd);
        }
        for p in projects {
            if let Some(project) = config.project(&p.id) {
                for def in &project.actions {
                    add(def, format!("project:{}", p.id), &vars, &default_cwd);
                }
            }
        }
        if let Some(repo) = repo {
            for def in repo.actions.iter().filter(|d| d.component.is_none()) {
                add(def, format!("repo:{}", repo.id), &vars, &default_cwd);
            }
        }
        for c in components {
            let Ok((r, Some((name, component)))) = config.component(&c.id) else {
                continue;
            };
            let mut vars = vars.clone();
            let cwd = c.abs_path.clone().unwrap_or_else(|| default_cwd.clone());
            if let Some(abs) = &c.abs_path {
                vars.insert("component.path".into(), abs.clone());
            }
            for (cmd, run) in &component.commands {
                vars.insert(format!("component.commands.{cmd}"), run.clone());
            }
            let scoped = r
                .actions
                .iter()
                .filter(|d| d.component.as_deref() == Some(c.id.as_str()))
                .chain(&component.actions);
            for def in scoped {
                add(def, format!("component:{}", c.id), &vars, &cwd);
            }
            if c.abs_path.is_some() {
                for (cmd, run) in &component.commands {
                    let def = ActionDef {
                        id: format!("{}:{cmd}", c.id),
                        label: format!("{name}: {cmd}"),
                        kind: "terminal".into(),
                        run: run.clone(),
                        ..Default::default()
                    };
                    add(&def, format!("component:{}", c.id), &vars, &cwd);
                }
            }
        }
        actions
    }

    /// The projects and open tickets that touch `path`: a folder or file in
    /// a located repo's checkout or worktrees, or `repo:relative/path`.
    pub fn code_who(&self, path: &str) -> Result<CodeOwners> {
        let config = self.config()?;
        let (repo_id, rel) = self.locate_in_repo(&config, path)?;
        let repo = config.repo(&repo_id)?;
        let rel = rel.trim_matches('/').to_string();
        let covers = |c: &str| {
            let c = c.trim_matches('/');
            rel.is_empty()
                || rel == c
                || rel.starts_with(&format!("{c}/"))
                || c.starts_with(&format!("{rel}/"))
        };
        let components: Vec<String> = repo
            .components
            .iter()
            .filter(|(_, c)| covers(&c.path))
            .map(|(name, _)| format!("{}:{name}", repo.id))
            .collect();
        let touches =
            |code: &[String]| code.iter().any(|c| *c == repo.id || components.contains(c));
        let projects = config
            .projects
            .iter()
            .filter(|p| touches(&p.code))
            .map(ProjectRef::from)
            .collect();
        let tickets = self
            .tickets(&TicketFilter {
                repo: Some(repo.id.clone()),
                ..Default::default()
            })?
            .into_iter()
            .filter(|t| t.code.is_empty() || touches(&t.code))
            .collect();
        Ok(CodeOwners {
            repo: repo.id.clone(),
            path: rel,
            components,
            projects,
            tickets,
        })
    }

    fn locate_in_repo(&self, config: &Config, path: &str) -> Result<(String, String)> {
        if let Some((repo, rel)) = path.split_once(':')
            && config.repos.contains_key(repo)
            && !Path::new(path).exists()
        {
            return Ok((repo.to_string(), rel.to_string()));
        }
        let full = crate::workspaces::expand_home(path);
        let full = if full.is_absolute() {
            full
        } else {
            std::env::current_dir()?.join(full)
        };
        let full = std::fs::canonicalize(&full).unwrap_or(full);
        for (id, location) in self.repos().all() {
            let trees = std::fs::canonicalize(&location.worktrees)
                .unwrap_or(PathBuf::from(&location.worktrees));
            if let Ok(rest) = full.strip_prefix(&trees) {
                let mut parts = rest.components();
                parts.next();
                return Ok((id, parts.as_path().to_string_lossy().into_owned()));
            }
            if let Ok(rest) = full.strip_prefix(location.path()) {
                return Ok((id, rest.to_string_lossy().into_owned()));
            }
        }
        Err(CoreError::NotFound(format!(
            "{} isn't in a located repo",
            full.display()
        )))
    }

    /// A project as a frontmatter link: to its overview note, else its name.
    fn project_link(&self, project: &Project, source: &str) -> String {
        match &project.overview {
            Some(o) if self.index().get(o).is_some() => {
                self.index()
                    .format_link(o, source, LinkKind::Wiki, None, None, false)
            }
            _ => project.name.clone(),
        }
    }

    /// The absolute folder for a vault path: itself if it's a folder, else its parent.
    fn default_folder(&self, path: &str) -> String {
        let full = self.vault().root().join(path);
        let folder = if full.is_dir() {
            full
        } else {
            full.parent().map_or(full.clone(), Path::to_path_buf)
        };
        folder.display().to_string()
    }

    /// Sets or removes frontmatter properties of a note.
    pub fn set_properties(
        &self,
        path: &str,
        changes: &[(&str, Option<Prop>)],
    ) -> Result<Vec<FileChange>> {
        let text = std::fs::read_to_string(self.vault().resolve(path)?)?;
        let updated = frontmatter::set(&text, changes);
        if updated == text {
            return Ok(Vec::new());
        }
        Ok(self.write_file(path, &updated)?.1)
    }
}

/// The repo's setup at the worktree root, then each component's in its
/// folder, for the components of this repo in `code`.
fn setup_steps(
    config: &Config,
    repo: &Repo,
    code: &[String],
    checkout: &str,
    worktree: &Path,
) -> Vec<SetupStep> {
    let wt = worktree.display().to_string();
    let mut vars: HashMap<String, String> = HashMap::new();
    vars.insert("repo.path".into(), checkout.to_string());
    vars.insert("worktree.path".into(), wt.clone());
    let mut steps: Vec<SetupStep> = repo
        .setup
        .iter()
        .filter_map(|cmd| expand(cmd, &vars))
        .map(|command| SetupStep {
            cwd: wt.clone(),
            command,
        })
        .collect();
    for code in code {
        let Ok((r, Some((_, c)))) = config.component(code) else {
            continue;
        };
        if r.id != repo.id {
            continue;
        }
        let dir = worktree.join(&c.path).display().to_string();
        let mut vars = vars.clone();
        vars.insert("component.path".into(), dir.clone());
        steps.extend(
            c.setup
                .iter()
                .filter_map(|cmd| expand(cmd, &vars))
                .map(|command| SetupStep {
                    cwd: dir.clone(),
                    command,
                }),
        );
    }
    steps
}

/// Setup steps as one line for a shell: `cd`s between folders, stopping at
/// the first failure.
pub fn setup_line(steps: &[SetupStep]) -> Option<String> {
    let first = steps.first()?;
    let mut parts = Vec::new();
    let mut cwd = first.cwd.as_str();
    parts.push(format!("cd {}", shell_quote(cwd)));
    for step in steps {
        if step.cwd != cwd {
            cwd = &step.cwd;
            parts.push(format!("cd {}", shell_quote(cwd)));
        }
        parts.push(step.command.clone());
    }
    if cwd != first.cwd {
        parts.push(format!("cd {}", shell_quote(&first.cwd)));
    }
    Some(parts.join(" && "))
}

pub fn shell_quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+=:,@%".contains(c))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Vault;
    use std::fs;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/vault");

    fn copy_dir(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap().flatten() {
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_dir(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    struct Setup {
        dir: tempfile::TempDir,
        repo: PathBuf,
        session: Session,
    }

    impl Setup {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let vault = dir.path().join("vault");
            copy_dir(Path::new(FIXTURE), &vault);
            let repo = git::tests::repo_with_origin(dir.path());
            let session =
                Session::open(Vault::open(&vault).unwrap(), &dir.path().join("data")).unwrap();
            Self { dir, repo, session }
        }

        fn locate(&self) {
            self.session
                .repos()
                .locate("acme-platform", self.repo.to_str().unwrap(), None)
                .unwrap();
        }

        fn read(&self, path: &str) -> String {
            fs::read_to_string(self.dir.path().join("vault").join(path)).unwrap()
        }

        fn worktrees(&self) -> PathBuf {
            self.repo.with_file_name("repo-worktrees")
        }
    }

    fn new_ticket(key: &str, title: &str) -> NewTicket {
        NewTicket {
            key: Some(key.into()),
            title: Some(title.into()),
            projects: vec!["acme".into()],
            code: vec!["acme-platform:web".into()],
            ..Default::default()
        }
    }

    #[test]
    fn names_skip_a_missing_key() {
        assert_eq!(
            name_format("{{key}}-{{slug}}", Some("T-1"), "fix", ""),
            "T-1-fix"
        );
        assert_eq!(name_format("{{key}}-{{slug}}", None, "fix", ""), "fix");
        assert_eq!(name_format("{{slug}}_{{key}}", None, "fix", ""), "fix");
        assert_eq!(
            name_format("{{key}} {{title}}", None, "", "Fix it"),
            "Fix it"
        );
        assert_eq!(safe_name("Fix: a/b [x]?"), "Fix a b x");
        assert_eq!(title_from_slug("try-new-cache"), "Try new cache");
    }

    #[test]
    fn expand_leaves_unknown_tags_and_gives_up_on_missing_context() {
        let vars: HashMap<String, String> =
            [("worktree.path".to_string(), "/w".to_string())].into();
        assert_eq!(
            expand("code {{worktree.path}}", &vars).as_deref(),
            Some("code /w")
        );
        assert_eq!(expand("echo {{x}}", &vars).as_deref(), Some("echo {{x}}"));
        assert_eq!(expand("cd {{repo.path}}", &vars), None);
    }

    #[test]
    fn setup_runs_in_one_line_across_folders() {
        let steps = [
            SetupStep {
                cwd: "/w".into(),
                command: "npm install".into(),
            },
            SetupStep {
                cwd: "/w/apps/my web".into(),
                command: "npm run build".into(),
            },
        ];
        assert_eq!(
            setup_line(&steps).unwrap(),
            "cd /w && npm install && cd '/w/apps/my web' && npm run build && cd /w"
        );
        assert_eq!(setup_line(&[]), None);
    }

    #[test]
    fn a_ticket_gets_a_worktree_a_note_and_a_workspace_then_closes_and_restores() {
        let s = Setup::new();
        let new = NewTicket {
            key: Some("https://example.atlassian.net/browse/TEAM-200".into()),
            ..new_ticket("", "Fix signup")
        };
        // The repo has to be located first.
        assert!(matches!(
            s.session.create_ticket(&new),
            Err(CoreError::RepoNotLocated(r)) if r == "acme-platform"
        ));
        s.locate();
        let created = s.session.create_ticket(&new).unwrap();
        let t = &created.ticket;
        assert_eq!(t.path, "Projects/Acme/Work/TEAM-200 Fix signup.md");
        assert_eq!(t.key.as_deref(), Some("TEAM-200"));
        assert_eq!(
            t.url.as_deref(),
            Some("https://example.atlassian.net/browse/TEAM-200")
        );
        assert_eq!(t.projects, ["acme"]);
        assert_eq!(t.repo.as_deref(), Some("acme-platform"));
        assert_eq!(t.branch.as_deref(), Some("TEAM-200-fix-signup"));
        assert_eq!(t.worktree.as_deref(), Some("TEAM-200-fix-signup"));
        let wt = s.worktrees().join("TEAM-200-fix-signup");
        assert_eq!(t.worktree_path.as_deref(), Some(wt.to_str().unwrap()));
        assert!(wt.join("README.md").is_file());
        assert_eq!(
            created.setup,
            [SetupStep {
                cwd: wt.display().to_string(),
                command: "npm install".into()
            }]
        );

        let text = s.read(&t.path);
        assert!(text.contains("# TEAM-200 Fix signup"), "{text}");
        assert!(
            text.contains("jira: https://example.atlassian.net/browse/TEAM-200\n"),
            "{text}"
        );
        assert!(text.contains("projects: [\"[[Acme]]\"]\n"), "{text}");
        assert!(text.contains("code: [acme-platform:web]\n"), "{text}");
        assert!(text.contains("status: active\n"), "{text}");
        let ws = created.workspace.as_ref().unwrap();
        assert!(text.contains(&format!("workspace: {}\n", ws.id)), "{text}");
        assert_eq!(ws.cwd, fs::canonicalize(&wt).unwrap().display().to_string());
        assert_eq!(ws.note.as_deref(), Some(t.path.as_str()));
        assert_eq!(ws.name, "TEAM-200 Fix signup");

        let listed = s.session.tickets(&TicketFilter::default()).unwrap();
        let keys: Vec<_> = listed.iter().filter_map(|t| t.key.as_deref()).collect();
        assert_eq!(keys, ["TEAM-123", "TEAM-200"]);
        let in_web = TicketFilter {
            component: Some("acme-platform:web".into()),
            project: Some("Acme".into()),
            ..Default::default()
        };
        assert_eq!(s.session.tickets(&in_web).unwrap().len(), 2);
        assert!(
            s.session.create_ticket(&new).is_err(),
            "the worktree exists"
        );

        let git = s.session.ticket_git(&t.path).unwrap();
        assert!(git.exists && !git.on_remote);

        // Closing would lose the branch (not on the remote) without force.
        let err = s
            .session
            .close_ticket(&t.path, false)
            .unwrap_err()
            .to_string();
        assert!(err.contains("isn't on the remote"), "{err}");
        let (closed, workspace, _) = s.session.close_ticket(&t.path, true).unwrap();
        assert_eq!(closed.status, "closed");
        assert!(closed.closed.is_some() && closed.workspace.is_none());
        assert_eq!(workspace.as_deref(), Some(ws.id.as_str()));
        assert!(!wt.exists());
        assert!(s.session.workspaces().list().is_empty());
        assert!(
            s.session
                .tickets(&TicketFilter::default())
                .unwrap()
                .iter()
                .all(|t| t.key.as_deref() != Some("TEAM-200"))
        );
        assert!(s.session.close_ticket(&t.path, true).is_err());

        let restored = s.session.restore_ticket(&t.path).unwrap();
        assert!(wt.join("README.md").is_file());
        assert_eq!(restored.ticket.status, "active");
        assert!(restored.ticket.closed.is_none());
        assert_eq!(restored.setup.len(), 1);
        let text = s.read(&t.path);
        assert!(!text.contains("closed:"), "{text}");
        assert!(text.contains(&format!("workspace: {}\n", restored.workspace.unwrap().id)));
    }

    #[test]
    fn ad_hoc_tickets_existing_notes_and_strays() {
        let s = Setup::new();
        s.locate();

        // Just a repo and a slug.
        let adhoc = s
            .session
            .create_ticket(&NewTicket {
                slug: Some("Try new cache".into()),
                repo: Some("acme-platform".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(adhoc.ticket.path, "Work/Try new cache.md");
        assert_eq!(adhoc.ticket.branch.as_deref(), Some("try-new-cache"));
        assert!(adhoc.ticket.projects.is_empty() && adhoc.ticket.key.is_none());

        // No repo: a note and a workspace in the project folder.
        let plain = s
            .session
            .create_ticket(&NewTicket {
                title: Some("Plan offsite".into()),
                projects: vec!["acme".into()],
                no_worktree: true,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(plain.ticket.path, "Projects/Acme/Work/Plan offsite.md");
        assert!(plain.ticket.worktree.is_none());
        assert!(
            plain
                .workspace
                .unwrap()
                .cwd
                .ends_with("vault/Projects/Acme")
        );

        // An existing note becomes a ticket where it is.
        let note = "Projects/Acme/Meetings/2026-11-02 Kickoff.md";
        let before = s.read(note);
        let added = s
            .session
            .create_ticket(&NewTicket {
                key: Some("TEAM-400".into()),
                note: Some(note.into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(added.ticket.path, note);
        assert_eq!(added.ticket.projects, ["acme"]);
        assert_eq!(
            added.ticket.branch.as_deref(),
            Some("TEAM-400-2026-11-02-kickoff")
        );
        let after = s.read(note);
        assert!(
            after.contains("type: ticket\n")
                && after.ends_with(before.split("---\n").last().unwrap())
        );
        assert!(
            s.session
                .create_ticket(&NewTicket {
                    key: Some("TEAM-401".into()),
                    note: Some(note.into()),
                    ..Default::default()
                })
                .is_err()
        );

        // A worktree made by hand shows up, and can be adopted.
        let stray = s.worktrees().join("TEAM-300-hotfix");
        git::add_worktree(&s.repo, &stray, "TEAM-300-hotfix", "main").unwrap();
        let strays = s.session.stray_worktrees().unwrap();
        assert_eq!(strays.len(), 1);
        assert_eq!(strays[0].key.as_deref(), Some("TEAM-300"));
        let adopted = s
            .session
            .create_ticket(&NewTicket {
                key: strays[0].key.clone(),
                adopt: Some(strays[0].path.clone()),
                repo: Some("acme-platform".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(adopted.ticket.path, "Work/TEAM-300 Hotfix.md");
        assert_eq!(adopted.ticket.worktree.as_deref(), Some("TEAM-300-hotfix"));
        assert!(adopted.setup.is_empty());
        assert!(s.session.stray_worktrees().unwrap().is_empty());
    }

    #[test]
    fn context_who_and_actions() {
        let s = Setup::new();
        s.locate();
        let t = s
            .session
            .create_ticket(&new_ticket("TEAM-200", "Fix signup"))
            .unwrap()
            .ticket;
        let wt = PathBuf::from(t.worktree_path.clone().unwrap());

        let ctx = s.session.context(Some(&t.path), None).unwrap();
        assert_eq!(
            ctx.ticket.as_ref().unwrap().key.as_deref(),
            Some("TEAM-200")
        );
        assert_eq!(
            ctx.projects[0].overview.as_deref(),
            Some("Projects/Acme/Acme.md")
        );
        let repo = ctx.repo.as_ref().unwrap();
        assert_eq!(repo.worktree_path.as_deref(), Some(wt.to_str().unwrap()));
        assert_eq!(repo.docs, ["CLAUDE.md"]);
        assert_eq!(ctx.components.len(), 1);
        assert_eq!(
            ctx.components[0].abs_path.as_deref(),
            Some(wt.join("apps/web").to_str().unwrap())
        );
        assert!(ctx.related.contains(&"Projects/Acme/Acme.md".to_string()));
        assert!(
            !ctx.related.iter().any(|r| r.contains("/Work/")),
            "{:?}",
            ctx.related
        );
        let ids: Vec<_> = ctx.actions.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "open-vscode",
                "open-ticket",
                "worktree-finder",
                "storybook",
                "acme-platform:web:dev",
                "acme-platform:web:test"
            ]
        );
        let finder = &ctx.actions[2];
        assert_eq!(finder.run, format!("open \"{}\"", wt.display()));
        let storybook = &ctx.actions[3];
        assert_eq!(
            (storybook.kind.as_str(), storybook.cwd.as_str()),
            ("terminal", wt.join("apps/web").to_str().unwrap())
        );

        // From a folder inside the worktree.
        fs::create_dir_all(wt.join("apps/web/src")).unwrap();
        let from_cwd = s
            .session
            .context(None, Some(&wt.join("apps/web/src")))
            .unwrap();
        assert_eq!(from_cwd.note.as_deref(), Some(t.path.as_str()));
        // From the main checkout: the repo, no ticket, no worktree actions.
        let main = s.session.context(None, Some(&s.repo)).unwrap();
        assert!(main.ticket.is_none());
        assert_eq!(main.repo.unwrap().id, "acme-platform");
        assert!(
            !main
                .actions
                .iter()
                .any(|a| a.id == "worktree-finder" || a.id == "open-vscode")
        );
        // From a vault folder: its project.
        let vault = s.dir.path().join("vault/Projects/Acme/Meetings");
        assert_eq!(
            s.session.context(None, Some(&vault)).unwrap().projects[0].id,
            "acme"
        );

        let who = s
            .session
            .code_who(wt.join("apps/web/src").to_str().unwrap())
            .unwrap();
        assert_eq!(who.path, "apps/web/src");
        assert_eq!(who.components, ["acme-platform:web"]);
        assert_eq!(who.projects[0].id, "acme");
        assert_eq!(who.tickets.len(), 2);
        let lambda = s.session.code_who("acme-platform:lambdas/auth").unwrap();
        assert_eq!(lambda.components, ["acme-platform:auth-lambda"]);
        assert_eq!(
            lambda
                .tickets
                .iter()
                .map(|t| t.key.clone().unwrap())
                .collect::<Vec<_>>(),
            ["TEAM-123"]
        );
        assert!(s.session.code_who("/nowhere").is_err());
    }

    #[test]
    fn any_note_can_have_a_workspace() {
        let s = Setup::new();
        let (ws, _) = s.session.note_workspace("Welcome.md").unwrap();
        assert_eq!(ws.name, "Welcome");
        assert_eq!(ws.note.as_deref(), Some("Welcome.md"));
        assert!(
            s.read("Welcome.md")
                .contains(&format!("workspace: {}\n", ws.id))
        );
        let (again, _) = s.session.note_workspace("Welcome.md").unwrap();
        assert_eq!(again.id, ws.id);
        let (meeting, _) = s
            .session
            .note_workspace("Projects/Acme/Meetings/2026-11-02 Kickoff.md")
            .unwrap();
        assert!(
            meeting.cwd.ends_with("vault/Projects/Acme"),
            "{}",
            meeting.cwd
        );

        s.session.delete_workspace(&ws.id).unwrap();
        assert!(!s.read("Welcome.md").contains("workspace:"));
        assert_eq!(s.session.workspaces().list().len(), 1);
    }
}
