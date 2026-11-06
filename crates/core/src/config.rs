//! Groundwork's vault config: trackers and actions (`.groundwork/config.yml`),
//! code repos and their components (`.groundwork/repos.yml`), and projects
//! (any folder with a `.groundwork.yml`). All of it is portable, so it holds
//! no absolute paths; where repos live on this machine is in [`crate::repos`].

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::{CoreError, Result};

/// Where tickets go when no project claims them.
const DEFAULT_WORK_FOLDER: &str = "Work";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct ConfigFile {
    trackers: Vec<Tracker>,
    work_folder: Option<String>,
    actions: Vec<ActionDef>,
}

/// A ticket tracker such as a Jira project: how its keys look and link.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Tracker {
    pub id: String,
    pub key_pattern: String,
    /// The ticket's web page, with `{{key}}`.
    pub url: String,
    /// The ticket note's name, with `{{key}}` and `{{title}}`.
    pub note_name: String,
    pub template: Option<String>,
}

impl Tracker {
    fn pattern(&self) -> Option<Regex> {
        Regex::new(&format!(r"\b(?:{})\b", self.key_pattern)).ok()
    }

    /// The first key of this tracker in `text` (a key, a URL, a branch name).
    pub fn find_key(&self, text: &str) -> Option<String> {
        Some(self.pattern()?.find(text)?.as_str().to_string())
    }

    pub fn url_for(&self, key: &str) -> String {
        self.url.replace("{{key}}", key)
    }
}

/// A button or menu item. See PLAN §4.7.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ActionDef {
    pub id: String,
    pub label: String,
    /// `shell` (runs quietly), `terminal` (a tab in the workspace) or `agent`
    /// (a Claude Code session in a tab, started with `prompt`).
    pub kind: String,
    pub run: String,
    pub cwd: Option<String>,
    /// Agent: what Claude is asked, with `{{…}}` tags.
    pub prompt: Option<String>,
    /// Agent: the prompt's vault path, instead of `prompt`.
    pub prompt_file: Option<String>,
    /// Agent: what to ask the user first, as name → label; the answers fill
    /// `{{input.<name>}}`.
    pub input: BTreeMap<String, String>,
    /// For a repo's actions: the component it belongs to (`repo:component`).
    pub component: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GitSettings {
    pub base_branch: String,
    pub branch_format: String,
    pub worktree_name: String,
}

impl Default for GitSettings {
    fn default() -> Self {
        Self {
            base_branch: "main".into(),
            branch_format: "{{key}}-{{slug}}".into(),
            worktree_name: "{{key}}-{{slug}}".into(),
        }
    }
}

/// A code repo, from `repos.yml`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Repo {
    /// Its key in `repos.yml`.
    #[serde(skip_deserializing)]
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub git: GitSettings,
    /// Run at the root of every new worktree.
    pub setup: Vec<String>,
    /// Where agents should start reading, relative to the repo.
    pub docs: Vec<String>,
    /// The project tickets with no single project go to.
    pub home_project: Option<String>,
    pub components: BTreeMap<String, Component>,
    pub actions: Vec<ActionDef>,
}

impl Repo {
    pub fn display_name(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.id)
    }
}

/// A part of a repo with its own setup, commands or explanation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Component {
    /// Relative to the repo.
    pub path: String,
    pub description: Option<String>,
    pub setup: Vec<String>,
    pub commands: BTreeMap<String, String>,
    pub docs: Vec<String>,
    pub actions: Vec<ActionDef>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct ProjectFile {
    id: Option<String>,
    name: Option<String>,
    overview: Option<String>,
    work_folder: Option<String>,
    code: Vec<String>,
    tickets: TicketSettings,
    actions: Vec<ActionDef>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TicketSettings {
    pub template: Option<String>,
    #[serde(rename = "match")]
    pub matches: TicketMatch,
}

/// How a new ticket is routed to a project.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TicketMatch {
    pub jira_components: Vec<String>,
    pub labels: Vec<String>,
}

/// A folder with a `.groundwork.yml`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    /// Vault path of the folder.
    pub folder: String,
    /// Vault path of the overview note, if it has one.
    pub overview: Option<String>,
    /// Vault path of the folder its tickets go in.
    pub work_folder: String,
    /// What its work touches: `repo` or `repo:component`.
    pub code: Vec<String>,
    pub tickets: TicketSettings,
    pub actions: Vec<ActionDef>,
}

