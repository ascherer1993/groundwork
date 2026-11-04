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
    terminal-daemon/        # PTY daemon binary, groundworkd (Phase 4)
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
```

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
- Pages are served through a custom `groundwork://` protocol, so relative assets and vault links resolve.
- **Bridge API** injected as `window.groundwork`:
  - `navigate("[[Some Note]]")`
  - `readFile(path)`
  - `state.get()` and `state.set(obj)`, persisted to `foo.page/state.json` or to `.groundwork/page-state/<path>.json`
  - `onStateChange`
- Claude can read the state file to see what you clicked or chose.
- Network access is controlled by a setting (on by default, so dashboards can fetch external data).
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
- **Navigation:** Cmd-click a link to open it in a new tab, hover a link to preview it, and get autocomplete for `[[`.

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
- `links` / `backlinks <note>`
- `search <q>` (full text) and `search --smart <q>` (qmd)
- `template list` / `template show`
- `daily [--date]`
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

### Phase 2 — Templates, daily notes, search, CLI v1 *(built, awaiting checkpoint)*
- Templates using the `{{…}}` syntax (date offsets, anchors, prompts)
- Daily notes, command palette (Cmd+P), full-text search UI, tags pane
- Todos: `@date` entry, automatic stamps, the `todos` block (day view with carry-over), Todos panel; todo events in the activity log
- `groundwork` CLI: the file-based commands (note, links, backlinks, search, template, daily, todo, note info, activity)
- First version of the Claude Code plugin skill, so Claude can work on the vault through the CLI
- **Checkpoint:** run a week of daily notes and todos; create notes from templates in the app and through Claude
- Built:
  - `crates/cli` is the `groundwork` binary, built next to the app by `make dev`/`make browser`. It works on the files through `Session::open_for_tool`, which logs as `cli` and leaves the change-detection snapshot to the app. `groundwork vault` says which vault it's using and why.
  - The plugin lives in `claude-plugin/`, listed by the repo's `.claude-plugin/marketplace.json`. For now it has only the `groundwork` skill; hooks, `ask` and `notify` come with terminals.
  - "Set up Claude Code…" (§5.7) installs both and sets the CLI's default vault. It was pulled forward from Phase 7's "CLI install" so the checkpoint doesn't need manual setup.

### Phase 3 — HTML pages
- `groundwork://` protocol, page viewer with auto-reload, read-only source view
- `.page` bundles shown as single items; `[[x.page]]` / `[[x.html]]` links, backlinks to pages; links inside pages open notes
- `![[x.page]]` live interactive embeds with automatic height
- Bridge API (`navigate`, `readFile`, `state`) and persisted page state; network setting
- Skill update so Claude knows how to build pages and read their state
- **Checkpoint:** Claude builds an interactive page; you use it and Claude reads the state back

### Phase 4 — Terminals & workspaces
- `groundworkd` daemon, xterm.js tabs, splits
- Standalone workspaces, the cmux-style Workspaces view, the session manager
- Persistence across app restarts; layout restore after a reboot
- Claude Code ergonomics (Shift+Enter, links, notifications)
- **Checkpoint:** use Groundwork instead of cmux for a few days

### Phase 5 — Projects, tickets, worktrees, actions
- Repos and components (`.groundwork/repos.yml`), project config (`.groundwork.yml`), trackers, and the machine-local repo mapping with first-run "locate repo"
- Project membership from `projects:` frontmatter plus folders; `groundwork context`, `code who`, `repo` and `project` commands
- Attach a workspace to any note; Note · Split · Workspace view modes
- Ticket quick-create (from a project, a repo, or any note; ad-hoc with no project or key), close and restore (git worktrees, repo and component setup, routing to projects)
- Actions system, scoped to vault, project, repo or component: Open in VS Code on the worktree toolbar, component commands, the actions menu, Open Jira ticket
- Tickets view (by repo, by project, ad-hoc), the `tickets` block, and adopting worktrees made outside Groundwork
- **Checkpoint:** run a real work ticket end to end, including one that spans two projects in a monorepo

### Phase 6 — Claude integration
- Socket API plus the live CLI commands (open, workspace, tab, ask, notify)
- Plugin hooks: per-tab session tracking and live state badges
- Fork session
- Inbox panel, `groundwork ask` / `groundwork notify`, macOS notifications, dock badge
- Agent actions, including **New ticket from Jira**
- Todo triage skill (stale and overdue tasks become inbox questions)
- **Checkpoint:** agents create tickets, triage todos, ask you questions and report back

### Phase 7 — Smart search, command bar, polish
- qmd integration (collection registration, auto-update, `search --smart`)
- Global-hotkey command bar
- Contacts conventions, and a "who knows about X" skill (backlinks + qmd)
- Performance pass on a large vault; packaging (signed `.app`). The bundle ships the CLI next to the app binary (Tauri `externalBin`, so the setup link keeps working) and the plugin marketplace in its resources (`Contents/Resources/claude-marketplace`, which `SetupEnv::detect` already looks for).
- **Checkpoint:** full workflow review

### Backlog (later, to discuss)
- Menu bar presence (quick capture, inbox count, active agents)
- Internal scheduler for background agents (external for now, e.g. Claude scheduled jobs)
- Databases (Dataview/Bases-style or something richer); to be designed later
- MCP server wrapper
- Real Jira API integration (status and title sync)
- Graph view, themes, plugin system, other agents (Codex…), multi-repo tickets (one worktree per repo)
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
