# Groundwork

A macOS notes app (Tauri v2 + React) over an Obsidian-compatible vault, adding HTML pages, note-linked terminals/worktrees and Claude Code integration. `PLAN.md` is the source of truth for design and phases; check it before adding features, and keep it updated when a decision changes.

## Layout

- `crates/core` (`groundwork-core`): vault model and file operations. No UI or transport concerns. Projects, repos and tickets: `config.rs` (the YAML config), `repos.rs` (where repos are on this machine), `git.rs`, `tickets.rs` (tickets, context, actions), `frontmatter.rs` (editing properties in place). Git tests make temporary repos with a bare `origin`.
- `crates/protocol` (`groundwork-protocol`): the API `Request` enum, `ApiError`, and other wire types.
- `crates/backend` (`groundwork-backend`): `Backend::handle` dispatches every request. The `dev-server` feature adds the WebSocket host for browser mode. `agents.rs` is the app socket (`<data dir>/groundwork.sock`, `GROUNDWORK_SOCKET` in terminals) through which the CLI reaches the running app, plus the inbox and Claude Code's hook states.
- `crates/cli` (`groundwork-cli`): the `groundwork` command. It works on vault files directly through `Session::open_for_tool`, so the app needn't be running. `make dev` and `make browser` build it next to the app.
- `crates/terminal-daemon` (`groundworkd`): owns terminal sessions so they outlive the app. The backend (`crates/backend/src/terminals.rs`) starts it on demand from beside its own binary and talks to it over `<data dir>/groundworkd.sock`; `make dev`/`make browser` build it with the CLI. Tests never touch your real daemon: Rust tests use temp sockets, e2e uses its own data dir and shuts the daemon down afterwards. The UI side is `app/src/lib/terminals.ts`; docks are in `app/src/state/workspace.ts` (one for notes, one per workspace holding only terminals, all kept mounted; the view shows notes, both side by side, or terminals) and workspaces in `workspaces.ts`, and terminal badges in `state/terminals.ts`.
- `claude-plugin/`: the Claude Code plugin (the `groundwork` skill), listed by `.claude-plugin/marketplace.json` at the repo root. Keep the skill in step with the CLI.
- "Set up Claude Code…" (`crates/core/src/setup.rs`) links the CLI onto PATH, installs the plugin from this checkout, and sets the CLI's default vault. Claude Code reads the plugin live from this folder, so skill edits reach new sessions without reinstalling. Tests and e2e use the fake `fixtures/bin/claude`, never the real one.
- HTML pages run in sandboxed iframes with no origin of their own; they reach the app only through the bridge (`crates/backend/src/bridge.js` ↔ `app/src/lib/pages.ts`). Never add `allow-same-origin` to page frames: our `groundwork://` scheme counts as a trusted origin for Tauri commands.
- `app/src-tauri`: the desktop shell. It exposes one Tauri command, `api`, which forwards to `Backend`.
- `app/src`: the React UI. Call the backend only through `api/client.ts`.
- `app/e2e`: Playwright tests that run against browser mode.
- `fixtures/vault`: the test vault. Extend it whenever you add parsing or linking behaviour.

## Adding an API method

1. Add a variant to `Request` in `crates/protocol`, with a `/// → ResultType` doc comment.
2. Handle it in `Backend::handle`. Put the real logic in `crates/core`.
3. Run `make bindings` to regenerate `app/src/api/generated/`. Commit the generated files; don't edit them by hand.
4. Add the result type to `Results` in `app/src/api/client.ts`, plus a helper on `api`.

## Commands

- `make dev`: run the desktop app. It runs inside a `Groundwork Dev.app` bundle in `target/debug` (`scripts/dev-app`) so macOS shows its notifications.
- `make browser`: run the same UI in a browser at http://localhost:1420.
- `make test`, `make e2e`, `make lint`, `make fmt`.

Before calling a change done, run `make lint test e2e`. For UI changes, also take screenshots in browser mode with Playwright and check both light and dark themes.

## Conventions

- Never write to `.obsidian/`. Groundwork's vault config lives in `.groundwork/`. Machine-local state lives in `groundwork_core::data_dir()`, which tests override with `GROUNDWORK_DATA_DIR`.
- Any vault path coming from the UI or CLI goes through `Vault::resolve`, which refuses paths outside the vault.
- Write tests against `fixtures/vault` for anything that reads or rewrites notes. Code that modifies user files (rename, link rewriting) needs thorough tests before it ships.
- UI colours come from the CSS variables in `app/src/styles/tokens.css`, which handles light and dark mode.