/// Everything configured for a vault. Finding the projects walks the vault,
/// so the session keeps the last one read (`Session::config`), checking its
/// files haven't changed each time.
#[derive(Debug, Clone, Default)]
pub struct Config {
    pub trackers: Vec<Tracker>,
    /// Vault path of the default folder for tickets.
    pub work_folder: String,
    pub actions: Vec<ActionDef>,
    pub repos: BTreeMap<String, Repo>,
    /// By folder.
    pub projects: Vec<Project>,
}

impl Config {
    /// Reads the vault's config. A file that doesn't parse is an error that
    /// names it, so mistakes don't silently drop projects or repos.
    pub fn load(root: &Path) -> Result<Self> {
        let file: ConfigFile = read_yaml(root, ".groundwork/config.yml")?.unwrap_or_default();
        let mut repos: BTreeMap<String, Repo> =
            read_yaml(root, ".groundwork/repos.yml")?.unwrap_or_default();
        for (id, repo) in &mut repos {
            repo.id = id.clone();
        }
        let mut projects = Vec::new();
        find_projects(root, "", &mut projects)?;
        projects.sort_by(|a, b| a.folder.cmp(&b.folder));
        Ok(Self {
            trackers: file.trackers,
            work_folder: file
                .work_folder
                .unwrap_or_else(|| DEFAULT_WORK_FOLDER.into()),
            actions: file.actions,
            repos,
            projects,
        })
    }

    /// The files it was read from, with when each last changed (`None`:
    /// not there), so a copy kept can tell it's out of date. A new project
    /// folder isn't among them: the watcher reports those.
    pub fn sources(&self, root: &Path) -> Vec<(PathBuf, Option<SystemTime>)> {
        let modified = |path: PathBuf| {
            let time = fs::metadata(&path).and_then(|m| m.modified()).ok();
            (path, time)
        };
        [".groundwork/config.yml", ".groundwork/repos.yml"]
            .into_iter()
            .map(|f| root.join(f))
            .chain(
                self.projects
                    .iter()
                    .map(|p| root.join(&p.folder).join(".groundwork.yml")),
            )
            .map(modified)
            .collect()
    }

    pub fn repo(&self, id: &str) -> Result<&Repo> {
        self.repos
            .get(id)
            .ok_or_else(|| CoreError::NotFound(format!("no repo {id:?} in .groundwork/repos.yml")))
    }

    /// A project by id, name or folder (any case).
    pub fn project(&self, name: &str) -> Option<&Project> {
        let wanted = name.trim().trim_end_matches('/');
        self.projects.iter().find(|p| {
            p.id.eq_ignore_ascii_case(wanted)
                || p.name.eq_ignore_ascii_case(wanted)
                || p.folder == wanted
        })
    }

    /// The project whose folder holds `path`, the innermost if they nest.
    pub fn project_of_folder(&self, path: &str) -> Option<&Project> {
        self.projects
            .iter()
            .filter(|p| path.starts_with(&format!("{}/", p.folder)))
            .max_by_key(|p| p.folder.len())
    }

    /// The tracker a key belongs to.
    pub fn tracker_for(&self, key: &str) -> Option<&Tracker> {
        self.trackers
            .iter()
            .find(|t| t.find_key(key).as_deref() == Some(key))
    }

    /// The first tracker key in `text`, with its tracker.
    pub fn find_key(&self, text: &str) -> Option<(String, &Tracker)> {
        self.trackers
            .iter()
            .find_map(|t| Some((t.find_key(text)?, t)))
    }

    /// `repo:component` as a repo and an optional component.
    pub fn component(&self, code: &str) -> Result<(&Repo, Option<(&str, &Component)>)> {
        let (repo_id, component) = match code.split_once(':') {
            Some((r, c)) => (r, Some(c)),
            None => (code, None),
        };
        let repo = self.repo(repo_id)?;
        match component {
            None => Ok((repo, None)),
            Some(c) => match repo.components.get_key_value(c) {
                Some((id, component)) => Ok((repo, Some((id.as_str(), component)))),
                None => Err(CoreError::NotFound(format!(
                    "repo {repo_id:?} has no component {c:?}"
                ))),
            },
        }
    }
}

/// Whether a vault path is one of the files the config is read from.
pub fn is_config_file(path: &str) -> bool {
    path == ".groundwork/config.yml"
        || path == ".groundwork/repos.yml"
        || path == ".groundwork.yml"
        || path.ends_with("/.groundwork.yml")
}

fn read_yaml<T: serde::de::DeserializeOwned>(root: &Path, rel: &str) -> Result<Option<T>> {
    let text = match fs::read_to_string(root.join(rel)) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    serde_saphyr::from_str(&text)
        .map(Some)
        .map_err(|e| CoreError::Config(format!("{rel}: {e}")))
}

