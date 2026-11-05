//! Agent actions (PLAN §4.7): a visible Claude Code session in a terminal,
//! started with a prompt. The vault can override a built-in prompt with
//! `.groundwork/prompts/<name>.md`, and its own `kind: agent` actions give
//! theirs inline (`prompt:`) or in a file (`prompt_file:`). The command bar
//! (PLAN §5.10) starts sessions too, telling Claude what the user had open.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::command_log::{CommandLog, REQUEST_ENV};
use crate::tickets::shell_quote;
use crate::{CoreError, Result, Session};

/// Prompts written for sessions are kept this long, then cleared away.
const KEEP_PROMPTS: Duration = Duration::from_secs(7 * 24 * 60 * 60);

const NEW_TICKET: &str = r#"Set up a ticket in the user's Groundwork vault for this Jira issue: {{input.ticket}}

1. Read the issue with your Jira tools (its summary, description, components and labels). If you can't reach Jira, ask the user for the summary with `groundwork ask`.
2. Run `groundwork project list`, `groundwork repo list` and `groundwork project show <project>` for the likely projects, to see which projects and code it touches.
3. Pick the projects (the first is its home), the code (`repo:component`), a short slug and a title. If the routing isn't clear, confirm it with `groundwork ask` before going on, offering your best guess as a `--choice`.
4. Run `groundwork ticket create --key <KEY> --title "<title>" --slug <slug> --project <id>... --code <repo:component>...`. It makes the note, the branch, the worktree and the workspace.
5. Fill in the note's Summary from the issue, in a few lines, and link the people involved if they're in the vault.
6. Open it for the user with `groundwork open "<note path>"`, then say in one line what you set up.
"#;

const TRIAGE: &str = r#"Triage my todos in Groundwork: the overdue ones and the ones that have sat for two weeks or more. Use the todo triage steps in the groundwork skill: ask me about each through the inbox, then do what I answer.
"#;

/// The built-in prompts, by name.
const BUILT_IN: &[(&str, &str)] = &[("new-ticket", NEW_TICKET), ("triage", TRIAGE)];

/// What the user had open when they used the command bar, as far as they
/// kept it (each is a chip they can turn off).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct AgentContext {
    /// The note they were looking at (a vault path).
    #[ts(optional)]
    pub note: Option<String>,
    /// Their current workspace's name.
    #[ts(optional)]
    pub workspace: Option<String>,
    /// The project (id, name or folder).
    #[ts(optional)]
    pub project: Option<String>,
}

/// The command line for a command bar session, and its request in the
/// command log.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BarCommand {
    pub id: String,
    pub command: String,
}

/// A file's contents, as a shell word.
fn cat(path: &Path) -> String {
    format!("\"$(cat {})\"", shell_quote(&path.display().to_string()))
}

/// Fills in `{{name}}` for each of `vars`; other tags are left as they are.
pub fn fill(prompt: &str, vars: &HashMap<String, String>) -> String {
    let mut out = prompt.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("{{{{{k}}}}}"), v);
    }
    out
}

