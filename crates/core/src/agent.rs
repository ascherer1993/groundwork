//! Agent actions (PLAN §4.7): a visible Claude Code session in a terminal,
//! started with a prompt. The vault can override a built-in prompt with
//! `.groundwork/prompts/<name>.md`, and its own `kind: agent` actions give
//! theirs inline (`prompt:`) or in a file (`prompt_file:`).

use std::collections::HashMap;
use std::fs;
use std::time::{Duration, SystemTime};

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
            return Err(CoreError::Config("the action's prompt is empty".into()));
        }
        let dir = self.state_dir().join("prompts");
        fs::create_dir_all(&dir)?;
        clear_old(&dir);
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default();
        let mut path = dir.join(format!("{}.md", now.as_millis()));
        for n in 1.. {
            if !path.exists() {
                break;
            }
            path = dir.join(format!("{}-{n}.md", now.as_millis()));
        }
        fs::write(&path, prompt)?;
        Ok(format!(
            "claude \"$(cat {})\"",
            shell_quote(&path.display().to_string())
        ))
    }
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
}