fn find_projects(root: &Path, folder: &str, out: &mut Vec<Project>) -> Result<()> {
    let dir = root.join(folder);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(());
    };
    let join = |name: &str| {
        if folder.is_empty() {
            name.to_string()
        } else {
            format!("{folder}/{name}")
        }
    };
    if !folder.is_empty() {
        let config = format!("{folder}/.groundwork.yml");
        if let Some(file) = read_yaml::<ProjectFile>(root, &config)? {
            out.push(project(folder, file));
        } else if dir.join(".groundwork.yml").is_file() {
            out.push(project(folder, ProjectFile::default()));
        }
    }
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.ends_with(".page") {
            continue;
        }
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            find_projects(root, &join(&name), out)?;
        }
    }
    Ok(())
}

fn project(folder: &str, file: ProjectFile) -> Project {
    let base = folder.rsplit('/').next().unwrap_or(folder);
    let name = file.name.unwrap_or_else(|| base.to_string());
    let inside = |rel: &str| format!("{folder}/{}", rel.trim_matches('/'));
    Project {
        id: file.id.unwrap_or_else(|| slugify(base)),
        overview: file.overview.as_deref().map(inside),
        work_folder: inside(file.work_folder.as_deref().unwrap_or(DEFAULT_WORK_FOLDER)),
        folder: folder.to_string(),
        name,
        code: file.code,
        tickets: file.tickets,
        actions: file.actions,
    }
}

/// Lowercase words joined by `-`: "Fix login!" → "fix-login".
pub fn slugify(text: &str) -> String {
    let mut slug = String::new();
    for c in text.chars() {
        if c.is_alphanumeric() {
            slug.extend(c.to_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.trim_end_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/vault");

    #[test]
    fn reads_the_fixture_config() {
        let config = Config::load(Path::new(FIXTURE)).unwrap();
        assert_eq!(config.work_folder, "Work");
        let tracker = &config.trackers[0];
        assert_eq!(tracker.id, "jira-team");
        assert_eq!(
            tracker.find_key("https://example.atlassian.net/browse/TEAM-123?x=1"),
            Some("TEAM-123".into())
        );
        assert_eq!(tracker.find_key("XTEAM-123"), None);
        assert_eq!(
            tracker.url_for("TEAM-9"),
            "https://example.atlassian.net/browse/TEAM-9"
        );

        let repo = config.repo("acme-platform").unwrap();
        assert_eq!(repo.id, "acme-platform");
        assert_eq!(repo.git.base_branch, "main");
        assert_eq!(repo.components["web"].path, "apps/web");
        let (_, web) = config.component("acme-platform:web").unwrap();
        assert_eq!(web.unwrap().0, "web");
        assert!(config.component("acme-platform:nope").is_err());
        assert!(config.repo("nope").is_err());

        let acme = config.project("acme").unwrap();
        assert_eq!(acme.name, "Acme");
        assert_eq!(acme.folder, "Projects/Acme");
        assert_eq!(acme.overview.as_deref(), Some("Projects/Acme/Acme.md"));
        assert_eq!(acme.work_folder, "Projects/Acme/Work");
        assert_eq!(
            acme.code,
            ["acme-platform:web", "acme-platform:auth-lambda"]
        );
        assert_eq!(acme.tickets.matches.jira_components, ["Acme"]);
        assert_eq!(
            config
                .project_of_folder("Projects/Acme/Work/TEAM-123 Fix login.md")
                .map(|p| p.id.as_str()),
            Some("acme")
        );
        assert!(config.project_of_folder("Projects/Acme").is_none());
    }

    #[test]
    fn bad_config_names_the_file_and_missing_config_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::load(dir.path()).unwrap();
        assert!(config.repos.is_empty() && config.projects.is_empty());

        fs::create_dir_all(dir.path().join("Trip")).unwrap();
        fs::write(dir.path().join("Trip/.groundwork.yml"), "").unwrap();
        let config = Config::load(dir.path()).unwrap();
        assert_eq!(config.projects[0].id, "trip");
        assert_eq!(config.projects[0].work_folder, "Trip/Work");

        fs::create_dir_all(dir.path().join(".groundwork")).unwrap();
        fs::write(dir.path().join(".groundwork/repos.yml"), "a: [").unwrap();
        let err = Config::load(dir.path()).unwrap_err().to_string();
        assert!(err.contains("repos.yml"), "{err}");
    }

    #[test]
    fn slugs() {
        assert_eq!(slugify("Fix login!"), "fix-login");
        assert_eq!(slugify("  Kyoto  Trip "), "kyoto-trip");
        assert_eq!(slugify("Über café"), "über-café");
    }
}
