//! Connecting Groundwork to terminals and Claude Code: the `groundwork`
//! command on PATH, the Claude Code plugin, and the vault the CLI uses by
//! default.
//!
//! Each part reports whether it's set up, missing or stale, so the app can
//! offer to fix it and notice when a pull, a move or another checkout has
//! left something pointing at the wrong place. Nothing is copied: the
//! command is a link to this build's CLI, and Claude Code reads the plugin
//! from this checkout's folder, so rebuilding or pulling updates both.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::{CoreError, Result};

/// The plugin's id: `<plugin>@<marketplace>`, both named `groundwork`.
const MARKETPLACE: &str = "groundwork";
const PLUGIN_ID: &str = "groundwork@groundwork";
const CLI_SETTINGS: &str = "cli.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SetupState {
    /// Set up and current.
    Ok,
    /// Never set up.
    Missing,
    /// Set up, but pointing at another build or folder, or out of date.
    Stale,
    /// Can't be set up from here (e.g. Claude Code isn't installed).
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SetupItem {
    pub state: SetupState,
    /// One sentence on what's set up or what's wrong.
    pub summary: String,
    /// Something worth knowing that doesn't change the state.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Shell commands that do the same by hand.
    pub manual: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SetupStatus {
    /// The `groundwork` command.
    pub cli: SetupItem,
    /// The Claude Code plugin.
    pub plugin: SetupItem,
    /// The vault the CLI uses when nothing else says which.
    pub vault: SetupItem,
}

/// Where everything lives on this machine. `detect` finds the real
/// locations; tests build one pointing at temporary folders.
#[derive(Debug, Clone)]
pub struct SetupEnv {
    /// Folder the `groundwork` link goes in.
    pub bin_dir: PathBuf,
    /// This build's CLI binary.
    pub cli: PathBuf,
    /// Folder containing `.claude-plugin/marketplace.json`.
    pub marketplace: PathBuf,
    /// The `claude` command, if found.
    pub claude: Option<PathBuf>,
    pub data_dir: PathBuf,
}

impl SetupEnv {
    /// The real locations. Each can be overridden by an environment variable
    /// (`GROUNDWORK_BIN_DIR`, `GROUNDWORK_CLI`, `GROUNDWORK_PLUGIN_ROOT`,
    /// `GROUNDWORK_CLAUDE`), which the e2e tests use.
    pub fn detect() -> Self {
        let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(Path::to_path_buf))
            .unwrap_or_default();
        Self {
            bin_dir: var("GROUNDWORK_BIN_DIR").unwrap_or_else(|| "/usr/local/bin".into()),
            // The app and the CLI build into the same folder (`target/debug`,
            // or `Contents/MacOS` once bundled).
            cli: var("GROUNDWORK_CLI").unwrap_or_else(|| exe_dir.join("groundwork")),
            marketplace: var("GROUNDWORK_PLUGIN_ROOT").unwrap_or_else(|| {
                // The app's own copy, once bundled (`make build`), so it
                // doesn't depend on the checkout it was built from; this
                // checkout when running from source.
                let bundled = exe_dir.join("../Resources/claude-marketplace");
                if bundled.join(".claude-plugin/marketplace.json").is_file() {
                    return bundled.canonicalize().unwrap_or(bundled);
                }
                let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
                repo.canonicalize().unwrap_or(repo)
            }),
            claude: var("GROUNDWORK_CLAUDE").or_else(find_claude),
            data_dir: crate::data_dir(),
        }
    }

    fn link(&self) -> PathBuf {
        self.bin_dir.join("groundwork")
    }

    pub fn status(&self, vault: Option<&Path>) -> SetupStatus {
        SetupStatus {
            cli: self.cli_status(),
            plugin: self.plugin_status(),
            vault: self.vault_status(vault),
        }
    }

    // --- The `groundwork` command ------------------------------------------

    fn cli_status(&self) -> SetupItem {
        let link = self.link();
        let manual = vec![format!(
            "ln -sfn {} {}",
            shell_quote(&self.cli),
            shell_quote(&link)
        )];
        let item = |state, summary: String| SetupItem {
            state,
            summary,
            note: self.shadowing_copy(),
            manual: manual.clone(),
        };
        if !self.cli.is_file() {
            return item(
                SetupState::Unavailable,
                format!(
                    "This build has no CLI at {}. Build it with `cargo build -p groundwork-cli` (`make dev` does).",
                    self.cli.display()
                ),
            );
        }
        let Ok(meta) = fs::symlink_metadata(&link) else {
            return item(
                SetupState::Missing,
                format!(
                    "Not installed. Installing links {} to this build.",
                    link.display()
                ),
            );
        };
        if !meta.file_type().is_symlink() {
            return item(
                SetupState::Stale,
                format!(
                    "{} is a separate copy, not a link to this build.",
                    link.display()
                ),
            );
        }
        if same_file(&link, &self.cli) {
            return item(
                SetupState::Ok,
                format!("{} runs this build.", link.display()),
            );
        }
        let target = fs::read_link(&link).unwrap_or_default();
        item(
            SetupState::Stale,
            format!(
                "{} points at {}, not this build.",
                link.display(),
                target.display()
            ),
        )
    }

    /// A copy left by `cargo install` (the old `make install-cli`), which
    /// runs instead whenever `~/.cargo/bin` comes first on PATH.
    fn shadowing_copy(&self) -> Option<String> {
        let copy = dirs::home_dir()?.join(".cargo/bin/groundwork");
        (copy.is_file() && !same_file(&copy, &self.cli)).then(|| {
            format!(
                "There's an older copy at {}. It runs instead if ~/.cargo/bin comes first on PATH; remove it with `cargo uninstall groundwork-cli`.",
                copy.display()
            )
        })
    }

    /// Links the `groundwork` command to this build, asking for an
    /// administrator password if the folder needs one.
    pub fn install_cli(&self) -> Result<()> {
        if !self.cli.is_file() {
            return Err(CoreError::NotFound(self.cli.display().to_string()));
        }
        let link = self.link();
        let direct = (|| {
            fs::create_dir_all(&self.bin_dir)?;
            if fs::symlink_metadata(&link).is_ok() {
                fs::remove_file(&link)?;
            }
            std::os::unix::fs::symlink(&self.cli, &link)
        })();
        match direct {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::PermissionDenied => self.install_cli_as_admin(),
            Err(e) => Err(e.into()),
        }
    }

    fn install_cli_as_admin(&self) -> Result<()> {
        let shell = format!(
            "mkdir -p {} && ln -sfn {} {}",
            shell_quote(&self.bin_dir),
            shell_quote(&self.cli),
            shell_quote(&self.link())
        );
        let script = format!(
            "do shell script \"{}\" with prompt \"Groundwork wants to install the groundwork command.\" with administrator privileges",
            shell.replace('\\', "\\\\").replace('"', "\\\"")
        );
        let out = Command::new("osascript").args(["-e", &script]).output()?;
        if out.status.success() {
            Ok(())
        } else {
            Err(CoreError::Setup(format!(
                "couldn't install the command: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )))
        }
    }

    // --- The Claude Code plugin --------------------------------------------

    fn plugin_manual(&self) -> Vec<String> {
        vec![
            format!(
                "claude plugin marketplace add {}",
                shell_quote(&self.marketplace)
            ),
            format!("claude plugin install {PLUGIN_ID}"),
        ]
    }

    fn plugin_status(&self) -> SetupItem {
        let item = |state, summary: String| SetupItem {
            state,
            summary,
            note: None,
            manual: self.plugin_manual(),
        };
        if self.claude.is_none() {
            return item(
                SetupState::Unavailable,
                "Claude Code isn't installed, or isn't anywhere Groundwork looks.".into(),
            );
        }
        let (source, plugin) = match (self.marketplace_source(), self.installed_plugin()) {
            (Ok(source), Ok(plugin)) => (source, plugin),
            (Err(e), _) | (_, Err(e)) => return item(SetupState::Unavailable, e.to_string()),
        };
        let Some(plugin) = plugin else {
            return item(SetupState::Missing, "Not installed.".into());
        };
        match source {
            Some(source) if same_file(&source, &self.marketplace) => {}
            Some(source) => {
                return item(
                    SetupState::Stale,
                    format!(
                        "Installed from {}, not this copy of Groundwork.",
                        source.display()
                    ),
                );
            }
            None => {
                return item(
                    SetupState::Stale,
                    "Installed, but its marketplace is gone.".into(),
                );
            }
        }
        if !plugin.enabled {
            return item(SetupState::Stale, "Installed but disabled.".into());
        }
        if let Some(available) = plugin.folder_version.filter(|v| *v != plugin.version) {
            return item(
                SetupState::Stale,
                format!(
                    "Version {} is installed; this copy has {available}.",
                    plugin.version
                ),
            );
        }
        let mut ok = item(
            SetupState::Ok,
            format!(
                "Version {}, read from this copy of Groundwork.",
                plugin.version
            ),
        );
        ok.note =
            Some("Skill changes apply to new Claude sessions (or after /reload-plugins).".into());
        ok
    }

    /// Installs the plugin from this copy, replacing one installed from
    /// elsewhere, and enables or updates it as needed.
    pub fn install_plugin(&self) -> Result<()> {
        if self.claude.is_none() {
            return Err(CoreError::Setup("Claude Code isn't installed".into()));
        }
        let source = self.marketplace_source()?;
        let here = source
            .as_deref()
            .is_some_and(|s| same_file(s, &self.marketplace));
        if !here {
            // Removing the marketplace also uninstalls its plugin.
            if source.is_some() {
                self.claude(&["plugin", "marketplace", "remove", MARKETPLACE])?;
            }
            let root = self.marketplace.to_string_lossy();
            self.claude(&["plugin", "marketplace", "add", &root])?;
        }
        match self.installed_plugin()? {
            None => {
                self.claude(&["plugin", "install", PLUGIN_ID])?;
            }
            Some(plugin) => {
                if !plugin.enabled {
                    self.claude(&["plugin", "enable", PLUGIN_ID])?;
                }
                if plugin.folder_version.is_some_and(|v| v != plugin.version) {
                    self.claude(&["plugin", "update", PLUGIN_ID])?;
                }
            }
        }
        Ok(())
    }

    /// The folder the `groundwork` marketplace was added from, if it was.
    fn marketplace_source(&self) -> Result<Option<PathBuf>> {
        let list: Vec<Value> =
            serde_json::from_str(&self.claude(&["plugin", "marketplace", "list", "--json"])?)?;
        Ok(list.iter().find(|m| m["name"] == MARKETPLACE).map(|m| {
            let path = m["path"].as_str().or(m["installLocation"].as_str());
            PathBuf::from(path.unwrap_or_default())
        }))
    }

    fn installed_plugin(&self) -> Result<Option<InstalledPlugin>> {
        let list: Vec<InstalledPlugin> =
            serde_json::from_str(&self.claude(&["plugin", "list", "--json"])?)?;
        Ok(list.into_iter().find(|p| p.id == PLUGIN_ID))
    }

    /// Runs `claude <args>` and returns its stdout.
    fn claude(&self, args: &[&str]) -> Result<String> {
        let claude = self
            .claude
            .as_ref()
            .ok_or_else(|| CoreError::Setup("Claude Code isn't installed".into()))?;
        let out = Command::new(claude)
            .args(args)
            .stdin(Stdio::null())
            .output()?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let msg = if err.trim().is_empty() {
                String::from_utf8_lossy(&out.stdout).into_owned()
            } else {
                err.into_owned()
            };
            return Err(CoreError::Setup(format!(
                "`claude {}` failed: {}",
                args.join(" "),
                msg.trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    // --- The CLI's default vault -------------------------------------------

    /// `Ok` only when the default is the open vault, so the app offers
    /// "Use this vault" otherwise.
    fn vault_status(&self, current: Option<&Path>) -> SetupItem {
        let item = |state, summary: String| SetupItem {
            state,
            summary,
            note: None,
            manual: Vec::new(),
        };
        match default_vault(&self.data_dir) {
            None => item(
                SetupState::Missing,
                "Not set, so the CLI uses whichever vault Groundwork opened last.".into(),
            ),
            Some(path) if !path.is_dir() => item(
                SetupState::Stale,
                format!("{} no longer exists.", path.display()),
            ),
            Some(path) if current.is_some_and(|c| same_file(c, &path)) => {
                item(SetupState::Ok, format!("This vault ({}).", path.display()))
            }
            Some(path) => item(
                SetupState::Missing,
                format!("{}, not this vault.", path.display()),
            ),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledPlugin {
    id: String,
    #[serde(default)]
    version: String,
    #[serde(default = "yes")]
    enabled: bool,
    /// The version in the folder it's read from (directory marketplaces).
    folder_version: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliSettings {
    default_vault: Option<PathBuf>,
}

/// The vault the CLI uses when not told otherwise, if one was chosen.
pub fn default_vault(data_dir: &Path) -> Option<PathBuf> {
    let text = fs::read(data_dir.join(CLI_SETTINGS)).ok()?;
    serde_json::from_slice::<CliSettings>(&text)
        .ok()?
        .default_vault
}

pub fn set_default_vault(data_dir: &Path, vault: &Path) -> Result<()> {
    fs::create_dir_all(data_dir)?;
    let settings = CliSettings {
        default_vault: Some(vault.to_path_buf()),
    };
    fs::write(
        data_dir.join(CLI_SETTINGS),
        serde_json::to_vec_pretty(&settings)?,
    )?;
    Ok(())
}

/// `claude` on PATH or in the places its installers use. Apps opened from
/// the Finder get a minimal PATH, hence the list.
fn find_claude() -> Option<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .chain([
            home.join(".local/bin"),
            home.join(".claude/local"),
            "/opt/homebrew/bin".into(),
            "/usr/local/bin".into(),
            home.join(".npm-global/bin"),
        ])
        .map(|dir| dir.join("claude"))
        .find(|c| c.is_file())
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn shell_quote(path: &Path) -> String {
    let s = path.to_string_lossy();
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c))
    {
        s.into_owned()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for `claude` that keeps its marketplace and plugin state in
    /// files next to itself and logs every call.
    const FAKE_CLAUDE: &str = include_str!("../../../fixtures/bin/claude");

    struct Fixture {
        dir: tempfile::TempDir,
        env: SetupEnv,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let claude = root.join("claude-bin/claude");
            fs::create_dir_all(claude.parent().unwrap()).unwrap();
            fs::write(&claude, FAKE_CLAUDE).unwrap();
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&claude, fs::Permissions::from_mode(0o755)).unwrap();
            let cli = root.join("build/groundwork");
            fs::create_dir_all(cli.parent().unwrap()).unwrap();
            fs::write(&cli, "#!/bin/sh\n").unwrap();
            let marketplace = root.join("checkout");
            write_plugin(&marketplace, "0.1.0");
            let env = SetupEnv {
                bin_dir: root.join("bin"),
                cli,
                marketplace,
                claude: Some(claude),
                data_dir: root.join("data"),
            };
            Self { dir, env }
        }

        fn calls(&self) -> Vec<String> {
            fs::read_to_string(self.dir.path().join("claude-bin/calls"))
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }

        fn clear_calls(&self) {
            let _ = fs::remove_file(self.dir.path().join("claude-bin/calls"));
        }
    }

    fn write_plugin(root: &Path, version: &str) {
        fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        fs::create_dir_all(root.join("claude-plugin/.claude-plugin")).unwrap();
        fs::write(
            root.join(".claude-plugin/marketplace.json"),
            r#"{"name":"groundwork","plugins":[{"name":"groundwork","source":"./claude-plugin"}]}"#,
        )
        .unwrap();
        fs::write(
            root.join("claude-plugin/.claude-plugin/plugin.json"),
            format!(r#"{{"name":"groundwork","version":"{version}"}}"#),
        )
        .unwrap();
    }

    #[test]
    fn links_the_command_to_this_build() {
        let f = Fixture::new();
        assert_eq!(f.env.cli_status().state, SetupState::Missing);
        f.env.install_cli().unwrap();
        assert_eq!(f.env.cli_status().state, SetupState::Ok);
        assert!(same_file(&f.env.link(), &f.env.cli));

        // Another checkout's build: stale until reinstalled.
        let other = f.dir.path().join("other/groundwork");
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::write(&other, "").unwrap();
        fs::remove_file(f.env.link()).unwrap();
        std::os::unix::fs::symlink(&other, f.env.link()).unwrap();
        let stale = f.env.cli_status();
        assert_eq!(stale.state, SetupState::Stale);
        assert!(
            stale.summary.contains("other/groundwork"),
            "{}",
            stale.summary
        );
        f.env.install_cli().unwrap();
        assert_eq!(f.env.cli_status().state, SetupState::Ok);

        // A plain copy is replaced too.
        fs::remove_file(f.env.link()).unwrap();
        fs::write(f.env.link(), "old").unwrap();
        assert_eq!(f.env.cli_status().state, SetupState::Stale);
        f.env.install_cli().unwrap();
        assert_eq!(f.env.cli_status().state, SetupState::Ok);

        let mut unbuilt = f.env.clone();
        unbuilt.cli = f.dir.path().join("nothing/groundwork");
        assert_eq!(unbuilt.cli_status().state, SetupState::Unavailable);
    }

    #[test]
    fn installs_and_repairs_the_plugin() {
        let f = Fixture::new();
        let plugin = || f.env.plugin_status();
        assert_eq!(plugin().state, SetupState::Missing);

        f.env.install_plugin().unwrap();
        assert_eq!(plugin().state, SetupState::Ok, "{}", plugin().summary);
        let root = f.env.marketplace.to_string_lossy().into_owned();
        assert!(
            f.calls()
                .contains(&format!("plugin marketplace add {root}"))
        );
        assert!(
            f.calls()
                .contains(&"plugin install groundwork@groundwork".to_string())
        );

        // A newer version in the folder: update.
        write_plugin(&f.env.marketplace, "0.2.0");
        let stale = plugin();
        assert_eq!(stale.state, SetupState::Stale);
        assert_eq!(
            stale.summary,
            "Version 0.1.0 is installed; this copy has 0.2.0."
        );
        f.clear_calls();
        f.env.install_plugin().unwrap();
        assert_eq!(
            f.calls()
                .iter()
                .filter(|c| !c.contains("list"))
                .collect::<Vec<_>>(),
            ["plugin update groundwork@groundwork"]
        );
        assert_eq!(plugin().state, SetupState::Ok);

        // Disabled: enable.
        fs::write(f.dir.path().join("claude-bin/disabled"), "").unwrap();
        assert_eq!(plugin().summary, "Installed but disabled.");
        f.env.install_plugin().unwrap();
        assert_eq!(plugin().state, SetupState::Ok);

        // Installed from another checkout: replace the marketplace.
        let mut moved = f.env.clone();
        moved.marketplace = f.dir.path().join("new-checkout");
        write_plugin(&moved.marketplace, "0.2.0");
        let stale = moved.plugin_status();
        assert_eq!(stale.state, SetupState::Stale);
        assert!(
            stale.summary.contains("checkout, not this copy"),
            "{}",
            stale.summary
        );
        f.clear_calls();
        moved.install_plugin().unwrap();
        let writes: Vec<_> = f
            .calls()
            .into_iter()
            .filter(|c| !c.contains("list"))
            .collect();
        assert_eq!(
            writes,
            [
                "plugin marketplace remove groundwork".to_string(),
                format!("plugin marketplace add {}", moved.marketplace.display()),
                "plugin install groundwork@groundwork".to_string(),
            ]
        );
        assert_eq!(moved.plugin_status().state, SetupState::Ok);
    }

    #[test]
    fn reports_when_claude_is_missing() {
        let mut f = Fixture::new();
        f.env.claude = None;
        let item = f.env.plugin_status();
        assert_eq!(item.state, SetupState::Unavailable);
        assert_eq!(
            item.manual[1],
            "claude plugin install groundwork@groundwork"
        );
        assert!(f.env.install_plugin().is_err());
    }

    #[test]
    fn remembers_the_default_vault() {
        let f = Fixture::new();
        let vault = f.dir.path().join("vault");
        fs::create_dir_all(&vault).unwrap();
        assert_eq!(f.env.vault_status(Some(&vault)).state, SetupState::Missing);
        set_default_vault(&f.env.data_dir, &vault).unwrap();
        assert_eq!(default_vault(&f.env.data_dir), Some(vault.clone()));
        assert!(
            f.env
                .vault_status(Some(&vault))
                .summary
                .starts_with("This vault")
        );
        let other = f.env.vault_status(None);
        assert_eq!(other.state, SetupState::Missing);
        assert!(other.summary.ends_with("not this vault."));
        fs::remove_dir(&vault).unwrap();
        assert_eq!(f.env.vault_status(None).state, SetupState::Stale);
    }

    #[test]
    fn quotes_paths_for_the_shell() {
        assert_eq!(shell_quote(Path::new("/usr/local/bin")), "/usr/local/bin");
        assert_eq!(shell_quote(Path::new("/a b/it's")), r"'/a b/it'\''s'");
    }
}
