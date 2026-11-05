# Groundwork — Build Plan

Groundwork is a macOS notes app that treats an Obsidian-compatible folder of Markdown as the source of truth, and adds what Obsidian lacks: first-class HTML pages, terminals/workspaces tied to notes (cmux-style), git worktree management for tickets, and deep Claude Code integration (CLI, hooks, session forking, a "waiting on me" queue).

Opinionated, open source, built for one user first.

---

## 1. Guiding principles

1. **The vault is just files.** Everything a note means lives in Markdown + YAML frontmatter that Obsidian can read. Groundwork never writes to `.obsidian/`. The same vault can be open in Obsidian and Groundwork at the same time.
2. **Portable vs. machine-local state is split.** Anything that should travel with the vault (project config, page state, templates) lives in the vault. Anything machine-specific (absolute repo paths, terminal sessions, window layout, inbox) lives in `~/Library/Application Support/Groundwork/`.
3. **Deterministic core, agent on top.** Groundwork does the mechanical work (create worktree, create note from template, open workspace) through commands that both the UI and the CLI call. Claude decides *what* (names, summaries, organisation) and calls those same commands.
4. **Build in stages, with a feedback checkpoint after each phase.**

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| App shell | **Tauri v2** (Rust backend, WKWebView frontend) | Light and fast, cross-platform later, web tech for editor/HTML |
| Frontend | **React + TypeScript + Vite**, Zustand for state | Most mature ecosystem for the pieces below |
| Layout (tabs/splits/drag) | **dockview** (candidate) | Tabs, splits, drag-to-dock out of the box |
| Editor | **CodeMirror 6** with custom live-preview decorations | What Obsidian uses; supports source + live preview |
| Reading view | **remark/rehype** pipeline + custom plugins | Wikilinks, embeds, callouts, Mermaid, KaTeX, etc. |
| Terminal UI | **xterm.js** (WebGL renderer) | Same engine as VS Code's terminal; Claude Code runs well in it. Can swap to ghostty-web later if it matures |
| Terminal backend | **Custom Rust PTY daemon** (`portable-pty` + headless emulator state, e.g. `alacritty_terminal`) | Sessions survive app quit; normal scrollback; clean session list. No tmux quirks |
| Vault index | **Rust**, `notify` file watcher, **SQLite** (rusqlite, FTS5) | Links, backlinks, tags, aliases, full-text search. Cache is rebuildable, machine-local |
| Agent search | **qmd** (external, required for smart search) | Hybrid BM25 + vector + rerank, MCP-capable. Behind an interface so it can be replaced |
| CLI | `groundwork` Rust binary (shares the core crate) | File ops work offline; live ops go through a Unix socket to the app |
| Backend API | Plain Rust command handlers, exposed over **Tauri IPC** and, in dev builds, a **local WebSocket** | Lets the UI run in a normal browser against the real backend, so Playwright can test it end to end |
| Claude integration | A **Claude Code plugin** shipped in this repo (skill + hooks) | The skill teaches the CLI; hooks report session id/state per terminal tab |

---

## 3. Repository layout

```
groundwork/
  PLAN.md
  CLAUDE.md                 # conventions for agents working on this repo
  Makefile                  # dev, browser, test, e2e, lint, build
  Cargo.toml                # Rust workspace
  crates/
    core/                   # vault model, md parsing, link resolution, index, rename/move,
                            # templates, projects, git worktrees
    protocol/               # API request/response types shared by app / cli / dev server
    backend/                # request dispatch shared by every host; `dev-server` feature
                            # adds the WebSocket host for browser mode
    terminal-daemon/        # groundworkd: PTY sessions that outlive the app (Phase 4)
    cli/                    # `groundwork` CLI binary (Phase 2)
  app/
    src-tauri/              # Tauri shell: `api` command, groundwork:// protocol for pages
    src/                    # React UI; api/generated/ holds TS types exported from Rust
    e2e/                    # Playwright tests (UI in browser mode)
  claude-plugin/            # Claude Code plugin: skills/, hooks/ (Phase 2+)
  fixtures/vault/           # test vault covering Obsidian edge cases
```

Folders have no prefix. The Rust *package* names are `groundwork-core`, `groundwork-cli`, and so on, because Rust package names must be unique and `core` would clash with Rust's built-in `core` library.

---

## 4. Data model & file formats

### 4.1 Vault layout (example — only the marked parts are conventions)

```
My Vault/
  .obsidian/                      # Obsidian's; Groundwork reads some settings, never writes
  .groundwork/                    # Groundwork vault config (hidden from Obsidian's explorer)
    config.yml                    # vault-level settings, ticket trackers, global actions
    repos.yml                     # ← code repos and their components (§4.3)
    page-state/                   # state for single-file .html pages
  Templates/                      # respected from Obsidian/Templater settings
  Daily/
  Contacts/                       # convention: one note per person (type: person)
  Events/                         # convention: one note per event or meeting (type: event)
  Notes/                          # shared ideas and concepts, linked from any project
  Projects/
    Integrations/                 # a project for the shared, repo-wide work
      .groundwork.yml             # ← marks this folder as a Project
      Integrations.md             # overview note (any name; referenced in config)
      Work/                       # tickets that don't belong to one integration
    Lincoln/
      .groundwork.yml             # code: the lincoln-web and lincoln-lambda components
      Lincoln.md
      Meetings/  Decisions/  ...  # any structure you like
      Work/                       # the project's ticket folder (name configurable)
        INT-123 Fix login.md      # one note per ticket
      demos/
        login-flow.page/          # an HTML bundle (folder with .page suffix)
          index.html
          app.js
          state.json              # written by the page via the bridge API
        sketch.html               # a single-file HTML page
    Empower/                      # same repo as Lincoln, different components
    Kyoto Trip/                   # a project with no code at all
      .groundwork.yml
```

A project is any folder containing `.groundwork.yml`. Inside a project, any subfolder structure is allowed. Only the overview note and the work folder are special.

**Projects, repos and notes are separate things.** A project is a body of knowledge: meetings, people, decisions, tickets. A repo is code. A project may use code from one or more repos, or none. A repo may serve many projects: in a monorepo, each project usually maps to a few of its components. Notes link freely across all of this, as in Obsidian; a concept note shared by two projects lives once and is linked from both.

### 4.2 Obsidian settings Groundwork respects (read-only)

- `app.json`: `newLinkFormat` (shortest/relative/absolute), `useMarkdownLinks`, attachment folder
- `daily-notes.json`: folder, date format, template
- `templates.json` and the Templater plugin `data.json`: templates folder

### 4.3 Repos and components — `.groundwork/repos.yml` (portable)

Every code repo the vault refers to, defined once. Projects and tickets refer to a repo by id, and to part of one as `repo:component`.

```yaml
integrations:
  name: Integrations monorepo
  description: Partner integrations. One web app and one Lambda per partner, plus shared libraries.
  git:
    base_branch: main
    branch_format: "{{key}}-{{slug}}"
    worktree_name: "{{key}}-{{slug}}"
  setup:                            # run at the root of every new worktree
    - npm install
    - cp "{{repo.path}}/.env" .env
  docs: [CLAUDE.md, docs/architecture.md]   # where agents should start reading
  home_project: Integrations        # where tickets with no single project go (optional)
  components:                       # optional; parts of the repo that work differently
    shared:
      path: packages/shared
      description: Auth, HTTP clients and models used by every integration.
    lincoln-web:
      path: apps/lincoln
      description: Lincoln's partner portal (Next.js).
      setup: [npm run build -w apps/lincoln]
      commands:                     # named commands for people, actions and agents
        dev: npm run dev -w apps/lincoln
        test: npm test -w apps/lincoln
      docs: [apps/lincoln/README.md]
    lincoln-lambda:
      path: lambdas/lincoln-sync
      description: Nightly sync Lambda (Python, SAM).
      commands:
        test: make test
        invoke: sam local invoke SyncFunction
```

- **Everything is optional.** A repo can be just an id and git settings. Components exist only where a part of the repo needs its own setup, commands or explanation.
- **Point, don't duplicate.** The repo's own `CLAUDE.md`, READMEs and scripts stay the source of truth for how its code works. `repos.yml` holds what the repo can't know: which projects use which parts, worktree conventions, personal setup steps, and pointers (`docs`) to where to start reading.
- `{{repo.path}}` is the main checkout on this machine; `{{worktree.path}}` and `{{component.path}}` resolve inside the current worktree.

### 4.4 Project config — `Projects/Lincoln/.groundwork.yml` (portable)

```yaml
name: Lincoln
overview: Lincoln.md
work_folder: Work
code:                             # optional: what this project's work touches
  - integrations:lincoln-web
  - integrations:lincoln-lambda
  - integrations:shared
tickets:                          # optional overrides of the vault's tracker settings
  template: Templates/Ticket.md
  match:                          # how a new ticket is routed here (see §5.6)
    jira_components: [Lincoln]
actions: []                       # project-specific buttons (see 4.7)
```

