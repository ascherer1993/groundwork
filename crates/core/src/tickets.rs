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
use crate::index::Index;
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
    /// The default repo: the first of `repos`.
    pub repo: Option<String>,
    /// The worktrees' folder name, the same in every repo.
    pub worktree: Option<String>,
    /// The same in every repo.
    pub branch: Option<String>,
    pub workspace: Option<String>,
    /// Where the default repo's worktree is (or would be) on this machine, once the repo is located.
    pub worktree_path: Option<String>,
    /// Every repo it has a worktree in, the default first.
    pub repos: Vec<TicketRepo>,
}

/// One of a ticket's repos.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TicketRepo {
    pub id: String,
    /// Where its worktree is (or would be) on this machine, once the repo is located.
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
    /// The default repo. Without it or `repos`, every repo in `code`, else
    /// the projects' repo when they use one.
    #[ts(optional)]
    pub repo: Option<String>,
    /// More repos, each getting a worktree on the same branch.
    #[ts(optional, as = "Option<Vec<String>>")]
    pub repos: Vec<String>,
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
    /// `shell`, `terminal`, `url` or `agent`.
    pub kind: String,
    /// The command line, the URL, or an agent's prompt (with its
    /// `{{input.<name>}}` tags left for the answers).
    pub run: String,
    /// An agent's questions for the user before it starts.
    pub inputs: Vec<ActionInput>,
    /// Absolute.
    pub cwd: String,
    /// Where it's defined: `built-in`, `vault`, `project:<id>`, `repo:<id>`
    /// or `component:<repo>:<component>`.
    pub source: String,
}

/// Something an agent action asks for before it starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct ActionInput {
    pub name: String,
    pub label: String,
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
    pub code: Vec<String>,
}

/// What `remove_ticket_repo` did.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemovedTicketRepo {
    pub ticket: Ticket,
    /// The workspace, when it moved to another worktree.
    pub workspace: Option<Workspace>,
    /// The worktree taken away, whose terminals should end.
    pub worktree: Option<String>,
    #[serde(skip)]
    #[ts(skip)]
    pub changes: Vec<FileChange>,
}

/// A note moved by `gather_tickets`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MovedNote {
    pub from: String,
    pub to: String,
}

/// How many recently changed project notes `context` lists.
const RECENT_NOTES: usize = 5;

/// `Session::note_projects`, with the index already in hand.
pub(crate) fn note_projects_in(index: &Index, config: &Config, path: &str) -> Vec<String> {
    let mut ids = linked_projects_in(index, config, path);
    if let Some(p) = config.project_of_folder(path)
        && !ids.contains(&p.id)
    {
        ids.push(p.id.clone());
    }
    ids
}

/// The projects a note's `projects:` frontmatter links to, leaving out the
/// folder it's in.
fn linked_projects_in(index: &Index, config: &Config, path: &str) -> Vec<String> {
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
    ids
}