impl Session {
    /// The prompt called `name`: the vault's `.groundwork/prompts/<name>.md`,
    /// else the built-in one.
    pub fn agent_prompt(&self, name: &str) -> Result<String> {
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(CoreError::InvalidPath(format!("no prompt {name:?}")));
        }
        let own = self
            .vault()
            .root()
            .join(".groundwork/prompts")
            .join(format!("{name}.md"));
        if let Ok(text) = fs::read_to_string(own) {
            return Ok(text);
        }
        BUILT_IN
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, p)| p.to_string())
            .ok_or_else(|| CoreError::NotFound(format!("prompt {name}")))
    }

    /// The command line that starts Claude Code with `prompt` (its `{{tags}}`
    /// filled from `vars`). The prompt goes in a file, so it reaches Claude
    /// whole, however long and whatever it contains.
    pub fn agent_command(&self, prompt: &str, vars: &HashMap<String, String>) -> Result<String> {
        let prompt = fill(prompt, vars);
        if prompt.trim().is_empty() {
            return Err(CoreError::Config("the prompt is empty".into()));
        }
        let prompt_file = write_new(&self.prompts_dir()?, &prompt)?;
        Ok(format!("claude {}", cat(&prompt_file)))
    }

    /// A command bar session: logs the request (`command_log`) and returns
    /// the command line that starts Claude on it, told about the command bar
    /// and what the user pointed it at in its system prompt.
    pub fn bar_command(
        &self,
        prompt: &str,
        context: &AgentContext,
        shown: bool,
    ) -> Result<BarCommand> {
        if prompt.trim().is_empty() {
            return Err(CoreError::Config("the prompt is empty".into()));
        }
        let system = self.command_bar_context(context, shown)?;
        let dir = self.prompts_dir()?;
        let system = write_new(&dir, &system)?;
        let prompt_file = write_new(&dir, prompt)?;
        let id = CommandLog::new(self.vault().root()).ask(prompt, context, shown)?;
        let command = format!(
            "{REQUEST_ENV}={id} claude --append-system-prompt {} {}",
            cat(&system),
            cat(&prompt_file)
        );
        Ok(BarCommand { id, command })
    }

    fn prompts_dir(&self) -> Result<PathBuf> {
        let dir = self.state_dir().join("prompts");
        fs::create_dir_all(&dir)?;
        clear_old(&dir);
        Ok(dir)
    }

    /// What Claude is told about a command bar session. The whole vault is
    /// in scope: it finds what the user means itself. Chips the user turned
    /// on point it at something in particular. It finishes with `groundwork
    /// done`, which logs how it went and, for a one-off, closes its tab.
    pub fn command_bar_context(&self, context: &AgentContext, shown: bool) -> Result<String> {
        let mut text = String::from(
            "The user started this session from Groundwork's command bar: a quick request, \
             typed or dictated, from wherever they were. The working directory is their \
             Groundwork notes vault, and all of it is in scope. Work out what they mean and \
             where it lives yourself, rather than asking them to find it, using the groundwork \
             skill and CLI:\n\
             - Find notes, people, projects and tickets: `groundwork search` (by words), \
             `groundwork search --smart` (by meaning, when smart search is set up), \
             `groundwork who <topic>`, `groundwork project list` / `show`, `groundwork ticket list`.\n\
             - Do things in the app for them: `groundwork ticket create` makes a ticket's note, \
             worktree and workspace; `groundwork workspace open`, `groundwork tab new \
             --workspace <name> --cwd <folder>` and `groundwork open <note>` show things in \
             Groundwork's window.\n\
             - When it's ambiguous or you need a decision, ask with `groundwork ask`, so it \
             reaches their inbox.\n\
             - Trust the app's commands: when `groundwork notify`, `open`, `tab new` or \
             `workspace open` returns without an error, it worked. Don't check up on it, wait for \
             the user to click something, or read terminals back to confirm.\n\
             \n\
             When you've finished, your last step is `groundwork done \"<what you did, in a line \
             or two>\"` (add `--link <note>` for the note it's about). It records the request in \
             the command log, which the user reviews, and puts your summary in their inbox's \
             history (only a request that needs them or failed waits for them there), so don't \
             also `notify`. For a one-off request it then closes this tab once your turn ends, so \
             finished sessions don't pile up. Keep the tab open instead, with `--keep-open`, \
             whenever the user asked you to keep going, stay around or wait for something, or the \
             work carries on (something still running, more to do together). If you couldn't do \
             it, say so with `--outcome failed`; if it's waiting on them, `--outcome needs-you`: \
             both keep the tab open. When in doubt, keep it open. If you carry on later, run \
             `groundwork done` again when you finish.\n",
        );
        text.push_str(if shown {
            "\nThey opened this session on screen (⌘↩), so they're probably watching: keep the \
             tab open when you finish unless they asked you to close it.\n"
        } else {
            "\nThey left this session in the background (↩), so they aren't watching this \
             terminal: what they hear from you is your `groundwork ask` questions and the \
             `groundwork done` summary.\n"
        });
        let mut pointed = Vec::new();
        if let Some(note) = context.note.as_deref().filter(|n| !n.is_empty()) {
            self.vault().resolve(note)?;
            pointed.push(format!(
                "- The note {note} (`groundwork note read {}`)",
                shell_quote(note)
            ));
        }
        if let Some(project) = context.project.as_deref().filter(|p| !p.is_empty()) {
            let config = self.config()?;
            let p = config
                .project(project)
                .ok_or_else(|| CoreError::NotFound(format!("project {project}")))?;
            pointed.push(format!(
                "- The project {} (`groundwork project show {}`), in {}/",
                p.name, p.id, p.folder
            ));
        }
        if let Some(workspace) = context.workspace.as_deref().filter(|w| !w.is_empty()) {
            pointed.push(format!(
                "- Their workspace {workspace} in Groundwork (`groundwork workspace list`)"
            ));
        }
        if !pointed.is_empty() {
            text.push_str(
                "\nThey pointed you at these, so \"this\" or \"here\" probably means them:\n",
            );
            text.push_str(&pointed.join("\n"));
            text.push('\n');
        }
        Ok(text)
    }
}

/// Writes `text` to a new file in `dir`, named for the time.
fn write_new(dir: &Path, text: &str) -> Result<PathBuf> {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut path = dir.join(format!("{now}.md"));
    for n in 1.. {
        if !path.exists() {
            break;
        }
        path = dir.join(format!("{now}-{n}.md"));
    }
    fs::write(&path, text)?;
    Ok(path)
}