- A project without `code` (a trip, a hobby, a reading list) simply has no repos, worktrees or ticket flow. It still gets notes, todos, actions and, if you want one, a workspace whose terminals open in the project folder.
- The project's id is its folder name, slugified (`lincoln`), unless `id:` is set.
- **Ticket trackers are vault-level**, in `.groundwork/config.yml`, because one tracker often serves many projects and a vault may use several trackers:

```yaml
trackers:
  - id: jira-int
    key_pattern: "INT-\\d+"
    url: "https://company.atlassian.net/browse/{{key}}"
    note_name: "{{key}} {{title}}"
    template: Templates/Ticket.md
```

### 4.5 Machine-local repo mapping — `~/Library/Application Support/Groundwork/machine.json`

```json
{ "vaults": { "<vault-id>": { "repos": {
  "integrations": { "path": "/Users/aaron/dev/integrations",
                    "worktrees": "/Users/aaron/dev/integrations-worktrees" }
}}}}
```

The first time something needs a repo on a new machine, Groundwork asks you to locate it once (suggesting `<repo>-worktrees` as the worktree directory). Every project that uses the repo shares that mapping. Notes never contain absolute paths.

### 4.6 Frontmatter conventions

```yaml
# Ticket note
type: ticket
ticket: INT-123
jira: https://company.atlassian.net/browse/INT-123
projects: ["[[Lincoln]]", "[[Empower]]"]   # every project it affects; the first is its home
code: [integrations:shared, integrations:lincoln-web]   # what it touches (optional)
repo: integrations
worktree: INT-123-fix-login      # name inside the repo's worktree dir
branch: INT-123-fix-login
status: active                   # active | closed
people: ["[[Jane Doe]]"]

# Any note can belong to projects other than the folder it's in
projects: ["[[Lincoln]]", "[[Empower]]"]

# Any note that has a workspace
workspace: ws-7f3a               # id of a machine-local workspace record

# Person
type: person
company: ...
role: ...
projects: ["[[Lincoln]]"]

# Event (a meeting, call, conference, deadline…); `type: meeting` counts too
type: event
date: 2026-11-05
time: "14:00"                    # optional
people: ["[[Jane Doe]]"]
projects: ["[[Lincoln]]"]
```

**People and events live in top-level folders** (`Contacts/`, `Events/`), never inside a project, so a note made mid-meeting never needs moving. They belong to projects through `projects:`, which Quick add fills in from what you're working on (§5.13).

**Project membership** of any note (tickets, meetings, people, concepts, todos): the projects linked in its `projects:` frontmatter, plus the project folder it sits in. `projects:` holds ordinary links to the projects' overview notes, so a project's overview shows all its tickets and related notes as backlinks, in Obsidian too.

### 4.7 Actions (buttons and menu items)

Defined in `.groundwork/config.yml` (global), a project's `.groundwork.yml`, or a repo or component in `repos.yml`. An action is shown wherever its scope applies: a component's actions appear on every ticket whose `code` includes it. The kinds are `shell`, `terminal` and `agent`:

```yaml
actions:
  - id: open-vscode
    label: Open in VS Code
    kind: shell
    run: code "{{worktree.path}}"
    show_on: [worktree]          # worktree toolbar, note context menu, palette...
  - id: lincoln-dev
    label: Run Lincoln portal
    kind: terminal                # opens a tab in the workspace and runs it
    run: "{{component.commands.dev}}"
    component: integrations:lincoln-web
  - id: new-ticket
    label: New ticket from Jira
    kind: agent                   # launches a visible Claude Code session
    cwd: "{{repo.path}}"
    input: { url: "Jira URL" }
    prompt_file: .groundwork/prompts/new-ticket.md
```

Built in from the start: Open in VS Code, Reveal in Finder, Copy relative path, Copy absolute path, Open Jira ticket.

### 4.8 HTML pages

- **Single file:** `foo.html`, with CSS and JS inline. Link with `[[foo.html]]`.
- **Bundle:** `foo.page/index.html` plus assets. It shows as one item in the sidebar. Link with `[[foo.page]]`.
- Extensions are required in links, matching Obsidian's convention for non-Markdown files. That avoids clashes with `foo.md`.
- Pages are served at `/page/<token>/<vault path>`: on the `groundwork://` protocol in the app, on the dev server in browser mode. Relative assets and links resolve; bundles load with a trailing `/` so they stay inside the bundle. The token is random per launch.
- **Sandboxed:** pages run in iframes with `sandbox` but without `allow-same-origin`, so they have an opaque origin. That matters because Tauri treats our own `groundwork://` scheme as a trusted origin for app commands, and the dev server accepts sockets from any localhost origin; an opaque origin gets neither. Page files are served with CORS open, so module scripts and `fetch` still work; the token stops other websites using that to read the vault through the dev server. `localStorage` doesn't exist in an opaque origin, so the bridge substitutes an in-memory one.
- **Bridge API** injected as `window.groundwork` (the server puts the script first in every HTML document; it talks to the app with postMessage):
  - `path`: the page's vault path
  - `navigate("[[Some Note]]")`
  - `readFile(path)`: a vault file's text; paths are relative to the page, `/` for the vault root
  - `state.get()` and `state.set(obj)`, persisted to `foo.page/state.json` or to `.groundwork/page-state/<path>.json` (moved along on rename)
  - `onStateChange(cb)`: the state changed elsewhere (another view of the page, the CLI, Claude editing the file)
- Links inside pages: vault files open in Groundwork (`<a href="../Plan.md">` or `<a href="[[Plan]]">`), other pages in the same bundle navigate in place, web links open in the browser. ⌘ shortcuts are forwarded to the app.
- Open pages and embeds reload when their files change. A bundle counts as changed when any file in it changes, except `state.json`.
- Embeds: `![[foo.page]]` sizes itself to the page (capped at 4000px); `![[foo.page|400]]` is 400px tall.
- Claude reads the state with `groundwork page state <page>`, or the state file directly.
- Network access: `pages: { allow_network: false }` in `.groundwork/config.yml` adds a Content Security Policy that allows only the page's own files, inline code and `data:`/`blob:` URLs. On by default, so dashboards can fetch external data.
- Obsidian will show `[[foo.page]]` links as unresolved. That's acceptable.

### 4.9 Todos (Markdown task lines)

Todos are ordinary Markdown tasks that can live in any note: a daily note, a project note, a ticket note, a meeting note. Metadata goes on the same line, using the Obsidian Tasks plugin's emoji format, so the vault keeps working in Obsidian:

```markdown
- [ ] Ask Jane about the auth migration 📅 2026-11-05 ➕ 2026-11-03
- [x] Review PR #412 ➕ 2026-10-28 ✅ 2026-11-03
- [-] Old idea, dropped ➕ 2026-09-01 ❌ 2026-11-03
```

| Marker | Meaning | Shown in Groundwork? |
|---|---|---|
| `📅 date` | due date | yes; "Due tomorrow", red when overdue |
| `⏳ date` / `🛫 date` | scheduled / starts | yes |
| `🔁 rule` | recurrence | yes, "Repeats every week" (not acted on yet) |
| `➕ date` | created | yes, last and faint |
| `✅ date` / `❌ date` | done / cancelled | yes; added automatically when you check the box |
| priority marker | `p0`–`p5` (see below) | yes, as `P1` (P0 red, P1 orange) |
| `#tag`, `[[link]]` | context (`#waiting`, `[[Jane Doe]]`) | yes, inline |

**Display.** In live preview and the reading view, the markers leave the task's line and show as one small gray line underneath: `P1 · Due Thu, Nov 5 · Created today`. On the line you're editing, the raw markers show inline, so the file stays a single line per task. Any status character works (`[-]` cancelled, `[/]` in progress), as in Obsidian.

**Priority, `p0`–`p5`.** The six levels map one-to-one onto the Tasks plugin's priority markers, so priorities still work in Obsidian:

| Level | `p0` | `p1` | `p2` | `p3` (default) | `p4` | `p5` |
|---|---|---|---|---|---|---|
| Marker in the file | `🔺` | `⏫` | `🔼` | *(none)* | `🔽` | `⏬` |

You type `!p1` and it turns into the marker. The CLI and agents always use the `p0`–`p5` names, e.g. `--priority p1`. Agents use priority to order what they raise with you: a p0 or p1 todo that's overdue gets a notification, while lower priorities wait in the triage queue.

- **Typing:** you never type the emoji. `@tomorrow`, `@fri`, `@nov 12` and `@+3d` turn into `📅 …`, and the created stamp is added automatically.
- **Project:** the projects of the note the task lives in (§4.6), plus any explicit `[[Project]]` link on the line.
- **Tasks added outside Groundwork** (by Claude or in Obsidian) without a `➕` stamp get a "first seen" date from the activity log. The skill tells Claude to add tasks through `groundwork todo add`, which adds the stamp itself.