pub(crate) fn fm_str(fm: Option<&Value>, key: &str) -> Option<String> {
    match fm?.get(key)? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub(crate) fn fm_list(fm: Option<&Value>, key: &str) -> Vec<String> {
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

/// A ticket's repos, the default first: `repos:`, else the older `repo:`.
fn ticket_repo_ids(fm: Option<&Value>) -> Vec<String> {
    let mut ids = fm_list(fm, "repos");
    if ids.is_empty() {
        ids.extend(fm_str(fm, "repo"));
    }
    let mut seen = Vec::new();
    ids.retain(|id| {
        let new = !seen.contains(id);
        seen.push(id.clone());
        new
    });
    ids
}

pub(crate) fn file_stem(path: &str) -> &str {
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

    /// Adds a repo to `.groundwork/repos.yml` from its checkout on this Mac
    /// (any folder in it), named after its folder unless `name` is given,
    /// with the base branch git reports; then records where it is. The rest
    /// (setup, components, actions) can be added to the file later.
    pub fn add_repo(
        &self,
        path: &str,
        name: Option<&str>,
        worktrees: Option<&str>,
    ) -> Result<RepoInfo> {
        let dir = crate::workspaces::expand_home(path.trim());
        if !dir.is_absolute() || !git::is_repo(&dir) {
            return Err(CoreError::InvalidPath(format!(
                "no git repo at {}",
                dir.display()
            )));
        }
        let checkout = git::toplevel(&dir).unwrap_or(dir);
        let folder = checkout
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name = name
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(&folder)
            .to_string();
        let id = slugify(&name);
        if id.is_empty() {
            return Err(CoreError::InvalidPath("give the repo a name".into()));
        }
        let config = self.config()?;
        let real = std::fs::canonicalize(&checkout).unwrap_or(checkout.clone());
        if let Some((known, _)) = self
            .repos()
            .all()
            .into_iter()
            .find(|(r, l)| config.repos.contains_key(r) && Path::new(&l.path) == real)
        {
            return Err(CoreError::Conflict(format!(
                "{} is already the {known} repo",
                real.display()
            )));
        }
        if config.repos.contains_key(&id) {
            return Err(CoreError::Conflict(format!(
                "there's already a repo called {id} in .groundwork/repos.yml"
            )));
        }
        let base = git::default_branch(&checkout).unwrap_or_else(|| "main".into());

        let file = self.vault().root().join(".groundwork/repos.yml");
        let mut text = std::fs::read_to_string(&file).unwrap_or_default();
        if text.is_empty() {
            text.push_str(
                "# Code repos used by this vault's projects. Where each is checked out\n\
                 # is kept on each machine, not here.\n",
            );
        } else if !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&format!(
            "{id}:\n  name: {}\n  git:\n    base_branch: {}\n",
            frontmatter::scalar(&name, false),
            frontmatter::scalar(&base, false),
        ));
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        crate::session::atomic_write(&file, &text)?;
        self.forget_config();
        // Its location goes too, if it can't be recorded.
        self.repos()
            .locate(&id, &checkout.display().to_string(), worktrees)?;
        self.repo_list()?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or(CoreError::NotFound(id))
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
                code: p.code,
            })
            .collect())
    }

    /// Makes a folder a project by giving it a `.groundwork.yml`. A folder
    /// that doesn't exist yet is made, with an overview note named after it;
    /// an existing folder's own note (`Trip/Trip.md`) becomes its overview.
    pub fn create_project(&self, folder: &str) -> Result<(ProjectInfo, Vec<FileChange>)> {
        let folder = folder.trim_matches('/');
        if folder.is_empty() {
            return Err(CoreError::InvalidPath(
                "the vault itself can't be a project; choose a folder".into(),
            ));
        }
        let mut changes = Vec::new();
        let dir = self.vault().root().join(folder);
        let new = !dir.exists();
        if new {
            changes.extend(self.create_folder(folder)?);
        } else if !self.vault().resolve(folder)?.is_dir() {
            return Err(CoreError::InvalidPath(format!("{folder} isn't a folder")));
        }
        if dir.join(".groundwork.yml").exists() {
            return Err(CoreError::Conflict(format!(
                "{folder} is already a project"
            )));
        }
        let base = folder.rsplit('/').next().unwrap_or(folder);
        let overview = format!("{folder}/{base}.md");
        if new {
            let text = format!(
                "---\ntype: project\ncreated: {}\n---\n",
                Local::now().format("%Y-%m-%dT%H:%M")
            );
            changes.extend(self.create_file(&overview, Some(&text))?);
        }
        let mut yml = format!("name: {}\n", frontmatter::scalar(base, false));
        if self.vault().root().join(&overview).is_file() {
            yml.push_str(&format!(
                "overview: {}\n",
                frontmatter::scalar(&format!("{base}.md"), false)
            ));
        }
        std::fs::write(dir.join(".groundwork.yml"), yml)?;
        self.forget_config();
        let info = self
            .project_list()?
            .into_iter()
            .find(|p| p.folder == folder)
            .ok_or_else(|| CoreError::NotFound(folder.to_string()))?;
        Ok((info, changes))
    }

    /// The projects a note belongs to: those linked in its `projects:`
    /// frontmatter (by overview note, id or name), then the project folder
    /// it's in.
    pub fn note_projects(&self, config: &Config, path: &str) -> Vec<String> {
        note_projects_in(&self.index(), config, path)
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
        let worktree = fm_str(fm, "worktree");
        let repos: Vec<TicketRepo> = ticket_repo_ids(fm)
            .into_iter()
            .map(|id| TicketRepo {
                worktree_path: worktree.as_ref().and_then(|w| {
                    self.repos()
                        .get(&id)
                        .map(|l| l.worktree(w).display().to_string())
                }),
                id,
            })
            .collect();
        let repo = repos.first().map(|r| r.id.clone());
        let worktree_path = repos.first().and_then(|r| r.worktree_path.clone());
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
            repos,
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
                    .is_none_or(|r| t.repos.iter().any(|tr| &tr.id == r))
            })
            .filter(|t| project.as_ref().is_none_or(|p| t.projects.contains(p)))
            .filter(|t| filter.component.as_ref().is_none_or(|c| t.code.contains(c)))
            .collect();
        tickets.sort_by(|a, b| {
            (a.key.is_none(), &a.key, &a.title).cmp(&(b.key.is_none(), &b.key, &b.title))
        });
        Ok(tickets)
    }

    /// The git state of the ticket's worktrees, added up: changes in any,
    /// commits unpushed and behind in all, on the remote only if all are
    /// (all defaults when there's none on disk).
    pub fn ticket_git(&self, path: &str) -> Result<GitState> {
        let config = self.config()?;
        let ticket = self.ticket(path)?;
        let mut total: Option<GitState> = None;
        for r in &ticket.repos {
            let Some(wt) = &r.worktree_path else { continue };
            let base = config.repo(&r.id).map(|r| r.git.base_branch.clone())?;
            let state = git::state(Path::new(wt), &base);
            if !state.exists {
                continue;
            }
            total = Some(match total {
                None => state,
                Some(mut t) => {
                    t.dirty |= state.dirty;
                    t.unpushed += state.unpushed;
                    t.behind += state.behind;
                    t.on_remote &= state.on_remote;
                    t
                }
            });
        }
        let mut state = total.unwrap_or_default();
        if state.exists && state.branch.is_none() {
            state.branch = ticket.branch;
        }
        Ok(state)
    }

    /// Each of the ticket's worktrees on disk, with what closing it would lose.
    fn worktree_warnings(&self, config: &Config, ticket: &Ticket) -> Result<Vec<String>> {
        let mut problems = Vec::new();
        for r in &ticket.repos {
            let Some(wt) = &r.worktree_path else { continue };
            let repo = config.repo(&r.id)?;
            let warnings = git::state(Path::new(wt), &repo.git.base_branch).warnings();
            if warnings.is_empty() {
                continue;
            }
            problems.push(if ticket.repos.len() > 1 {
                format!("in {}, {}", repo.id, warnings.join(", "))
            } else {
                warnings.join(", ")
            });
        }
        Ok(problems)
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
        let mut repo_ids: Vec<String> = Vec::new();
        for r in given(&new.repo)
            .into_iter()
            .chain(new.repos.iter().map(String::as_str))
        {
            let id = config.repo(r.trim())?.id.clone();
            if !repo_ids.contains(&id) {
                repo_ids.push(id);
            }
        }
        if repo_ids.is_empty() {
            // Every repo the code touches, in the order given.
            for id in new.code.iter().map(repo_of) {
                if !repo_ids.contains(&id) {
                    repo_ids.push(id);
                }
            }
        }
        if repo_ids.is_empty() {
            // Projects using several repos don't say which this one touches.
            let mut repos: Vec<String> = projects
                .iter()
                .flat_map(|p| p.code.iter().map(repo_of))
                .collect();
            repos.sort();
            repos.dedup();
            match repos.as_slice() {
                [one] => repo_ids.push(one.clone()),
                [] => {}
                _ => {
                    return Err(CoreError::InvalidPath(format!(
                        "which repo? the ticket could use {}",
                        repos.join(" or ")
                    )));
                }
            }
        }
        let repos: Vec<&Repo> = repo_ids
            .iter()
            .map(|r| config.repo(r))
            .collect::<Result<_>>()?;
        let repo: Option<&Repo> = repos.first().copied();
        let repo_id = repo.map(|r| r.id.clone());
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

        // The worktrees: one per repo, with the default repo's names.
        let mut setup = Vec::new();
        // (folder name, branch, each repo's worktree)
        let mut worktree: Option<(String, String, Vec<PathBuf>)> = None;
        if let Some(repo) = repo.filter(|_| !new.no_worktree) {
            let branch_name = name_format(&repo.git.branch_format, key.as_deref(), &slug, &title);
            let wt_name = name_format(&repo.git.worktree_name, key.as_deref(), &slug, &title);
            match &adopt {
                Some(path) => {
                    if repos.len() > 1 {
                        return Err(CoreError::InvalidPath(
                            "adopt a worktree with one repo; add the others afterwards".into(),
                        ));
                    }
                    let location = self.repos().require(&repo.id)?;
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
                    let branch = found.branch.unwrap_or(branch_name);
                    worktree = Some((name, branch, vec![path]));
                }
                None => {
                    let (paths, steps) =
                        self.add_worktrees(&config, &repos, &new.code, &wt_name, &branch_name)?;
                    setup = steps;
                    worktree = Some((wt_name, branch_name, paths));
                }
            }
        }

        // The note.
        let mut changes = Vec::new();
        let mut cursor = None;
        let path =
            match &existing_note {
                Some(note) => {
                    self.vault().resolve(note)?;
                    note.clone()
                }
                None => {
                    let folder = config.tickets_folder.as_str();
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
                        changes.extend(self.create_file(
                            &path,
                            Some(&crate::session::with_created_property(&text)),
                        )?);
                    }
                    path
                }
            };

        // The workspace.
        let cwd = match worktree.as_ref().and_then(|(_, _, paths)| paths.first()) {
            Some(p) => p.display().to_string(),
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
        // `repos:` are where it has worktrees: none without one.
        if let Some((_, _, paths)) = &worktree {
            let ids = repo_ids[..paths.len()].to_vec();
            props.push(("repos", Some(Prop::List(ids))));
        }
        props.push(("repo", None));
        if let Some((name, branch, _)) = &worktree {
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
        // Every worktree is checked before any goes.
        if !force {
            let problems = self.worktree_warnings(&config, &ticket)?;
            if !problems.is_empty() {
                return Err(CoreError::Conflict(format!(
                    "Not closed: {}.",
                    problems.join("; ")
                )));
            }
        }
        for r in &ticket.repos {
            let Some(wt) = r.worktree_path.as_deref().map(Path::new) else {
                continue;
            };
            if wt.exists() {
                let location = self.repos().require(&r.id)?;
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
            (Some(_), Some(name), Some(branch)) => {
                // Back in each repo whose worktree is gone.
                let repos: Vec<&Repo> = ticket
                    .repos
                    .iter()
                    .map(|r| config.repo(&r.id))
                    .collect::<Result<_>>()?;
                let missing: Vec<&Repo> = repos
                    .iter()
                    .copied()
                    .filter(|r| {
                        self.repos()
                            .get(&r.id)
                            .is_none_or(|l| !l.worktree(name).exists())
                    })
                    .collect();
                let (_, steps) =
                    self.add_worktrees(&config, &missing, &ticket.code, name, branch)?;
                setup = steps;
                self.repos()
                    .require(&repos[0].id)?
                    .worktree(name)
                    .display()
                    .to_string()
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

    /// Adds a worktree named `name` on `branch` in each repo, with their
    /// setup. Every repo must be located and free of the name first; if one
    /// fails, those already made are taken away again.
    fn add_worktrees(
        &self,
        config: &Config,
        repos: &[&Repo],
        code: &[String],
        name: &str,
        branch: &str,
    ) -> Result<(Vec<PathBuf>, Vec<SetupStep>)> {
        let mut planned = Vec::new();
        for repo in repos {
            let location = self.repos().require(&repo.id)?;
            let path = location.worktree(name);
            if path.exists() {
                return Err(CoreError::AlreadyExists(path.display().to_string()));
            }
            planned.push((*repo, location, path));
        }
        let mut made: Vec<(PathBuf, PathBuf)> = Vec::new();
        let mut setup = Vec::new();
        for (repo, location, path) in &planned {
            if let Err(e) = git::add_worktree(location.path(), path, branch, &repo.git.base_branch)
            {
                for (checkout, wt) in &made {
                    let _ = git::remove_worktree(checkout, wt, true);
                }
                return Err(e);
            }
            made.push((location.path().to_path_buf(), path.clone()));
            copy_ignored(repo, location.path(), path);
            setup.extend(setup_steps(config, repo, code, &location.path, path));
        }
        Ok((planned.into_iter().map(|(_, _, p)| p).collect(), setup))
    }

    /// Gives an active ticket a worktree in another repo, on its branch (or,
    /// for a ticket with none yet, a branch named by that repo's formats).
    /// The first repo becomes the default, and the workspace starts there.
    /// The setup is for the new worktree only.
    pub fn add_ticket_repo(&self, path: &str, repo: &str) -> Result<CreatedTicket> {
        let config = self.config()?;
        let ticket = self.ticket(path)?;
        if !ticket.is_active() {
            return Err(CoreError::Conflict(format!(
                "{} is closed; restore it first",
                ticket.title
            )));
        }
        let repo = config.repo(repo.trim())?;
        // An older ticket can name a repo without having a worktree in it.
        let has_worktrees = ticket.worktree.is_some() && ticket.branch.is_some();
        if has_worktrees && ticket.repos.iter().any(|r| r.id == repo.id) {
            return Err(CoreError::Conflict(format!(
                "{} already has a worktree in {}",
                ticket.title, repo.id
            )));
        }
        let (name, branch, new_names) = match (&ticket.worktree, &ticket.branch) {
            (Some(w), Some(b)) => (w.clone(), b.clone(), false),
            _ => {
                let stem = file_stem(path);
                let title = ticket
                    .key
                    .as_deref()
                    .map_or(stem, |k| stem.strip_prefix(k).map_or(stem, str::trim_start));
                let slug = slugify(title);
                let key = ticket.key.as_deref();
                (
                    name_format(&repo.git.worktree_name, key, &slug, title),
                    name_format(&repo.git.branch_format, key, &slug, title),
                    true,
                )
            }
        };
        let (paths, setup) = self.add_worktrees(&config, &[repo], &ticket.code, &name, &branch)?;

        let mut ids: Vec<String> = Vec::new();
        if has_worktrees {
            ids.extend(ticket.repos.iter().map(|r| r.id.clone()));
        }
        ids.push(repo.id.clone());
        let mut props: Vec<(&str, Option<Prop>)> =
            vec![("repos", Some(Prop::List(ids))), ("repo", None)];
        if new_names {
            props.push(("worktree", Some(Prop::text(&name))));
            props.push(("branch", Some(Prop::text(&branch))));
        }
        let mut changes = self.set_properties(path, &props)?;

        // The first worktree is where the workspace starts.
        let first = !has_worktrees || ticket.repos.is_empty();
        let cwd = paths[0].display().to_string();
        let workspace = match ticket
            .workspace
            .as_deref()
            .and_then(|id| self.workspaces().list().into_iter().find(|w| w.id == id))
        {
            Some(ws) if first => Some(self.workspaces().update(
                &ws.id,
                &crate::workspaces::WorkspaceChange {
                    cwd: Some(&cwd),
                    ..Default::default()
                },
            )?),
            Some(ws) => Some(ws),
            None => {
                let (ws, ch) = self.note_workspace(path)?;
                changes.extend(ch);
                Some(ws)
            }
        };
        Ok(CreatedTicket {
            ticket: self.ticket(path)?,
            workspace,
            setup,
            cursor: None,
            changes,
        })
    }

    /// Takes a repo off a ticket: removes its worktree (refusing, unless
    /// `force`, when it has uncommitted changes; the branch stays, so adding
    /// the repo again brings the committed work back) and drops it from `repos:`. When it
    /// was the default, the next repo becomes the default and the workspace
    /// starts there, or in the note's folder when none is left. Returns the
    /// workspace if it changed, and the removed worktree's path, whose
    /// terminals the caller ends.
    pub fn remove_ticket_repo(
        &self,
        path: &str,
        repo: &str,
        force: bool,
    ) -> Result<RemovedTicketRepo> {
        let config = self.config()?;
        let ticket = self.ticket(path)?;
        let Some(index) = ticket.repos.iter().position(|r| r.id == repo.trim()) else {
            return Err(CoreError::NotFound(format!(
                "{} has no worktree in {}",
                ticket.title,
                repo.trim()
            )));
        };
        let removed = ticket.repos[index].clone();
        let worktree = removed
            .worktree_path
            .as_deref()
            .map(Path::new)
            .filter(|wt| ticket.is_active() && wt.exists());
        if let Some(wt) = worktree {
            // Its commits stay on the branch, so only changes not yet
            // committed would be lost.
            // (`repos.yml` may no longer list the repo: whether it's dirty
            // doesn't depend on the base branch.)
            let base = config
                .repo(&removed.id)
                .map_or_else(|_| "main".to_string(), |r| r.git.base_branch.clone());
            if !force && git::state(wt, &base).dirty {
                return Err(CoreError::Conflict(format!(
                    "{} not removed: it has uncommitted changes.",
                    removed.id
                )));
            }
            let location = self.repos().require(&removed.id)?;
            git::remove_worktree(location.path(), wt, force)?;
        }

        let rest: Vec<String> = ticket
            .repos
            .iter()
            .filter(|r| r.id != removed.id)
            .map(|r| r.id.clone())
            .collect();
        let list = (!rest.is_empty()).then_some(Prop::List(rest));
        let changes = self.set_properties(path, &[("repos", list), ("repo", None)])?;

        let workspace = match &ticket.workspace {
            Some(id) if index == 0 && ticket.is_active() => {
                let cwd = ticket
                    .repos
                    .get(1)
                    .and_then(|r| r.worktree_path.clone())
                    .filter(|wt| Path::new(wt).is_dir())
                    .unwrap_or_else(|| self.default_folder(path));
                if self.workspaces().list().iter().any(|w| &w.id == id) {
                    Some(self.workspaces().update(
                        id,
                        &crate::workspaces::WorkspaceChange {
                            cwd: Some(&cwd),
                            ..Default::default()
                        },
                    )?)
                } else {
                    None
                }
            }
            _ => None,
        };
        Ok(RemovedTicketRepo {
            ticket: self.ticket(path)?,
            workspace,
            worktree: worktree.map(|wt| wt.display().to_string()),
            changes,
        })
    }

    /// Moves every ticket note that isn't in the vault's tickets folder into
    /// it, with its subnotes, rewriting links to them. A ticket that belonged
    /// to a project only by sitting in its folder gets that project in
    /// `projects:` first, so it stays in it. Folders the move leaves empty
    /// go to the Trash.
    pub fn gather_tickets(&self) -> Result<(Vec<MovedNote>, Vec<FileChange>)> {
        let config = self.config()?;
        let folder = config.tickets_folder.clone();
        let prefix = format!("{folder}/");
        let mut paths: Vec<String> = self
            .tickets(&TicketFilter {
                status: Some("all".into()),
                ..Default::default()
            })?
            .into_iter()
            .map(|t| t.path)
            .filter(|p| !p.starts_with(&prefix))
            .collect();
        paths.sort();
        let mut moved = Vec::new();
        let mut changes = Vec::new();
        let mut left: Vec<String> = Vec::new();
        for path in paths {
            if let Some(project) = config.project_of_folder(&path) {
                let linked = linked_projects_in(&self.index(), &config, &path);
                if !linked.contains(&project.id) {
                    let mut values: Vec<String> = {
                        let index = self.index();
                        let fm = index.note(&path).and_then(|n| n.frontmatter.as_ref());
                        fm_list(fm, "projects")
                    };
                    values.push(self.project_link(project, &path));
                    changes.extend(
                        self.set_properties(&path, &[("projects", Some(Prop::List(values)))])?,
                    );
                }
            }
            let to = self.available_path(&folder, file_stem(&path), ".md");
            let (_, ch) = self.rename(&path, &to)?;
            changes.extend(ch);
            if let Some((parent, _)) = path.rsplit_once('/')
                && !left.iter().any(|l| l == parent)
            {
                left.push(parent.to_string());
            }
            moved.push(MovedNote { from: path, to });
        }
        // The emptied folders, innermost first, stopping at a project's own.
        left.sort_by_key(|f| std::cmp::Reverse(f.len()));
        for mut dir in left {
            loop {
                let full = self.vault().root().join(&dir);
                let empty = std::fs::read_dir(&full)
                    .is_ok_and(|entries| entries.flatten().all(|e| e.file_name() == ".DS_Store"));
                if !empty || config.projects.iter().any(|p| p.folder == dir) {
                    break;
                }
                changes.extend(self.delete(&dir)?);
                match dir.rsplit_once('/') {
                    Some((parent, _)) => dir = parent.to_string(),
                    None => break,
                }
            }
        }
        Ok((moved, changes))
    }

    /// Makes one of the ticket's repos its default: first in `repos:`, and
    /// where its workspace starts when the worktree is there. Returns the
    /// workspace if it changed.
    pub fn set_ticket_default_repo(
        &self,
        path: &str,
        repo: &str,
    ) -> Result<(Ticket, Option<Workspace>, Vec<FileChange>)> {
        let ticket = self.ticket(path)?;
        let Some(chosen) = ticket.repos.iter().find(|r| r.id == repo.trim()) else {
            return Err(CoreError::NotFound(format!(
                "{} has no worktree in {repo}",
                ticket.title
            )));
        };
        let mut ids = vec![chosen.id.clone()];
        ids.extend(
            ticket
                .repos
                .iter()
                .filter(|r| r.id != chosen.id)
                .map(|r| r.id.clone()),
        );
        let changes =
            self.set_properties(path, &[("repos", Some(Prop::List(ids))), ("repo", None)])?;
        let workspace = match (&ticket.workspace, &chosen.worktree_path) {
            (Some(id), Some(wt)) if Path::new(wt).is_dir() => Some(self.workspaces().update(
                id,
                &crate::workspaces::WorkspaceChange {
                    cwd: Some(wt),
                    ..Default::default()
                },
            )?),
            _ => None,
        };
        Ok((self.ticket(path)?, workspace, changes))
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
            .flat_map(|t| t.repos)
            .filter_map(|r| r.worktree_path.map(PathBuf::from))
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
        // In one of a ticket's worktrees, that repo; for the note, its default.
        let repo_id = repo_id.or_else(|| ticket.as_ref().and_then(|t| t.repo.clone()));
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
        // Each of the ticket's worktrees that's on disk, by repo.
        let worktrees: HashMap<String, String> = ticket
            .iter()
            .flat_map(|t| &t.repos)
            .filter_map(|r| {
                let wt = r.worktree_path.clone()?;
                Path::new(&wt).is_dir().then(|| (r.id.clone(), wt))
            })
            .collect();
        // Where the code is: the ticket's worktree in this repo if it's on
        // disk, else the folder we were asked about, else the main checkout.
        let worktree = repo.and_then(|r| worktrees.get(&r.id).cloned());
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
            let root = match worktrees.get(&r.id) {
                Some(wt) => Some(PathBuf::from(wt)),
                None if Some(r.id.as_str()) == repo.map(|r| r.id.as_str()) => code_root.clone(),
                None => None,
            };
            let abs = root.map(|root| root.join(&c.path).display().to_string());
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
            worktree.as_deref(),
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
        worktree: Option<&str>,
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
        let worktree = worktree.map(str::to_string);
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
        // VS Code: the worktree we're in, and for a ticket in several repos,
        // all of them in one window (each with its own changes in Source
        // Control) and each of the others on its own.
        let code = vscode_cli();
        let on_disk: Vec<(&str, &String)> = ticket
            .iter()
            .flat_map(|t| &t.repos)
            .filter_map(|r| {
                let wt = r.worktree_path.as_ref()?;
                Path::new(wt).is_dir().then_some((r.id.as_str(), wt))
            })
            .collect();
        let repo_name = |id: &str| {
            config
                .repos
                .get(id)
                .map_or(id.to_string(), |r| r.display_name().to_string())
        };
        if let Some(w) = &worktree {
            let label = match repo {
                Some(r) if on_disk.len() > 1 => format!("Open {} in VS Code", r.display_name()),
                _ => "Open in VS Code".into(),
            };
            actions.push(Action {
                id: "open-vscode".into(),
                label,
                kind: "shell".into(),
                run: format!("{code} {}", shell_quote(w)),
                inputs: Vec::new(),
                cwd: w.clone(),
                source: "built-in".into(),
            });
        }
        if on_disk.len() > 1 {
            let folders: Vec<String> = on_disk.iter().map(|(_, p)| shell_quote(p)).collect();
            actions.push(Action {
                id: "open-vscode-ticket".into(),
                label: "Open all worktrees in VS Code".into(),
                kind: "shell".into(),
                run: format!("{code} -n {}", folders.join(" ")),
                inputs: Vec::new(),
                cwd: on_disk[0].1.clone(),
                source: "built-in".into(),
            });
        }
        for (id, wt) in &on_disk {
            if Some(*wt) == worktree.as_ref() {
                continue;
            }
            actions.push(Action {
                id: format!("open-vscode:{id}"),
                label: format!("Open {} in VS Code", repo_name(id)),
                kind: "shell".into(),
                run: format!("{code} {}", shell_quote(wt)),
                inputs: Vec::new(),
                cwd: (*wt).clone(),
                source: "built-in".into(),
            });
        }
        if let Some(url) = ticket.and_then(|t| t.url.clone()) {
            actions.push(Action {
                id: "open-ticket".into(),
                label: "Open Jira ticket".into(),
                kind: "url".into(),
                run: url,
                inputs: Vec::new(),
                cwd: default_cwd.clone(),
                source: "built-in".into(),
            });
        }
        let mut add =
            |def: &ActionDef, source: String, vars: &HashMap<String, String>, cwd: &str| {
                if !matches!(
                    def.kind.as_str(),
                    "shell" | "terminal" | "url" | "agent" | ""
                ) {
                    return;
                }
                let agent = def.kind == "agent";
                let run = if agent {
                    // The answers come later: their tags stay as they are.
                    let mut vars = vars.clone();
                    for name in def.input.keys() {
                        vars.insert(format!("input.{name}"), format!("{{{{input.{name}}}}}"));
                    }
                    let prompt = match (&def.prompt, &def.prompt_file) {
                        (Some(p), _) => Some(p.clone()),
                        (None, Some(file)) => self
                            .vault()
                            .resolve(file)
                            .ok()
                            .and_then(|path| std::fs::read_to_string(path).ok()),
                        (None, None) => None,
                    };
                    match prompt.and_then(|p| expand(&p, &vars)) {
                        Some(p) => p,
                        None => return,
                    }
                } else {
                    match expand(&def.run, vars) {
                        Some(run) => run,
                        None => return,
                    }
                };
                let inputs = def
                    .input
                    .iter()
                    .filter(|_| agent)
                    .map(|(name, label)| ActionInput {
                        name: name.clone(),
                        label: label.clone(),
                    })
                    .collect();
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
                    inputs,
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
    pub(crate) fn project_link(&self, project: &Project, source: &str) -> String {
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

/// A `copy:` or `link:` entry as a path inside the checkout, or `None` for
/// one that's empty or would leave it.
fn inside_checkout(rel: &str) -> Option<&Path> {
    let rel = Path::new(rel.trim());
    let leaves = rel.as_os_str().is_empty()
        || rel.is_absolute()
        || rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir));
    (!leaves).then_some(rel)
}

/// Brings the repo's files git ignores into a new worktree: `link:` ones as
/// symlinks to the checkout's, then `copy:` ones copied. Anything already
/// there is left; missing ones, and paths that would leave the checkout, are
/// skipped.
fn copy_ignored(repo: &Repo, checkout: &Path, worktree: &Path) {
    for rel in repo.link.iter().filter_map(|r| inside_checkout(r)) {
        let (from, to) = (checkout.join(rel), worktree.join(rel));
        if from.exists() && to.symlink_metadata().is_err() {
            if let Some(dir) = to.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::os::unix::fs::symlink(&from, &to);
        }
    }
    fn copy(from: &Path, to: &Path) -> std::io::Result<()> {
        if from.is_dir() {
            std::fs::create_dir_all(to)?;
            for entry in std::fs::read_dir(from)? {
                let entry = entry?;
                copy(&entry.path(), &to.join(entry.file_name()))?;
            }
        } else if !to.exists() {
            if let Some(dir) = to.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::copy(from, to)?;
        }
        Ok(())
    }
    for rel in repo.copy.iter().filter_map(|r| inside_checkout(r)) {
        let from = checkout.join(rel);
        if from.exists() {
            let _ = copy(&from, &worktree.join(rel));
        }
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

/// How to run VS Code's `code` command, quoted for a shell. Its app bundle
/// carries the CLI, so this works without "Install 'code' command in PATH";
/// with no VS Code in the usual places, plain `code` from the login shell.
pub fn vscode_cli() -> String {
    let bundle = "Visual Studio Code.app/Contents/Resources/app/bin/code";
    let mut places = vec![PathBuf::from("/Applications").join(bundle)];
    if let Some(home) = dirs::home_dir() {
        places.push(home.join("Applications").join(bundle));
    }
    places
        .into_iter()
        .find(|p| p.is_file())
        .map_or_else(|| "code".into(), |p| shell_quote(&p.to_string_lossy()))
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

        /// A second repo, `acme-infra`, located beside the first.
        fn infra(&self) -> PathBuf {
            let dir = self.dir.path().join("infra");
            fs::create_dir_all(&dir).unwrap();
            let repo = git::tests::repo_with_origin(&dir);
            self.session
                .repos()
                .locate("acme-infra", repo.to_str().unwrap(), None)
                .unwrap();
            repo.with_file_name("repo-worktrees")
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
    fn the_config_is_kept_until_it_changes() {
        let t = Setup::new();
        let vault = t.dir.path().join("vault");
        assert_eq!(t.session.config().unwrap().projects.len(), 1);
        // Its files changing is seen without being told.
        fs::write(
            vault.join("Projects/Acme/.groundwork.yml"),
            "name: Acme Co
",
        )
        .unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        fs::File::options()
            .write(true)
            .open(vault.join("Projects/Acme/.groundwork.yml"))
            .unwrap()
            .set_modified(later)
            .unwrap();
        assert_eq!(t.session.config().unwrap().projects[0].name, "Acme Co");
        // A project folder going too.
        fs::rename(vault.join("Projects/Acme"), vault.join("Projects/Gone")).unwrap();
        assert_eq!(
            t.session.config().unwrap().projects[0].folder,
            "Projects/Gone"
        );
        // A new one made outside comes through the watcher (`apply_external`).
        fs::create_dir(vault.join("Trips")).unwrap();
        fs::write(
            vault.join("Trips/.groundwork.yml"),
            "name: Trips
",
        )
        .unwrap();
        assert_eq!(t.session.config().unwrap().projects.len(), 1, "kept");
        t.session.apply_external(&["Trips/.groundwork.yml".into()]);
        assert_eq!(t.session.config().unwrap().projects.len(), 2);
        // And a folder arriving with a project in it.
        fs::create_dir_all(vault.join("Moved in")).unwrap();
        fs::write(vault.join("Moved in/.groundwork.yml"), "").unwrap();
        fs::write(vault.join("Moved in/Plan.md"), "# Plan\n").unwrap();
        t.session.apply_external(&["Moved in".into()]);
        assert_eq!(t.session.config().unwrap().projects.len(), 3);
    }

    #[test]
    fn folders_become_projects() {
        let t = Setup::new();
        // A new one gets its folder and an overview note.
        let (p, changes) = t.session.create_project("Projects/Test Project").unwrap();
        assert_eq!(p.id, "test-project");
        assert_eq!(p.name, "Test Project");
        assert_eq!(
            p.overview.as_deref(),
            Some("Projects/Test Project/Test Project.md")
        );
        assert!(changes.iter().any(|c| c.path == "Projects/Test Project"));
        assert!(
            t.read("Projects/Test Project/Test Project.md")
                .contains("type: project")
        );
        assert_eq!(
            t.read("Projects/Test Project/.groundwork.yml"),
            "name: Test Project\noverview: Test Project.md\n"
        );

        // An existing folder keeps its notes; its own note is the overview.
        fs::create_dir(t.dir.path().join("vault/Contacts/Team")).unwrap();
        let (p, changes) = t.session.create_project("Contacts").unwrap();
        assert_eq!(p.overview, None);
        assert!(changes.is_empty());
        assert_eq!(t.read("Contacts/.groundwork.yml"), "name: Contacts\n");
        fs::write(t.dir.path().join("vault/Contacts/Team/Team.md"), "").unwrap();
        let (p, _) = t.session.create_project("Contacts/Team").unwrap();
        assert_eq!(p.overview.as_deref(), Some("Contacts/Team/Team.md"));

        // Not twice, not the vault, not a file.
        assert!(matches!(
            t.session.create_project("Projects/Acme"),
            Err(CoreError::Conflict(_))
        ));
        assert!(t.session.create_project("").is_err());
        assert!(t.session.create_project("Welcome.md").is_err());
        assert!(t.session.create_project("../outside").is_err());
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
        // Files git ignores: copied in, or linked to the checkout's
        // (.claude/settings.local.json is missing: skipped).
        fs::write(s.repo.join(".env"), "PORT=1\n").unwrap();
        fs::create_dir_all(s.repo.join("config/local")).unwrap();
        fs::write(s.repo.join("config/local/keys.json"), "{}").unwrap();
        fs::write(s.repo.join("CLAUDE.local.md"), "Never push.\n").unwrap();
        let created = s.session.create_ticket(&new).unwrap();
        let t = &created.ticket;
        let copied = PathBuf::from(t.worktree_path.as_ref().unwrap());
        assert_eq!(fs::read_to_string(copied.join(".env")).unwrap(), "PORT=1\n");
        assert!(copied.join("config/local/keys.json").is_file());
        assert_eq!(
            fs::read_link(copied.join("CLAUDE.local.md")).unwrap(),
            fs::canonicalize(&s.repo).unwrap().join("CLAUDE.local.md")
        );
        // One file: a change in the checkout shows in the worktree.
        fs::write(s.repo.join("CLAUDE.local.md"), "Never push. Ever.\n").unwrap();
        assert_eq!(
            fs::read_to_string(copied.join("CLAUDE.local.md")).unwrap(),
            "Never push. Ever.\n"
        );
        assert!(!copied.join(".claude").exists());
        assert_eq!(t.path, "Tickets/TEAM-200 Fix signup.md");
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
        assert_eq!(adhoc.ticket.path, "Tickets/Try new cache.md");
        assert_eq!(adhoc.ticket.branch.as_deref(), Some("try-new-cache"));
        assert!(adhoc.ticket.projects.is_empty() && adhoc.ticket.key.is_none());

        // No repo: a note in the tickets folder, a workspace in the project's.
        let plain = s
            .session
            .create_ticket(&NewTicket {
                title: Some("Plan offsite".into()),
                projects: vec!["acme".into()],
                no_worktree: true,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(plain.ticket.path, "Tickets/Plan offsite.md");
        assert_eq!(plain.ticket.projects, ["acme"]);
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
        assert_eq!(adopted.ticket.path, "Tickets/TEAM-300 Hotfix.md");
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
                "summarise",
                "storybook",
                "acme-platform:web:dev",
                "acme-platform:web:test"
            ]
        );
        let finder = &ctx.actions[2];
        assert_eq!(finder.run, format!("open \"{}\"", wt.display()));
        let storybook = &ctx.actions[4];
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

    #[test]
    fn a_ticket_spans_repos_with_one_workspace() {
        let s = Setup::new();
        s.locate();
        let infra = s.infra();

        // Code in two repos: a worktree in each, on one branch, one workspace.
        let created = s
            .session
            .create_ticket(&NewTicket {
                code: vec!["acme-platform:web".into(), "acme-infra:network".into()],
                ..new_ticket("TEAM-500", "Move login")
            })
            .unwrap();
        let t = &created.ticket;
        let web = s.worktrees().join("TEAM-500-move-login");
        let net = infra.join("TEAM-500-move-login");
        assert!(web.join("README.md").is_file() && net.join("README.md").is_file());
        assert_eq!(t.repo.as_deref(), Some("acme-platform"));
        assert_eq!(
            t.repos,
            [
                TicketRepo {
                    id: "acme-platform".into(),
                    worktree_path: Some(web.display().to_string())
                },
                TicketRepo {
                    id: "acme-infra".into(),
                    worktree_path: Some(net.display().to_string())
                },
            ]
        );
        let setup: Vec<_> = created.setup.iter().map(|s| s.command.as_str()).collect();
        assert_eq!(setup, ["npm install", "terraform init"]);
        let text = s.read(&t.path);
        assert!(
            text.contains("repos: [acme-platform, acme-infra]\n"),
            "{text}"
        );
        assert!(!text.contains("repo:"), "{text}");
        assert_eq!(s.session.workspaces().list().len(), 1);
        let ws = created.workspace.unwrap();
        assert_eq!(
            ws.cwd,
            fs::canonicalize(&web).unwrap().display().to_string()
        );

        // Listed under either repo; git state over both.
        for repo in ["acme-platform", "acme-infra"] {
            let found = s
                .session
                .tickets(&TicketFilter {
                    repo: Some(repo.into()),
                    ..Default::default()
                })
                .unwrap();
            assert!(found.iter().any(|f| f.path == t.path), "{repo}");
        }
        fs::write(net.join("main.tf"), "\n").unwrap();
        let git = s.session.ticket_git(&t.path).unwrap();
        assert!(git.exists && git.dirty && !git.on_remote);

        // Context: components in their own repo's worktree; from inside the
        // infra worktree, that repo.
        let ctx = s.session.context(Some(&t.path), None).unwrap();
        assert_eq!(ctx.repo.as_ref().unwrap().id, "acme-platform");
        let paths: Vec<_> = ctx
            .components
            .iter()
            .map(|c| c.abs_path.clone().unwrap())
            .collect();
        assert_eq!(
            paths,
            [
                web.join("apps/web").display().to_string(),
                net.join("network").display().to_string()
            ]
        );
        assert!(
            ctx.actions.iter().any(
                |a| a.id == "open-vscode:acme-infra" && a.label == "Open Acme infra in VS Code"
            )
        );
        // With two worktrees, the one we're in says which repo it is.
        assert!(ctx.actions.iter().any(|a| a.id == "open-vscode"
            && a.label == "Open Acme platform in VS Code"
            && a.run == format!("{} {}", vscode_cli(), web.display())));
        let both = ctx
            .actions
            .iter()
            .find(|a| a.id == "open-vscode-ticket")
            .unwrap();
        assert_eq!(
            both.run,
            format!("{} -n {} {}", vscode_cli(), web.display(), net.display())
        );
        let inside = s.session.context(None, Some(&net)).unwrap();
        assert_eq!(inside.note.as_deref(), Some(t.path.as_str()));
        let repo = inside.repo.unwrap();
        assert_eq!(repo.id, "acme-infra");
        assert_eq!(repo.worktree_path.as_deref(), Some(net.to_str().unwrap()));

        // The default can move; the workspace follows it.
        let (moved, changed, _) = s
            .session
            .set_ticket_default_repo(&t.path, "acme-infra")
            .unwrap();
        assert_eq!(moved.repo.as_deref(), Some("acme-infra"));
        assert!(
            s.read(&t.path)
                .contains("repos: [acme-infra, acme-platform]\n")
        );
        assert_eq!(changed.unwrap().cwd, net.display().to_string());
        assert!(s.session.set_ticket_default_repo(&t.path, "nope").is_err());

        // Closing checks every worktree before removing any.
        let err = s
            .session
            .close_ticket(&t.path, false)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("in acme-infra, it has uncommitted changes"),
            "{err}"
        );
        assert!(web.exists() && net.exists());
        s.session.close_ticket(&t.path, true).unwrap();
        assert!(!web.exists() && !net.exists());
        let restored = s.session.restore_ticket(&t.path).unwrap();
        assert!(web.exists() && net.exists());
        assert_eq!(restored.setup.len(), 2);
        assert_eq!(
            restored.workspace.unwrap().cwd,
            fs::canonicalize(&net).unwrap().display().to_string()
        );
    }

    #[test]
    fn repos_are_added_to_a_ticket_later() {
        let s = Setup::new();
        s.locate();
        // A repo that isn't located stops a ticket before anything is made.
        let both = NewTicket {
            repos: vec!["acme-platform".into(), "acme-infra".into()],
            ..new_ticket("TEAM-700", "Both")
        };
        assert!(matches!(
            s.session.create_ticket(&both),
            Err(CoreError::RepoNotLocated(r)) if r == "acme-infra"
        ));
        assert!(!s.worktrees().join("TEAM-700-both").exists());
        let infra = s.infra();

        // An older ticket with `repo:` gains a second; it becomes `repos:`.
        let old = "Projects/Acme/Work/TEAM-123 Fix login.md";
        let wt = s.worktrees().join("TEAM-123-fix-login");
        git::add_worktree(&s.repo, &wt, "TEAM-123-fix-login", "main").unwrap();
        assert_eq!(s.session.ticket(old).unwrap().repos.len(), 1);
        let added = s.session.add_ticket_repo(old, "acme-infra").unwrap();
        let ids: Vec<_> = added.ticket.repos.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["acme-platform", "acme-infra"]);
        assert!(infra.join("TEAM-123-fix-login/README.md").is_file());
        assert_eq!(added.setup.len(), 1, "only the new worktree's setup");
        let text = s.read(old);
        assert!(
            text.contains("repos: [acme-platform, acme-infra]\n"),
            "{text}"
        );
        assert!(!text.contains("repo:"), "{text}");
        assert!(text.contains("people: [\"[[Jane Doe]]\"]"), "{text}");
        assert!(
            s.session.add_ticket_repo(old, "acme-infra").is_err(),
            "twice"
        );
        assert!(s.session.add_ticket_repo(old, "nope").is_err());

        // A ticket with no repo yet: its first one names the branch and
        // moves the workspace there.
        let plain = s
            .session
            .create_ticket(&NewTicket {
                key: Some("TEAM-600".into()),
                title: Some("Plan migration".into()),
                projects: vec!["acme".into()],
                no_worktree: true,
                ..Default::default()
            })
            .unwrap();
        assert!(plain.ticket.repos.is_empty());
        let first = s
            .session
            .add_ticket_repo(&plain.ticket.path, "acme-infra")
            .unwrap();
        assert_eq!(
            first.ticket.branch.as_deref(),
            Some("TEAM-600-plan-migration")
        );
        let net = infra.join("TEAM-600-plan-migration");
        assert!(net.is_dir());
        let ws = first.workspace.unwrap();
        assert_eq!(ws.id, plain.workspace.unwrap().id);
        assert_eq!(
            ws.cwd,
            fs::canonicalize(&net).unwrap().display().to_string()
        );
    }

    #[test]
    fn repos_are_added_from_a_checkout() {
        let s = Setup::new();
        let dir = s.dir.path().join("other");
        fs::create_dir_all(&dir).unwrap();
        let checkout = git::tests::repo_with_origin(&dir);
        fs::create_dir_all(checkout.join("src")).unwrap();

        let info = s
            .session
            .add_repo(
                checkout.join("src").to_str().unwrap(),
                Some("Billing API"),
                None,
            )
            .unwrap();
        assert_eq!(info.id, "billing-api");
        assert_eq!(info.name, "Billing API");
        assert_eq!(info.location.unwrap().path, checkout.display().to_string());
        let yml = s.read(".groundwork/repos.yml");
        assert!(
            yml.starts_with("# Code repos"),
            "kept what was there: {yml}"
        );
        assert!(
            yml.ends_with("billing-api:\n  name: Billing API\n  git:\n    base_branch: main\n"),
            "{yml}"
        );
        assert_eq!(
            s.session
                .config()
                .unwrap()
                .repo("billing-api")
                .unwrap()
                .git
                .base_branch,
            "main"
        );
        assert!(s.session.config().unwrap().repo("acme-platform").is_ok());

        // Not twice, by name or by checkout; not somewhere that isn't a repo.
        assert!(
            s.session
                .add_repo(checkout.to_str().unwrap(), None, None)
                .is_err()
        );
        let again = s
            .session
            .add_repo(checkout.to_str().unwrap(), Some("Other name"), None)
            .unwrap_err()
            .to_string();
        assert!(again.contains("already the billing-api repo"), "{again}");
        assert!(
            s.session
                .add_repo(s.dir.path().to_str().unwrap(), None, None)
                .is_err()
        );

        // A ticket can use it straight away.
        let created = s
            .session
            .create_ticket(&NewTicket {
                repos: vec!["billing-api".into()],
                ..new_ticket("TEAM-800", "Bill it")
            })
            .unwrap();
        assert!(Path::new(created.ticket.worktree_path.as_deref().unwrap()).is_dir());
    }

    #[test]
    fn repos_are_removed_from_a_ticket() {
        let s = Setup::new();
        s.locate();
        let infra = s.infra();
        let created = s
            .session
            .create_ticket(&NewTicket {
                repos: vec!["acme-platform".into(), "acme-infra".into()],
                ..new_ticket("TEAM-900", "Both repos")
            })
            .unwrap();
        let path = created.ticket.path.clone();
        let ws = created.workspace.unwrap();
        let web = s.worktrees().join("TEAM-900-both-repos");
        let net = infra.join("TEAM-900-both-repos");

        // Work that would be lost stops it, unless forced.
        fs::write(web.join("scratch.txt"), "x").unwrap();
        let err = s
            .session
            .remove_ticket_repo(&path, "acme-platform", false)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("acme-platform not removed: it has uncommitted changes"),
            "{err}"
        );
        assert!(web.is_dir());
        assert!(s.session.remove_ticket_repo(&path, "nope", false).is_err());

        // The default goes: the next repo is the default, and the workspace
        // starts there. The branch stays.
        let removed = s
            .session
            .remove_ticket_repo(&path, "acme-platform", true)
            .unwrap();
        assert!(!web.exists() && net.is_dir());
        assert_eq!(removed.worktree.as_deref(), Some(web.to_str().unwrap()));
        let ids: Vec<_> = removed.ticket.repos.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["acme-infra"]);
        assert!(s.read(&path).contains("repos: [acme-infra]\n"));
        let moved = removed.workspace.unwrap();
        assert_eq!(moved.id, ws.id);
        assert_eq!(moved.cwd, net.display().to_string());
        let branch = std::process::Command::new("git")
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                "refs/heads/TEAM-900-both-repos",
            ])
            .current_dir(&s.repo)
            .status()
            .unwrap();
        assert!(branch.success(), "the branch stays");

        // The last one: no `repos:` left, the workspace in the note's folder,
        // and adding a repo back makes it the default again.
        let removed = s
            .session
            .remove_ticket_repo(&path, "acme-infra", false)
            .unwrap();
        assert!(!net.exists() && removed.ticket.repos.is_empty());
        let text = s.read(&path);
        assert!(!text.contains("repos:"), "{text}");
        assert!(text.contains("branch: TEAM-900-both-repos"), "{text}");
        assert!(removed.workspace.unwrap().cwd.ends_with("vault/Tickets"));
        let back = s.session.add_ticket_repo(&path, "acme-platform").unwrap();
        assert!(web.is_dir() && !web.join("scratch.txt").exists());
        assert_eq!(
            back.workspace.unwrap().cwd,
            fs::canonicalize(&web).unwrap().display().to_string()
        );
    }

    #[test]
    fn tickets_are_gathered_into_the_tickets_folder() {
        let s = Setup::new();
        // Belongs to Acme only by its folder; its subnote goes with it.
        let only_folder = "Projects/Acme/Work/TEAM-50 Old.md";
        fs::write(
            s.session.vault().root().join(only_folder),
            "---\ntype: ticket\nticket: TEAM-50\nstatus: closed\n---\n# Old\n",
        )
        .unwrap();
        fs::write(
            s.session
                .vault()
                .root()
                .join("Projects/Acme/Work/TEAM-50 Old.web.md"),
            "web notes\n",
        )
        .unwrap();
        fs::write(
            s.session.vault().root().join("Welcome 2.md"),
            "See [[TEAM-50 Old]] and [[Projects/Acme/Work/TEAM-123 Fix login|login]].\n",
        )
        .unwrap();
        s.session.apply_external(&[
            only_folder.into(),
            "Projects/Acme/Work/TEAM-50 Old.web.md".into(),
            "Welcome 2.md".into(),
        ]);
        let before = s
            .session
            .note_projects(&s.session.config().unwrap(), only_folder);
        assert_eq!(before, ["acme"]);

        let (moved, _) = s.session.gather_tickets().unwrap();
        let mut pairs: Vec<_> = moved
            .iter()
            .map(|m| (m.from.as_str(), m.to.as_str()))
            .collect();
        pairs.sort();
        assert_eq!(
            pairs,
            [
                (
                    "Projects/Acme/Work/TEAM-123 Fix login.md",
                    "Tickets/TEAM-123 Fix login.md"
                ),
                (
                    "Projects/Acme/Work/TEAM-50 Old.md",
                    "Tickets/TEAM-50 Old.md"
                ),
            ]
        );
        let root = s.session.vault().root().to_path_buf();
        assert!(root.join("Tickets/TEAM-50 Old.web.md").is_file());
        assert!(
            !root.join("Projects/Acme/Work").exists(),
            "emptied folder goes"
        );
        assert!(root.join("Projects/Acme").is_dir(), "the project's stays");

        // Still in Acme, now by link; the one already linked is unchanged.
        let config = s.session.config().unwrap();
        assert_eq!(
            s.session.note_projects(&config, "Tickets/TEAM-50 Old.md"),
            ["acme"]
        );
        assert!(
            s.read("Tickets/TEAM-50 Old.md")
                .contains("projects: [\"[[Acme]]\"]")
        );
        let login = s.read("Tickets/TEAM-123 Fix login.md");
        assert_eq!(login.matches("[[Acme]]").count(), 1, "{login}");
        assert_eq!(
            s.session
                .note_projects(&config, "Tickets/TEAM-123 Fix login.md"),
            ["acme"]
        );
        // Links to them still resolve.
        let welcome = s.read("Welcome 2.md");
        assert!(welcome.contains("[[TEAM-50 Old]]"), "{welcome}");
        assert!(
            welcome.contains("[[TEAM-123 Fix login|login]]"),
            "{welcome}"
        );
        let index = s.session.index();
        assert_eq!(
            index
                .resolve("TEAM-123 Fix login", "Welcome 2.md")
                .as_deref(),
            Some("Tickets/TEAM-123 Fix login.md")
        );
        drop(index);

        // Nothing left to move.
        assert!(s.session.gather_tickets().unwrap().0.is_empty());
    }
}