fn clear_old(dir: &std::path::Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > KEEP_PROMPTS);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_vault::session;

    #[test]
    fn built_in_prompts_and_the_vaults_own() {
        let (dir, s) = session();
        assert!(
            s.agent_prompt("new-ticket")
                .unwrap()
                .contains("{{input.ticket}}")
        );
        assert!(
            s.agent_prompt("triage")
                .unwrap()
                .contains("Triage my todos")
        );
        assert!(matches!(
            s.agent_prompt("nope"),
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            s.agent_prompt("../x"),
            Err(CoreError::InvalidPath(_))
        ));

        let own = dir.path().join("vault/.groundwork/prompts");
        fs::create_dir_all(&own).unwrap();
        fs::write(own.join("triage.md"), "Only the p1s, please.").unwrap();
        assert_eq!(s.agent_prompt("triage").unwrap(), "Only the p1s, please.");
    }

    #[test]
    fn the_vaults_agent_actions_ask_first() {
        let (_dir, s) = session();
        let context = s
            .context(Some("Projects/Acme/Meetings/2026-11-02 Kickoff.md"), None)
            .unwrap();
        let action = context
            .actions
            .iter()
            .find(|a| a.id == "summarise")
            .unwrap();
        assert_eq!(action.kind, "agent");
        assert_eq!(
            action.run,
            "Summarise [[Projects/Acme/Meetings/2026-11-02 Kickoff.md]] for the Acme project, \
             focusing on {{input.focus}}."
        );
        assert_eq!(action.inputs[0].label, "What should it focus on?");
        // Outside a project, `{{project.name}}` has nothing to fill it.
        let context = s.context(Some("Welcome.md"), None).unwrap();
        assert!(context.actions.iter().all(|a| a.id != "summarise"));
    }

    #[test]
    fn commands_carry_the_prompt_in_a_file() {
        let (_dir, s) = session();
        let vars = HashMap::from([("input.ticket".to_string(), "TEAM-9".to_string())]);
        let command = s
            .agent_command("Set up {{input.ticket}}.\nIt's {{other}}.", &vars)
            .unwrap();
        let path = command
            .strip_prefix("claude \"$(cat ")
            .and_then(|c| c.strip_suffix(")\""))
            .unwrap_or_else(|| panic!("{command}"))
            .trim_matches('\'');
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "Set up TEAM-9.\nIt's {{other}}."
        );
        assert!(matches!(
            s.agent_command("  ", &vars),
            Err(CoreError::Config(_))
        ));
    }

    #[test]
    fn the_command_bar_says_what_was_open() {
        let (_dir, s) = session();
        let context = AgentContext {
            note: Some("Projects/Acme/Meetings/2026-11-02 Kickoff.md".into()),
            workspace: Some("TEAM-12".into()),
            project: Some("acme".into()),
        };
        let BarCommand { id, command } = s.bar_command("Summarise this", &context, false).unwrap();
        let files: Vec<&str> = command
            .strip_prefix(&format!(
                "GROUNDWORK_REQUEST={id} claude --append-system-prompt "
            ))
            .unwrap_or_else(|| panic!("{command}"))
            .split("\"$(cat ")
            .filter_map(|part| Some(part.split_once(")\"")?.0.trim_matches('\'')))
            .collect();
        assert_eq!(files.len(), 2, "{command}");
        let system = fs::read_to_string(files[0]).unwrap();
        assert!(system.contains("Groundwork's command bar"));
        assert!(system.contains("all of it is in scope"));
        assert!(system.contains(
            "- The note Projects/Acme/Meetings/2026-11-02 Kickoff.md \
             (`groundwork note read 'Projects/Acme/Meetings/2026-11-02 Kickoff.md'`)"
        ));
        assert!(
            system
                .contains("- The project Acme (`groundwork project show acme`), in Projects/Acme/")
        );
        assert!(system.contains("- Their workspace TEAM-12 in Groundwork"));
        assert!(system.contains("groundwork done") && system.contains("in the background"));
        assert_eq!(fs::read_to_string(files[1]).unwrap(), "Summarise this");
        // The request is in the command log.
        let logged = CommandLog::new(s.vault().root()).get(&id).unwrap();
        assert_eq!(
            (logged.prompt.as_str(), logged.shown),
            ("Summarise this", false)
        );
        assert_eq!(logged.context, context);

        // With every chip off (as they start), the whole vault.
        let bare = s
            .command_bar_context(&AgentContext::default(), true)
            .unwrap();
        assert!(bare.contains("probably watching"));
        assert!(bare.contains("groundwork search --smart") && bare.contains("groundwork ask"));
        assert!(!bare.contains("They pointed you at"));
        let outside = AgentContext {
            note: Some("../secrets.md".into()),
            ..Default::default()
        };
        assert!(s.command_bar_context(&outside, false).is_err());
        assert!(s.bar_command("Read it", &outside, false).is_err());
        assert!(s.bar_command(" ", &AgentContext::default(), false).is_err());
        assert_eq!(
            CommandLog::new(s.vault().root()).list(10).len(),
            1,
            "nothing else logged"
        );
    }
}