### 4.10 Metadata & activity log

- **`created:` in frontmatter** is written once, when Groundwork creates a note. It's portable, and it survives git checkouts and iCloud, both of which change file timestamps.
- **No auto-updated `modified:` field.** Rewriting frontmatter on every save causes git noise and clashes with Obsidian editing the same file.
- **The activity log takes over that job.** It lives in `.groundwork/activity/<machine-id>/YYYY-MM.jsonl` and is append-only. There's one folder per machine, so iCloud or git sync never conflicts. It's portable and easy for agents to read.
- **What it records:**
  - note or page created, modified (debounced, about one entry per editing burst), moved or deleted
  - todo added, completed, cancelled, due date changed
  - which source made the change: the app, the CLI (with the agent's session id when known), or an external tool
- **Edits made while the app was closed** are picked up at startup by comparing content hashes, and logged as "detected".
- **Exposed through:** `groundwork note info <note>` (created, last modified, edit history) and `groundwork activity [--since 7d] [--project acme]`.

### 4.11 Machine-local app state (SQLite in Application Support)

- Workspaces: id, name, cwd, linked note, layout (tabs and splits)
- Terminal sessions, and Claude session ids per tab
- Inbox: questions, notifications and attention items
- Index cache, recent vaults, window state

---

## 5. Subsystem designs

### 5.1 Vault core (`crates/core`)

- **Parse:** frontmatter, wikilinks, embeds, Markdown links, headings, block ids (`^id`), tags (inline and frontmatter), aliases.
- **Resolve links the way Obsidian does.** Fixture tests compare our results with real Obsidian behaviour, covering:
  - exact path
  - unique basename
  - `#heading`
  - `#^block`
  - aliases match in the quick switcher and `[[` autocomplete, which insert the real file name. As in Obsidian, an alias is not itself a link target.
- **Index:** incremental via the file watcher. External edits, from Obsidian, Claude or git, show up live. *As built in Phase 1:* the index is in memory and rebuilt on open (fast at personal-vault scale). SQLite + FTS5 arrives with search in Phase 2.
- **New notes** (⌘N, the quick switcher, following a link to a missing note) go where `.obsidian/app.json`'s "Default location for new notes" says: vault root, the current note's folder, or a set folder. Two exceptions: a name in the daily-note format (`daily-notes.json`, e.g. `[[2026-11-02]]`) goes to the daily notes folder, and a link that includes a path creates the note at that path. (Phase 2 will also apply the daily template.)
- **Backlinks:** linked mentions, plus unlinked mentions (a text match on the title or aliases).
- **Rename/move:** rewrites every link to the file, and to its headings and blocks, keeping each link's original style (wiki or Markdown, alias, shortest path). Folder moves are supported. Every rewrite is logged in an operation log for undo.

### 5.2 Editor & rendering

- **Modes:** live preview (the default) and source, toggled per tab. HTML pages get a rendered view plus a read-only source view.
- **Supported syntax:**
  - wikilinks and embeds (notes, headings, blocks, images, PDFs, pages)
  - callouts
  - Mermaid
  - KaTeX math
  - `==highlight==`
  - `%%comments%%`
  - footnotes
  - task lists with clickable checkboxes
  - tables
  - frontmatter shown as a properties panel
- **Navigation:** Cmd-click a link to open it in a new tab, hold ⌘ over a link to preview it (the preview closes once the pointer leaves both the link and the preview), and get autocomplete for `[[`.

### 5.3 Templates & daily notes

There's one simple `{{…}}` syntax. It's a superset of Obsidian's core template syntax, so existing core templates work unchanged. Templater (`<% %>`) is **not** supported. Existing Templater templates can be converted once with Claude's help.

**Dates and times.** Format tokens follow Moment.js, as Obsidian does.

| Tag | Result (for a note dated Tue 2026-11-03) |
|---|---|
| `{{date}}` | `2026-11-03` |
| `{{date:dddd, MMMM D}}` | `Tuesday, November 3` |
| `{{date+1d}}` / `{{date-1d}}` | `2026-11-04` / `2026-11-02` |
| `{{date+2w}}`, `{{date-1m}}`, `{{date+1y}}` | offsets in days, weeks, months, years; they can be chained: `{{date+1m-1d}}` |
| `{{date@week}}` / `{{date@month}}` | start of the week (Monday) / start of the month |
| `{{date@week+4d:ddd D}}` | anchor, then offset, then format: `Fri 6` |
| `{{time}}`, `{{time:HH:mm}}` | current time |
| `{{now:YYYY-MM-DD HH:mm}}` | creation timestamp, always the real "now" |

`date` means **the note's date**. That's the day for a daily note, or the `--date` given on the CLI, and otherwise today. So a daily-note template can contain `[[{{date-1d}}]]` to link to the previous day.

**Other tags:**
- `{{title}}`, `{{folder}}`, `{{path}}`
- `{{cursor}}`: where the cursor lands after the note is created
- `{{prompt:Label}}`: asks for a value when the note is created. The same label always reuses the same answer. On the CLI, use `--var Label=value`.
- Context tags: `{{project.name}}`, `{{ticket.key}}`, `{{ticket.title}}`, `{{jira.url}}`, …

**Avoiding accidental matches:**
- Tags are only expanded when a note is **created from a template**, never in ordinary notes.
- Only known tag names are expanded. Anything else, such as `{{foo}}` or Handlebars or Jinja in a code sample, is left untouched.
- Text inside code spans and fenced code blocks is never expanded.
- `\{{date}}` escapes a tag, so it's output literally.

Daily notes follow `daily-notes.json`. Cmd+Shift+D opens today's note. Daily notes and todos work together (§5.11).

**In the app (built in Phase 2):**
- The templates folder comes from Obsidian's `templates.json` (default `Templates/`).
- **New note from template…** (command palette) asks for a name plus the template's prompts, creates the note where new notes go, and puts the cursor at `{{cursor}}`.
- **Insert template…** inserts at the cursor. The template's properties are merged into the note's, and the note's existing values win.
- Daily notes get the daily template whether they're opened with Cmd+Shift+D or created by following a link like `[[2026-11-04]]`. `{{date}}` is that note's day.
- A note created from a template gets `created:` unless the template sets it.

### 5.4 Terminal daemon (`groundworkd`)

- Started on demand by the app or the CLI. Listens on a Unix socket.
- Each session has:
  - a PTY
  - a headless emulator holding screen state and a scrollback ring buffer
  - cwd, environment and title
- **Attach:** sends a snapshot of the screen and scrollback, then streams live output.
- **Lifecycle:**
  - Quitting the app leaves sessions running (configurable).
  - After a reboot or a daemon crash, layouts are restored and shells restart in the right cwd.
  - Claude tabs offer **"resume conversation"** (`claude --resume <id>`).
- **Session manager UI:** lists every live session with cwd, process, age, attached or detached, and whether it's a Claude session. It can kill one or many.
- **Environment for every tab:** `GROUNDWORK_TAB_ID`, `GROUNDWORK_WORKSPACE_ID`, `GROUNDWORK_SOCKET`, `GROUNDWORK_VAULT`.
- **Claude Code ergonomics:**
  - Shift+Enter sends a newline.
  - OSC 8 hyperlinks work.
  - Clicking a file path inside the vault opens it in Groundwork.
  - Title, bell and OSC 9 notifications are handled.

### 5.5 Workspaces

- A **workspace** has a name, a cwd, an optional linked note, and a layout of tabs and splits. A new tab opens a fresh shell in the workspace's cwd.
- **Workspaces view (cmux-style):**
  - a vertical list of every workspace, grouped by project (a ticket in several projects shows under its home project, with the others as badges), or by repo with a toggle; standalone workspaces get their own group
  - each workspace shows its tabs
  - status badges: running, waiting on you, finished, idle
  - it's independent of notes
- **Notes with a workspace** get a view switcher: **Note · Split · Workspace**.
- **Ticket workspaces** open their first tab at the worktree root, so agents see the repo's own `CLAUDE.md`. The new-tab menu also offers one tab per component the ticket touches, opened in that component's folder.
- A note has no workspace until you choose "Create workspace" or create a ticket.

### 5.6 Projects, repos, tickets & worktrees

- **One worktree per ticket**, in its repo's worktree directory, whichever project the ticket belongs to. Tickets from Lincoln and Empower share the `integrations` worktree directory; ticket keys keep the names unique.
- **Where a ticket's note goes:** the work folder of its home project (the first in `projects:`). A ticket that belongs to no single project goes to the repo's `home_project` if it has one, otherwise to the vault's default work folder (`Work/`, set in `config.yml`).
- **Ad-hoc tickets.** Projects and tracker keys are both optional. A spike or quick fix can be just a repo plus a slug: `groundwork ticket create --repo integrations --slug try-new-cache`. It gets a branch and worktree (name formats skip `{{key}}` and its separator when there's no key), a workspace and a note in the default work folder, and you can attach it to projects or a Jira key later by editing frontmatter.
- **Starting a worktree** works from wherever you are:
  - a project: its overview note, its folder in the tree, or the tickets view filtered to it (defaults to that project and its repo, or asks which repo when it uses several)
  - a repo: the tickets view grouped by repo, or "New worktree in…" in the command palette
  - any existing note: "Add worktree" turns it into a ticket (adds the frontmatter and creates the worktree, leaving the note where it is)
- **Tickets view.** Tickets are notes with `type: ticket` frontmatter, so they come straight from the index, filtered and grouped any way:
  - every active ticket in a repo (including ones from several projects, and ad-hoc ones), with each worktree's git state: dirty, unpushed, behind base
  - every active ticket in a project, across all the repos it uses
  - filters for status, tracker and component; grouping by project, repo or status
  - worktrees that exist on disk but have no ticket note (made outside Groundwork) are listed too, with "Adopt" to create a note for one
  - it lives in a sidebar panel, and a ```` ```tickets ```` block (like ```` ```todos ````) embeds a live list in any note, e.g. on a project overview: `project: this`, `status: active`
- **Routing a new ticket.** A tracker's key pattern says a ticket is a ticket; the projects it belongs to are decided per ticket:
  - Projects can declare `tickets.match` rules (Jira components, labels). When exactly one project matches, it's the home.
  - Otherwise the agent proposes `projects` and `code` from the ticket's text and the components' descriptions, and asks you to confirm through the inbox. Quick create just asks you.
  - Either can be changed later by editing frontmatter; nothing else depends on the folder.
- **Quick create (deterministic):** Jira URL → key → you pick the project(s) and type a slug → branch + worktree + repo and component setup → note from template → workspace.
- **Agent create (default):** "New ticket from Jira" is an agent action.
  1. It opens a visible Claude tab in the repo's main checkout (or the vault, for a ticket with no repo yet).
  2. Claude reads the ticket and picks a slug, title, projects and the components it touches.
  3. Claude runs `groundwork ticket create --key INT-123 --project lincoln --project empower --code integrations:shared --slug fix-login --title "Fix login"`.
  4. Claude fills in the note's summary.

  You can watch it happen and step in. This requires Claude Code to have Jira access; see open questions.
- **Close ticket:**
  1. Warns about uncommitted changes, unpushed commits, or a branch missing from the remote.
  2. Kills the sessions.
  3. Runs `git worktree remove`.
  4. Sets `status: closed` and a `closed:` date.

  The note stays where it is, so links never break. The sidebar hides closed tickets by default, with a toggle to show them.
- **Restore ticket:** runs `git worktree add` from the local or remote branch, recreates the workspace, and sets `status: active`.
- **Agents find their way with `groundwork context`.** Given a cwd (a worktree, a repo checkout, a vault folder) or a note, it reports:
  - the ticket, its projects (with overview note paths) and tracker URL
  - the repo, its main checkout and the worktree path on this machine
  - the components involved, each with its path, description, commands and docs to read
  - the actions available here
  - related notes: the ticket's links, the projects' overviews, and recent meetings and decisions

  It works in reverse too: `groundwork code who apps/lincoln` lists the projects and open tickets that touch a path. The plugin's SessionStart hook injects a short `context` summary into every Groundwork tab, and the skill teaches agents to call `groundwork context --json` whenever they need more.
- **Multi-repo tickets:** not in the first version. The frontmatter keeps room for them (`repo`/`worktree` become a list), and `code` can already name components in several repos.

### 5.7 Claude Code integration

- **Plugin** (`claude-plugin/`), installed through a local plugin marketplace:
  - **Skill `groundwork`:** what the vault is, the conventions, the CLI commands, the templates, and how to ask the user something.
  - **Hooks:** SessionStart, UserPromptSubmit, Stop and Notification each call `groundwork hook <event>`. Outside a Groundwork tab (`GROUNDWORK_TAB_ID` unset) the hook does nothing.
  - *Pulled forward in Phase 4:* the plugin's SessionStart hook (now `groundwork hook session-start`, through `claude-plugin/hooks/run`) tells Claude in a Groundwork tab that it's inside Groundwork, which vault is open beside it, and to load the skill before touching the vault. The first real session in a Groundwork terminal didn't know what the app renders, so it checked Mermaid by running the app's source.
  - **What the hooks give us:** each tab's Claude session id and a live state (working, waiting for input, finished). SessionStart also adds the `groundwork context` summary for the tab's ticket or project.
- **Fork:** the tab menu's "Fork session" opens a new tab in the same cwd running `claude --resume <id> --fork-session`.
- **Inbox ("waiting on me"):**
  - `groundwork ask "Which env?" [--choice a --choice b]` blocks until you answer in the app, then prints the answer to the agent.
  - `groundwork notify "Done reorganising Meetings/" [--link "[[note]]"]` posts a non-blocking item.
  - Claude permission and idle prompts (from the hooks) appear as attention items that jump you to the tab.
  - Items show a dock badge and a macOS notification.
  - You can answer from the inbox panel.
- **Other agents:** behind an `AgentAdapter` interface. Only Claude Code is implemented.
- **Setup (built in Phase 2): "Set up Claude Code…"** in the command palette, for Claude sessions in any terminal. Terminals inside Groundwork won't need it, since they set `GROUNDWORK_VAULT` and PATH themselves. It has three rows, each reporting *ok*, *missing*, *stale* or *unavailable*, with a button to fix it:
  - **The `groundwork` command:** a symlink in `/usr/local/bin` (on PATH by default; it asks for an admin password only if the folder needs one) to the CLI built next to the app. It's a link, not a copy, so rebuilding or updating the app updates it. It's *stale* if it points at another build, such as an older checkout, or is a plain copy. A leftover `~/.cargo/bin/groundwork` gets a warning.
  - **The plugin:** installed with `claude plugin marketplace add <this checkout>` and `claude plugin install groundwork@groundwork`. Claude Code reads a directory marketplace's plugin live from its folder, so skill edits reach new sessions without reinstalling. It's *stale* when installed from another folder (fixed by removing and re-adding the marketplace, which reinstalls the plugin), when disabled, or when the installed version is behind the folder's (`claude plugin update`). Groundwork finds `claude` on PATH or where its installers put it, since apps opened from the Finder get a minimal PATH. Without it, the row shows the commands to run by hand.
  - **Default vault:** saved in `cli.json` in the app data folder. The CLI uses it after `--vault`, `$GROUNDWORK_VAULT` and the vault around the current folder, and before "the vault the app opened last". A default that no longer exists is an error, not a silent fallback.
  - **Staleness:** once per launch, Groundwork checks quietly and shows a "Claude Code setup is out of date — Fix…" notice only if something set up earlier is now *stale*. Until the dialog has been opened once, a launch where the command isn't installed shows "Let Claude Code work with your notes, from any terminal — Set up…" instead. `make` only builds the CLI; putting it on PATH and installing the plugin write outside the repo, so they wait for that click.

### 5.8 CLI (`groundwork`)

These commands work without the app running (they use files directly):

- `note`: `create [--template]`, `read`, `move` (with link rewriting), `list`
- `links` / `backlinks <note>`: for notes and pages (a page's `<a href>` links to vault files count). `links --all` lists every link in the vault.
- `files [--path <folder>]`: every note, page and file, as the file tree lists them
- `search <q>` (full text) and `search --smart <q>` (qmd)
- `template list` / `template show`
- `daily [--date]`
- `page state <page> [--set <json>|-]`: what an HTML page saved (§4.8)
- `ticket create` / `ticket close` / `ticket restore` / `ticket list [--repo] [--project] [--status] [--component]`
- `project list` / `project show` (with its code, open tickets and overview)
- `repo list` / `repo show` (components, commands, docs, and which projects use each part)
- `context [--note <note>] [--cwd <dir>]`: everything an agent needs to orient itself here (§5.6)
- `code who <path>`: the projects and open tickets that touch a path in a repo

These commands need the app (they go through the socket):

- `open <note|page>`
- `workspace list` / `workspace create` / `workspace open`
- `tab new [--cmd]` / `tab send <text>` / `tab read [--lines]` / `tab fork`
- `ask` / `notify`
- `hook <event>`

Every command supports `--json` output, so agents can parse it reliably.

**MCP server:** deferred. If wanted later, it's a thin wrapper over the same core. That would mainly be for Claude Desktop and claude.ai.

### 5.9 Search

- **In the app:** full-text search in the left sidebar (Cmd+Shift+F), plus a tags view. The query syntax: all words must appear; `"phrase"`, `-exclude`, `path:` and `tag:`/`#tag` (which also matches nested tags). Results show matching lines with hits highlighted; title matches rank first.
  - *For now* each query reads the notes from disk, as unlinked mentions do. That's fast for personal vaults. A SQLite FTS5 index (with HTML text) can replace it later without changing the API.
- **qmd for smart search:** Groundwork registers the vault as a qmd collection and runs `qmd update` when files change. Agents can use qmd directly, or call `groundwork search --smart`.

### 5.10 Command bar (global hotkey)

- A configurable global shortcut opens a floating Spotlight-style panel. Handy, or the keyboard, types into it.
- Context chips are on by default and can be toggled off: the current note, workspace and project.
- Pressing Enter starts a **fresh** Claude session in a new tab in an "Agents" workspace group, running in the vault root. The context is passed with `--append-system-prompt`.
- The session's questions show up in the inbox, and the tab gets a status badge.

### 5.11 Todos & daily notes

**Nothing gets copied.** Todos stay in the note where they were written. The daily note shows a **live view** of everything relevant to its date, so an unfinished todo can't get lost when a new day starts, and you never end up with duplicates.

- **The daily template contains a todos block:**
  ````markdown
  ```todos
  day
  ```
  ````
  It renders as an interactive list for **that note's date**:
  - **Overdue:** due before that date and not done
  - **Due:** due on that date
  - **Carried over:** undated tasks from earlier daily notes that aren't done yet, labelled with their source and age ("from Nov 2 · 5d")
  - **Done:** completed on that date. This makes past daily notes a record of what got done that day.
- **Using the block:**
  - You can tick, reschedule (`@fri`) or cancel a task from the view. The change is written to the line in the file where the task actually lives.
  - The block's "add todo" field writes a new task into that daily note, under its `## Todos` heading (configurable), due that day.
  - In Obsidian the block shows as plain text. Tasks written as normal lines in the note still appear there.
- **Todos panel:** a sidebar view of every open todo, grouped into Overdue, Today, Next 7 days, Later and No date. Its filter box takes words, `#tag`, `path:` and `p1`.
- **`todos` block syntax:** `day` gives the day view. Otherwise each line is a filter: `tag:`, `path:` (alias `project:` until projects exist), `due: overdue|today|week|any|none`, `status:`, `priority: p1`, `text:`, `title:`. A first line of `agenda` groups the results like the panel.
- **Typing todos:** on a task line, and in a day block's add field, `@` offers dates (typed text such as `@fri`, `@nov 12`, `@+3d`, or suggestions) followed by priorities (`@p1` narrows to one), and `!` offers priorities only. Both replace an existing due date or priority, not add a second one. A task you write gets `➕ today` once the cursor leaves its line, so half-typed tasks aren't stamped or logged.
- **Activity log:** task events (`taskAdded`, `taskDone`, `taskCancelled`, `taskReopened`, `taskRescheduled`) come from comparing a note's tasks before and after each change, so edits from Obsidian or Claude are logged too.
  - A task typed in the app counts as added when it gets its `➕` stamp. One from outside counts as added when first seen.
  - Known gap: while the app is running, a CLI change is logged twice, once by the CLI and once by the app's file watcher. This goes away once the CLI talks to the running app.
- **Keeping them from piling up:**
  - `groundwork todo list --stale 14d --json` lists old tasks, with ages taken from `➕`.
  - A **triage skill** has an agent review stale and overdue tasks and post `groundwork ask` items: keep, reschedule, drop or "make this a ticket". You answer them from the inbox.
  - It runs on demand or from an external schedule.
- **Possible later additions:** recurring tasks, a "scheduled" date that's separate from the due date, and moving tasks between notes.

### 5.12 CLI additions for todos & metadata

These all work without the app running:

- `todo list [--due today|overdue|week] [--priority p0-p1] [--project] [--stale 14d] [--json]`
- `todo add "text" [--due fri] [--priority p2] [--note <note>]`. With no `--note`, the task goes into today's daily note.
- `todo done|cancel|reschedule <id>`. Ids are `path:line` plus a hash of the task text, so a stale id is caught rather than editing the wrong line.
- `note info <note>`, `activity [--since] [--project] [--json]`

---

### 5.13 Quick add, people & events, settings (Phase 7)
- **Settings** (⌘,) has a section per feature down its side. A feature's section holds its settings; **Keyboard shortcuts** is a section of its own that lists every feature's commands, grouped by feature, with a search. Features add commands to the key registry (`app/src/state/keys.ts`), including ones made from configuration (each Quick add choice).
- **Editor commands** act on the note being edited and have shortcuts like any command: toggle checkbox (⇧⌘2), bulleted and numbered list, bold (⌘B), italic (⌘I), strikethrough, highlight, inline code, link (⌘K), insert today's date and the time.
- **Quick add** (⇧⌘A) opens a menu of choices. A *note* choice makes a note from a template in a folder, named by a pattern (`{{date}} {{prompt:Title}}`), asking for the template's prompts, a date when the name or template uses one, and a project when it's set to. A *capture* choice adds a line (`- [ ] {{prompt:Todo}}`) to a note: today's daily note, or a fixed one. The project offered first is the one you're in: the open note's (`projects:` or its folder), else the current workspace's note's. Choices live in `.groundwork/quickadd.yml` (portable; written by Settings), and when there's none the defaults are **Person** (in `Contacts/`), **Event** (in `Events/`, named `{{date}} {{title}}`) and **Todo** (captured to today's note). A choice's template falls back to a built-in one when the vault has no such file. The CLI runs the same choices (`groundwork add <choice>`), so agents can too.
- **The project view** is a tab per project, opened from the project's overview note, the palette, or the Tickets panel. It lists the project's **events** (newest first; upcoming or past; search; sort by date or title) and **people** (members, whose `projects:` names it, and people mentioned in its notes, with how often; search; filter members or mentioned; sort by name or last seen). Event membership is the usual project membership (§4.6): `projects:` or sitting in the project's folder, so meetings already filed in a project show too.

## 6. Phases

Each phase ends with a **feedback checkpoint**: a short list of things to try, then adjustments before moving on. Development runs against the fixture vault and a fresh dogfood vault, not your existing one.

### Phase 0 — Scaffold
- Rust workspace, Tauri + React app, CLAUDE.md, lint, format and test setup, fixture vault
- Backend API over both Tauri IPC and the dev WebSocket; a Playwright smoke test against browser dev mode
- Open a folder as a vault, recent vaults, file tree (folders, `.md`, `.html`, `.page` bundles), open a file read-only
- **Checkpoint:** the app launches, opens a vault, and the tree looks right

### Phase 1 — Notes core
- Indexer (frontmatter, links, tags, aliases, headings, blocks, tasks and their metadata) with live file watching
- `created:` frontmatter on new notes; activity log (notes and pages)
- Obsidian link resolution, with fixture tests
- CodeMirror editor with live preview and source modes; reading-view rendering (callouts, Mermaid, KaTeX, embeds, tasks…)
- Clickable links, `[[` autocomplete, hover preview
- Backlinks panel (linked and unlinked mentions); outgoing links
- Tabs and splits, quick switcher (Cmd+O)
- Rename/move with link rewriting, plus undo log
- File context menu: Reveal in Finder, copy relative or absolute path, rename, delete (to the Trash)
- **Checkpoint:** use it as your daily notes app next to Obsidian

### Phase 2 — Templates, daily notes, search, CLI v1 *(done)*
- Templates using the `{{…}}` syntax (date offsets, anchors, prompts)
- Daily notes, command palette (Cmd+P), full-text search UI, tags pane
- Todos: `@date` entry, automatic stamps, the `todos` block (day view with carry-over), Todos panel; todo events in the activity log
- `groundwork` CLI: the file-based commands (note, links, backlinks, search, template, daily, todo, note info, activity)
- First version of the Claude Code plugin skill, so Claude can work on the vault through the CLI
- **Checkpoint:** run a week of daily notes and todos; create notes from templates in the app and through Claude
- Built:
  - `crates/cli` is the `groundwork` binary, built next to the app by `make dev`/`make browser`. It works on the files through `Session::open_for_tool`, which logs as `cli` and leaves the change-detection snapshot to the app. `groundwork vault` says which vault it's using and why.
  - The plugin lives in `claude-plugin/`, listed by the repo's `.claude-plugin/marketplace.json`. For now it has only the `groundwork` skill; hooks, `ask` and `notify` come with terminals.
  - "Set up Claude Code…" (§5.7) installs both and sets the CLI's default vault. It was pulled forward from Phase 8's "CLI install" so the checkpoint doesn't need manual setup.

### Phase 3 — HTML pages *(done)*
- `groundwork://` protocol, page viewer with auto-reload, read-only source view
- `.page` bundles shown as single items; `[[x.page]]` / `[[x.html]]` links, backlinks to pages; links inside pages open notes
- `![[x.page]]` live interactive embeds with automatic height
- Bridge API (`navigate`, `readFile`, `state`) and persisted page state; network setting
- Skill update so Claude knows how to build pages and read their state
- **Checkpoint:** Claude builds an interactive page; you use it and Claude reads the state back
- Built:
  - Serving and the bridge: `crates/backend/src/page_server.rs` and `bridge.js`; the app side is `app/src/lib/pages.ts`. State and settings: `crates/core/src/pages.rs`.
  - `groundwork page state <page> [--set <json>|-]` reads and replaces state. `file.read` now returns text for any UTF-8 file (CSV, JSON), which `readFile` needs.
  - New `.html` files start from a small skeleton that follows light and dark mode.
  - The links panel shows backlinks for pages (and other files); outgoing links and unlinked mentions stay notes-only.
  - Added in Phase 4: links *from* pages are indexed too. A page's `<a href>`s to vault files count as backlinks: wikilink hrefs, and relative paths resolved from the document (a bundle's are inside it). Renaming doesn't rewrite them, since rename only edits notes.
  - Playwright covers browser mode only; the checkpoint confirmed pages work in the desktop app.

### Phase 4 — Terminals & workspaces
- `groundworkd` daemon, xterm.js tabs, splits
- Standalone workspaces, the cmux-style Workspaces view, the session manager
- Persistence across app restarts; layout restore after a reboot
- Claude Code ergonomics (Shift+Enter, links, notifications)
- **Checkpoint:** use Groundwork instead of cmux for a few days
- Built in two halves, with a check-in between:
  1. **The daemon and terminal tabs** *(built)*.
  2. **Workspaces** (each with its own tabs and splits, which the main area switches between; decided 2026-11-03), the Workspaces view and badges, the session manager, restore after a reboot, bell and OSC 9 notifications, and opening vault paths clicked in a terminal *(built, awaiting the checkpoint)*.
- Built in the first half:
  - **`groundworkd`** (`crates/terminal-daemon`) is a std-only threaded server on `<data dir>/groundworkd.sock`, speaking newline-delimited JSON.
    - The backend starts it on first use from beside its own binary, in its own session (`setsid`), so it outlives the app. Quitting leaves terminals running (decided 2026-11-03).
    - It exits after 10 seconds with no sessions and no clients. A lock file stops two from starting at once. A daemon speaking an older protocol is replaced if it has no sessions.
    - Each session is a PTY plus a `vt100` emulator with 5,000 lines of scrollback. Attaching resizes the session and returns a snapshot: scrollback lines, then the exact screen and input modes.
    - Output events carry a byte offset (`seq`), so a view drops what the snapshot already has and reattaches if it sees a gap.
    - Closing a terminal hangs it up (SIGHUP), then kills its process groups after 2 seconds.
    - Shells get `TERM=xterm-256color`, `TERM_PROGRAM=Groundwork`, `GROUNDWORK_TAB_ID`, `GROUNDWORK_VAULT`, the CLI's folder at the front of PATH, and `LANG` if unset. Variables from `npm`, Cargo, Tauri and a parent Claude Code session are stripped when the daemon starts.
  - **Terminal tabs** live in the main dock for now. They come from ⌘T, "New terminal" in the palette, or the empty-dock buttons, and start in the vault root.
    - Tabs are titled by the program's title, else the folder.
    - Closing the tab ends the shell, and the shell exiting closes the tab. Switching vaults leaves terminals running.
    - Opening a file from a terminal tab opens it in a new tab beside it.
    - The layout persists, so terminals reattach after a reload or relaunch. If a session is gone, a new shell starts in the same folder.
    - xterm.js 6 draws with WebGL when it's available, with colours from `tokens.css` (`--term-*`).
    - Keyboard: Shift+Enter sends ESC CR (a newline in Claude Code), and ⌘ shortcuts go to the app. Web and OSC 8 links open in the browser.
    - Input is sent one call at a time, so keystrokes stay in order.
- Built in the second half:
  - **Workspaces** have a name, a folder and their own dock layout. They're machine-local, so they're kept per vault in the data folder (`vaults/<key>/workspaces.json`), not the vault. The main area shows the notes layout or one workspace's; ⌘1 is the notes, ⌘2… the workspaces, and "Switch workspace…" is in the palette. Every area's dock stays mounted (hidden), so terminals in other workspaces keep reporting. New terminals start in the workspace's folder with `GROUNDWORK_WORKSPACE_ID` set. Deleting a workspace ends its terminals, after confirming.
  - **The Workspaces view** (the terminal icon in the sidebar) lists Notes and each workspace with its terminal tabs and badges: *waiting* (a bell or notification you haven't seen), *finished* (a command ended while you were elsewhere), *running* (a program besides the shell is in the foreground; Claude Code only while it draws, since its spinner runs while it works), *idle*. Badges clear when the tab is on screen and the window has focus. Real Claude states come with the Phase 6 hooks.
  - **The session manager** is the view's "Running terminals" list: every session in the daemon, from any vault, with its program, whether it's Claude, where it is (a workspace, Notes, or not in a tab), its folder and age. Sessions can be ended one at a time or selected and ended together, and ones not in a tab can be opened in one.
  - **The daemon reports** the foreground program and the shell's folder (polled each second, sent when they change) and OSC 9 / OSC 777 notifications. Programs are named by `argv[0]`, so Claude installed through npm shows as `claude`, not `node`. Protocol 2; the app still uses a busy protocol-1 daemon, without these events. An attach at 0×0 follows a session without resizing it: views in hidden workspaces do that until they're first shown.
  - **Notifications** from a terminal you aren't looking at show a toast with "Show", and bounce the Dock icon when the window isn't focused.
  - **Restore after a reboot:** tabs save the shell's current folder as it changes, so a replacement shell starts where the old one was.
  - **Choosing where a terminal starts** (added after the second half): "Open terminal here" on folders in the file tree, "New terminal in folder…" in the palette (vault folders, workspaces' folders, or any folder typed in), and "Change folder…" on a workspace's menu (new terminals start there; open ones stay put). Typed folders may start with `~`.
  - **Vault paths in terminal output are links:** vault-relative, absolute, or relative to the shell's folder, with spaces and an optional `:line`. They're found by looking for the vault's actual files in the line, so names with spaces work. The plugin's skill tells Claude to name files by path.
- Not yet: the packaged `.app` doesn't bundle `groundworkd` (Phase 8 packaging).

### Phase 5 — Projects, tickets, worktrees, actions
- Repos and components (`.groundwork/repos.yml`), project config (`.groundwork.yml`), trackers, and the machine-local repo mapping with first-run "locate repo"
- Project membership from `projects:` frontmatter plus folders; `groundwork context`, `code who`, `repo` and `project` commands
- Attach a workspace to any note; Note · Split · Workspace view modes
- Ticket quick-create (from a project, a repo, or any note; ad-hoc with no project or key), close and restore (git worktrees, repo and component setup, routing to projects)
- Actions system, scoped to vault, project, repo or component: Open in VS Code on the worktree toolbar, component commands, the actions menu, Open Jira ticket
- Tickets view (by repo, by project, ad-hoc), the `tickets` block, and adopting worktrees made outside Groundwork
- **Checkpoint:** run a real work ticket end to end, including one that spans two projects in a monorepo
- **Notes and terminals side by side** (decided 2026-11-04, replacing the 2026-11-03 decision that each workspace has its own tabs for everything):
  - Notes and pages live in **one dock**, the same in every view. **Workspaces hold only terminals**, each with its own tabs and splits, like cmux. One workspace is **current**.
  - **Three window views**, switched by icons in the top bar, by ⌃⌘1–3 or the palette: **Notes** alone, **Split** (notes on the left, the current workspace's terminals on the right, with a draggable divider) and **Terminals** alone, where the sidebar shows the workspaces instead of the files. ⌘1–9 pick a workspace and ⌃⌘] / ⌃⌘[ step through them. Opening a note from Terminals switches to Split; a new terminal from Notes does too. ⌘W closes the tab on the side last used. The links panel hides in Terminals.
  - **The top bar** runs across the window under macOS's transparent title bar (`titleBarStyle: Overlay`), beside the window buttons, and drags the window. It holds the view icons, the links-panel toggle and Settings.
  - **Keyboard shortcuts are configurable** in Settings (⌘,): click one and press new keys (they need ⌘, ⌃ or ⌥; Backspace clears). Keys taken from another command leave it with none. Changes are machine-local, in `settings.json` in the data folder (`settings.get` / `settings.set`), and apply in every vault. The registry is `app/src/state/keys.ts`; menus, tooltips and the palette show the current keys.
  - A terminal with no workspace to go in (⌘T when there's none) gets a new workspace named after its folder.
  - Layouts from before had notes in workspaces and terminals among the notes: the notes' tabs drop out of workspaces, and terminals in the notes layout leave their tabs (they keep running, under Running terminals).
  - **The terminals follow the notes** (built in a second stage): when a note opens, its workspace becomes current. That's the note's own (the workspace whose `note` it is), else the nearest above it: a folder note's (`Acme/Acme.md`) or a project overview's. With neither, nothing changes (later perhaps a generic workspace instead). Following never changes the view. A **pin** in the terminals' header (or the palette) keeps the current workspace; the header names it and says whether it's following or pinned, and its name switches workspace. **Picking** a workspace (the list, ⌘1–9, "Switch workspace…") opens its note on the left, if it has one. The rule is in `app/src/state/follow.ts`.
- Started 2026-11-04, without waiting for the Phase 4 checkpoint (the user's call). Built in two parts:
  1. **The model, API and CLI** *(built)*: config, repo locations, git worktrees, tickets, context, `code who`, actions.
  2. **The app** *(built)*: note workspaces and view modes, ticket creation, the tickets view and block, actions on ticket notes, close and restore.
- Built in the first part:
  - **Config** (`crates/core/src/config.rs`) is read fresh when needed, so edits in Obsidian or by Claude apply at once. A file that doesn't parse is an error naming it. Projects are found by walking the vault for `.groundwork.yml` (an empty one is fine). `config.yml` takes `work_folder` (default `Work`) for tickets no project claims.
  - **Repo locations** are kept per vault in the data folder (`vaults/<key>/repos.json`, beside `workspaces.json`) rather than one `machine.json`. Locating takes any folder in the checkout and finds its top; worktrees default to `<checkout>-worktrees` beside it. Paths may start with `~`.
  - **Git** goes through the `git` command (`crates/core/src/git.rs`). A new worktree uses the local branch if there is one, else tracks `origin/<branch>`, else branches from `origin/<base>` (or the local base). Git state: uncommitted changes, commits on no remote, whether the branch is on the remote, commits behind the base.
  - **Tickets** (`crates/core/src/tickets.rs`): `create` works out the key (from a URL with a tracker's pattern), projects, code and repo from each other (the one repo the code or projects use; else it asks which), makes the worktree, writes the note from the template (the home project's `tickets.template`, else the tracker's, else `Templates/Ticket.md`) with `ticket.key`, `ticket.title`, `jira.url`, `project.name` tags, sets the frontmatter, and makes a workspace linked to the note. Setup isn't run by `create`: the CLI runs it in its output, and the app will run it in the workspace's first terminal, where it's visible. Frontmatter is edited in place (`crates/core/src/frontmatter.rs`), leaving other properties and comments as written.
  - **Routing:** `tickets.match` rules aren't applied yet, since Groundwork can't read Jira itself; the agent flow (Phase 6) proposes projects. A ticket with no project goes to its repo's `home_project`, else the vault's work folder.
  - **Close** refuses, unless forced, when the worktree has uncommitted changes, unpushed commits or a branch missing from the remote. It ends terminals whose shell is inside the worktree, removes the worktree, deletes the workspace and drops `workspace:`, and sets `status: closed` and `closed:`. **Restore** brings the worktree back and makes a new workspace. **Strays** are worktrees of located repos that no ticket names; `create --adopt <path>` makes a note for one.
  - **Context** for a note, or for a folder in a worktree, a checkout or the vault. **Actions** are resolved per context: built-ins (Open in VS Code with a worktree on disk, Open Jira ticket), then the vault's, the projects', the repo's and the components' (`component:` on a repo action scopes it), then each component's `commands` as terminal actions. `{{worktree.path}}`, `{{repo.path}}`, `{{component.path}}`, `{{component.commands.x}}`, `{{ticket.key}}`, `{{jira.url}}`, `{{project.folder}}`, `{{vault.path}}` are filled in; an action whose variables don't apply here is left out. `shell` actions run in the background through a login shell (`action.run`), `terminal` and `url` ones in the app. `agent` actions wait for Phase 6. `show_on` isn't used yet: every action shows wherever it applies.
  - **Making projects:** a folder's menu has "New project…" (a new folder with an overview note named after it) and, on a folder that isn't one, "Make this a project" (its own note, like `Trip/Trip.md`, becomes the overview if it has one). Both write `.groundwork.yml` with the name (`project.create`, `groundwork project create <folder>`). Project folders have their own icon in the file tree.
  - **Workspaces** can belong to a note (`note` in the record, `workspace:` in the note). Deleting one removes the note's `workspace:`.
  - **CLI:** `context`, `project list|show`, `repo list|show|locate`, `ticket create|list|show|close|restore|strays`, `code who`. The SessionStart hook adds `groundwork context` output when the terminal is in a ticket's worktree, a checkout or a project folder.
- Built in the second part:
  - **The note bar** sits above the title of a ticket, or of any note with a workspace: key, status, branch and git state (refreshed every 15 seconds and on focus), the **Note · Split · Terminal** switch (the window's views, below, with the note's workspace made current), Open Jira ticket and Open in VS Code, an Actions menu, and Close ticket… or Restore. A new ticket opens in Split.
  - **New ticket** (palette, the Tickets view's +, a project folder's menu with the project chosen, "New worktree in…" with a repo chosen) is one dialog: key or Jira link, title, branch name, projects, repo (worked out from the projects and components unless chosen) and the components it touches. "Add worktree…" on any note makes that note the ticket, where it is. When the repo hasn't been located on this machine the app asks for its checkout and carries on. The setup runs in the workspace's first terminal.
  - **Close** in the app shows the git warnings and asks before forcing. **Strays** show under the Tickets view with Adopt, which opens the dialog for that worktree.
  - **The Tickets view** groups by project (the home project), repo or status, filters by text, hides closed tickets unless asked, and flags uncommitted changes, unpushed commits and commits behind. Rows open the note; their menu opens the workspace, the Jira ticket, or closes or restores.
  - **The `tickets` block** lists tickets live in any note. Lines: `project: this` (the note's project) or a project, `repo:`, `component:`, `status: active|closed|all`, `group: project|repo|status|none`.
  - **Any note can have a workspace** ("Open this note’s workspace", or "Open workspace" on a note in the file tree). It starts in the note's project folder, or the note's own folder.
  - **The Workspaces view** groups workspaces by their note's project (or repo). Each row shows its ⌘1–9 shortcut, faintly, and its terminal tabs are folded under a chevron until you open them (remembered per machine), so the row's badge stands for them; decided 2026-11-05. A ticket's workspace menu has "New terminal in <component>" for each component it touches, and "New terminal in…" lists them first; that stands in for a new-tab menu.

### Phase 6 — Claude integration
- Socket API plus the live CLI commands (open, workspace, tab, ask, notify)
- Plugin hooks: per-tab session tracking and live state badges
- Fork session
- Inbox panel, `groundwork ask` / `groundwork notify`, macOS notifications, dock badge
- Agent actions, including **New ticket from Jira**
- Todo triage skill (stale and overdue tasks become inbox questions)
- **Checkpoint:** agents create tickets, triage todos, ask you questions and report back
- Started 2026-11-04, after the Phase 5 checkpoint was left for the user to run when convenient. Built in three stages:
  1. **Agents report in** *(built)*: the app socket, hooks and agent states, the inbox, notifications and the dock badge.
  2. **Live CLI commands** *(built)*: `open`, `workspace`, `tab`; Fork session; Resume conversation.
  3. **Agent actions**: New ticket from Jira, the triage skill. Comes after Phase 7, which was pulled ahead of it (2026-11-05).
- Built in the first stage:
  - **The app socket** is `groundwork.sock` in the data folder, given to terminals as `GROUNDWORK_SOCKET` (`crates/backend/src/agents.rs`). It takes the same requests as the UI, a JSON line each way. The newest app or dev server to start takes it over.
  - **Hooks:** the plugin runs `hooks/run <event>` for SessionStart, UserPromptSubmit, Notification and Stop, which calls `groundwork hook session-start|prompt|notification|stop` only in a Groundwork terminal. The app keeps each terminal's Claude session id and state (idle, working, waiting, finished), in memory. Badges use the state while Claude is in the foreground: working is Running, Notification is Waiting on you, Stop is Finished until seen. A Notification also posts one attention item for the terminal, cleared by the next prompt or stop, or by looking at the terminal. Claude's reminder after a minute idle at its prompt ("Claude is waiting for your input") posts nothing: Stop already marked it finished.
  - **The inbox** is `inbox.json` in the data folder, app-wide rather than per vault (items note the vault). `groundwork ask` posts a question and waits (`inbox.wait`, in slices); `groundwork notify` posts and returns. With the app closed both write the file directly and `ask` watches it, so a question waits for the app to open; if the app closes mid-wait, `ask` carries on from the file. Done items are kept 30 days (at most 300), for the inbox's **Earlier** tab, which shows what was answered and with what, dismissed or seen; an agent can still read its answer meanwhile. `--timeout` withdraws an unanswered question.
  - **In the app:** an inbox button in the top bar (with a count, ⇧⌘I) opens a list, reloaded each time it opens and when the window regains focus: answer a question (a choice, or typed), follow an item's link, go to its terminal, or dismiss. A new item shows a toast while the window has focus (not for attention from the terminal on screen). In the background the desktop shell (`src-tauri/src/notifications.rs`, not the UI) sends a macOS notification and bounces the dock. A question's notification answers it in place: its choices in an "Answer" menu (a single choice is the button itself), or a reply field when it has none; typing an answer to a question with choices happens in the inbox. "Later" just hides it. Clicking a notification brings the app forward on the question (the inbox), the terminal for Claude waiting, or a note's link. When an item is answered or cleared elsewhere its notification is taken down, and the app clears leftovers from an earlier run on start. These use `NSUserNotification` through mac-notification-sys directly, since tauri-plugin-notification only sends a title and body (it's no longer used). The dock icon counts open items. macOS asks for permission the first time an app posts, and refuses notifications sent in another app's name when that app uses the newer notification API ("You can't mix modern clients with legacy clients": cmux, for one), so `make dev` runs the app inside a small `target/debug/Groundwork Dev.app` bundle (`scripts/dev-app`, a cargo runner) registered with LaunchServices, and notifications come from it (`dev.groundwork.app.dev`, "Groundwork Dev" in System Settings). The built app posts as itself. "Send a test notification" in the palette sends a sample question with choices five seconds later, so you can switch away (macOS doesn't show the frontmost app's notifications), and reports what you picked.
- Built in the second stage:
  - **The window does what the CLI asks.** Only the window has the tabs, so `app.open`, `app.showWorkspace`, `app.newTab` and `app.tabs` (and `agent.fork`) send it a `ui.command` event and wait up to 15 seconds for its `ui.reply` (`crates/backend/src/window.rs`, `app/src/state/remote.ts`). The backend checks what it can first: `open` resolves the note (a name, `[[link]]`, vault path, or absolute path in the vault) and refuses a missing one rather than creating it; workspaces are found by id or name. Making, changing or deleting a workspace sends `workspaces.changed`, so one made by the CLI shows at once.
  - **CLI** (`crates/cli/src/live.rs`; these need the app, and use the vault it has open): `open <note> [--line]`; `workspace list | create <name> [--cwd] [--open] | open <id|name>`; `tab list | new [--workspace] [--cwd] [--cmd] [--background] | send <text> [--tab] [--no-enter] | read [--tab] [--lines] | fork [--tab] [--background]`. `--tab` defaults to the terminal it runs in, and `tab new` to its workspace. `send` presses Enter separately, a moment after the text, so Claude Code takes it as submitting rather than part of a paste. `read` is a new daemon request (protocol 3: the scrollback and screen as plain text); a daemon from before it can't, until it's replaced once no terminals run.
  - **Fork session and Resume conversation** are on a terminal tab's right-click menu (the tab itself, or its row in the Workspaces sidebar), with Close tab. Each tab keeps the Claude session id its hooks last reported in its saved params, so both work after a restart. Fork opens a tab beside it, in its folder, typing `claude --resume <id> --fork-session` into a new shell; Resume types `claude --resume <id>` into the tab's own shell, and shows only while Claude isn't running there. `groundwork tab fork` does the same for agents (forking themselves by default). Session ids are checked before they're typed into a shell.
  - **e2e terminals** find the fake `claude` (`fixtures/bin/claude`, which echoes `--resume` calls) first on PATH, so tests never start the real one.

### Phase 7 — Quick add, people & events, settings
Asked for on 2026-11-05, before Phase 6's last stage: the Obsidian habits of a Quick add menu and formatting keys, people and events as first-class notes, and a view of each project's people and events. Design in §5.13.
- Settings in sections, one per feature, with Keyboard shortcuts as its own section listing every feature's commands
- Editor commands with shortcuts: checkbox, lists, bold, italic, highlight, link, date…
- Quick add (⇧⌘A): a menu of choices (new person, new event, capture a todo…), each with its own shortcut; configurable in Settings
- People and events conventions (§4.6), with built-in templates the vault's own override
- A project view: its people and events (and tickets), with search, filters and sort
- **Checkpoint:** capture people and events during a week of meetings with Quick add, and find them from each project's view
- Built in two stages:
  1. **Settings, editor commands, Quick add**, with the people and events conventions *(built)*.
  2. **The project view.**
- Built in the first stage:
  - **Settings** has Quick add and Keyboard shortcuts sections down its side (`SettingsDialog.tsx`); the shortcuts have a search. The key registry takes commands made from settings (`useKeys.extra`), which is how each Quick add choice gets a shortcut; renaming a choice keeps it.
  - **Editor commands** (`app/src/editor/commands.ts`) act on every selection: toggle checkbox (⇧⌘2: text or a list item becomes `- [ ]`, a task is checked with its ✅ date or unchecked), bulleted and numbered lists, bold ⌘B, italic ⌘I, strikethrough, highlight, inline code (each wraps or unwraps), link ⌘K (a selected URL becomes the target), today's date and the time. Their keys only act in an editor, so ⌘K and the rest still reach terminals and fields.
  - **Quick add** (`crates/core/src/quickadd.rs`, `app/src/state/quickadd.ts`): `quickAdd.list|save|form|run`, and `groundwork add` on the CLI. The form asks the prompts in the name and template (one answer per label), a date when either uses `{{date}}`, and the project (the note you're in, else the current workspace's note). A capture whose line is a task (`- [ ] …`) goes through `todo add`, under `## Todos` with its ➕ stamp. Built-in `Person.md` and `Event.md` stand in for missing templates; Settings marks them "(built in)". Dialogs gained date and menu fields.

### Phase 8 — Smart search, command bar, polish
- qmd integration (collection registration, auto-update, `search --smart`)
- Global-hotkey command bar
- A "who knows about X" skill (backlinks + qmd), over Phase 7's people and events
- Performance pass on a large vault; packaging (signed `.app`). The bundle ships the CLI next to the app binary (Tauri `externalBin`, so the setup link keeps working) and the plugin marketplace in its resources (`Contents/Resources/claude-marketplace`, which `SetupEnv::detect` already looks for).
- **Checkpoint:** full workflow review

### Backlog (later, to discuss)
- Menu bar presence (quick capture, inbox count, active agents)
- Internal scheduler for background agents (external for now, e.g. Claude scheduled jobs)
- Databases (Dataview/Bases-style or something richer); to be designed later
- MCP server wrapper
- Real Jira API integration (status and title sync)
- Graph view, themes, plugin system, other agents (Codex…), multi-repo tickets (one worktree per repo)
- A CSV viewer you can edit (a table, not text). Until then, only notes are editable in the app; pages, CSVs and other files open read-only. Pages can't write vault files either: data a page lets you change lives in its state (the fixture's `login-flow.page` shows the pattern).
- Search over HTML pages; ghostty-web terminal renderer; other platforms

---

## 7. Testing strategy

- **Rust:**
  - unit tests for parsing, link resolution and rename rewriting (the riskiest code, because it touches your files)
  - integration tests against `fixtures/vault`
  - git worktree tests against temporary repos
- **Frontend:** Vitest for editor extensions and rendering plugins.
- **End to end (Playwright):**
  - The UI runs in **browser dev mode** against the real Rust backend over the dev WebSocket.
  - Tests use Playwright's WebKit engine, which is close to the WKWebView that Tauri uses on macOS.
  - Playwright can't drive the packaged Tauri window itself, because Tauri's WebDriver support doesn't cover macOS. Browser dev mode is the workaround.
  - Claude uses the Playwright MCP server, when available, to click through features and take screenshots before each checkpoint.
- **Daemon:** tests for spawn, attach, detach, snapshot and kill.
- **Manual:** a short "try this" list at each checkpoint.

---

## 8. Open questions

None right now.

**Resolved:**
- **Todo format:** Tasks-plugin emoji markers (`📅 ➕ ✅`), with p0–p5 priorities mapped to the plugin's markers.
- **Carry-over:** a live view; todos stay where they were written and today's note shows them.
- **Projects vs. repos:** separate concepts (§4.3–4.5). A project may use several repos or none, a repo may serve many projects, and tickets and notes can belong to several projects.
- **Existing vault:** not needed. Development uses a fixture vault and a fresh dogfood vault.
- **Jira:** an Atlassian MCP server will usually be available to Claude Code. When it isn't, the agent flow falls back to asking you for the title through the inbox.
- **Frontend:** React.
- **Templates:** Groundwork's own `{{…}}` syntax (§5.3), not Templater.
