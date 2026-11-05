---
name: groundwork
description: Use when working in the user's Groundwork notes vault (an Obsidian-compatible folder of Markdown notes) — reading or writing notes, daily notes, todos, templates, interactive HTML pages, or searching what they've written. Covers the vault's conventions and the `groundwork` CLI.
---

# Working in a Groundwork vault

Groundwork is the user's notes app. The vault is a plain folder of Markdown notes that also opens in Obsidian, so everything you write must stay valid Obsidian Markdown. The `groundwork` CLI works on the files directly; the app doesn't need to be running.

## Finding the vault

Run `groundwork vault` first. It prints the vault the commands will use and why. In order, it picks: `--vault <path>`, `$GROUNDWORK_VAULT`, the vault containing the current folder, the default vault chosen in the app ("Set up Claude Code…"), then the vault the app opened last. If the answer is "the vault Groundwork opened last" and the user hasn't told you which vault they mean, confirm with them before changing anything, or pass `--vault`.

All paths in output are relative to the vault root.

Add `--json` to any command for machine-readable output. Prefer it when you'll parse the result.

## What the user sees

Groundwork is a desktop app. It shows the vault as a file tree, notes in tabs (live preview, source or reading view), a backlinks panel, and terminal tabs. You may be running in one of those terminals: `$TERM_PROGRAM` is `Groundwork` there. Files you write show up in the app as soon as you save them, so the user never needs to reload.

- **The file tree is what `groundwork files` lists.** Hidden folders (`.obsidian/`, `.groundwork/`) and the files inside a `.page` bundle aren't shown. They're app config and page internals, so leave them out when you describe or map the vault.
- **Notes render the way Obsidian renders them:**
  - wikilinks and `![[embeds]]`, including embedded pages
  - callouts (`> [!note]`) and footnotes
  - math (`$x^2$`, `$$…$$`)
  - highlighted code blocks
  - Mermaid diagrams in ```` ```mermaid ```` blocks
  - tasks, and `todos` blocks (see Daily notes)

  Write these directly. Don't read Groundwork's source code or install tools to check that something renders. If a diagram is unusual, ask the user how it looks.
- **Links to notes that don't exist yet are normal**, as in Obsidian: clicking one creates the note. A daily note linking to the previous day's note is a common example. Call these "not created yet", not "broken".
- **In a Groundwork terminal, vault paths you print are links.** The user can click `Projects/Acme/Kickoff notes.md` (or an absolute path into the vault, with an optional `:line`) to open it, so name the files you created or changed by their path.
- **For an overview of the whole vault**, run `groundwork files` and `groundwork links --all` (add `--json` to parse them). Don't walk the folders with `find`, or call `note info` once per note.

## Rules

- **Never touch `.obsidian/`.** It belongs to Obsidian. Groundwork's own config is in `.groundwork/`; don't edit that either unless asked.
- **Links are wikilinks:** `[[Note name]]`, `[[Note#Heading]]`, `[[Note|shown text]]`, `![[image.png]]`. Use the note's file name without `.md`. Check that a name exists with `groundwork note path "<name>"` before linking to it, unless you mean to link to a note that doesn't exist yet.
- **Don't rename or move notes by hand.** Other notes link to them, and a plain `mv` breaks those links. Ask the user to rename in the app, which rewrites links.
- **Add todos with `groundwork todo add`**, not by writing the line yourself. It adds the `➕ created` stamp, places the todo under the note's `## Todos` heading, and logs it. Change todos with `todo done|cancel|reopen|reschedule|priority <id>`.
- **Create notes from templates with `groundwork note create --template`** when a template fits (`groundwork template list`). Templates fill in dates, titles and the `created:` property.
- New notes get a `created: YYYY-MM-DDTHH:mm` property. `note create` adds it; add it yourself if you write a new file directly.
- Editing the body of an existing note directly is fine. Keep the frontmatter (`---` block) valid YAML.

## Commands

```sh
# Notes
groundwork note read <note>             # print a note (name, link text or path)
groundwork note path <note>             # resolve a name to its vault path
groundwork note info <note> [--json]    # properties, tags, headings, links, backlinks, todos
groundwork note create <path> [--template <t>] [--var Label=value]... [--date <d>] [--text <text>|-]
groundwork links <note>                 # outgoing links of a note or page (missing targets marked)
groundwork backlinks <note>             # path:line: context for every link to it, from notes and pages
groundwork files [--path <folder>]      # every note, page and file, as the file tree shows them
groundwork links --all                  # every link in the vault: source -> target
groundwork search <words...> [--limit N]

# Templates and daily notes
groundwork template list
groundwork template render <template> [--note <path>] [--var Label=value]...
groundwork daily [--date today|yesterday|fri|+1d|nov 12|YYYY-MM-DD]   # prints the path, creating it if needed

# Todos
groundwork todo list [--due overdue|today|week|any|none] [--priority p0-p1] [--tag t]... [--path p] [--status open|done|cancelled|all] [--stale 14d] [--text t]
groundwork todo add "text" [--due fri] [--priority p2] [--note <note>]   # default: today's daily note
groundwork todo done|cancel|reopen <id>
groundwork todo reschedule <id> <date|none>
groundwork todo priority <id> p1

# HTML pages
groundwork page state <page> [--set <json>|-]   # what a page saved; --set replaces it

# Which vault, and what changed
groundwork vault                        # the vault in use, and why
groundwork activity [--since 7d|24h|YYYY-MM-DD] [--path <prefix>] [--json]
```

**Search syntax:** all words must appear. `"exact phrase"`, `-exclude`, `path:Projects/Acme`, `#tag` (also matches nested tags like `#tag/sub`).

**Writing a note's text:** for anything longer than a line, pipe it in with `--text -`:

```sh
groundwork note create "Projects/Acme/Planning" --text - <<'EOF'
---
projects: ["[[Acme]]"]
---
# Planning

Notes from the call with [[Jane Doe]].
EOF
```

`note create` adds `created:` to the frontmatter (or a frontmatter block if there's none).

**Template prompts:** if a template contains `{{prompt:Attendees}}`, `note create` refuses until you pass `--var Attendees=...`. The error names every missing label.

## Todos

A todo is a Markdown task line with Obsidian Tasks emoji metadata:

```markdown
- [ ] Ask [[Jane Doe]] about the auth migration ⏫ 📅 2026-11-05 ➕ 2026-11-03
```

| Marker | Meaning |
|---|---|
| `📅 date` | due |
| `⏳ date` | scheduled |
| `➕ date` | created |
| `✅ date` / `❌ date` | done / cancelled (added by `todo done` / `todo cancel`) |
| `🔺 ⏫ 🔼` (none) `🔽 ⏬` | priority p0, p1, p2, p3 (default), p4, p5 |

Statuses: `[ ]` open, `[x]` done, `[-]` cancelled, `[/]` in progress.

**Ids.** `todo list` prints an id under each todo, like `Daily/2026-11-03.md:9:3f2a91c0` (path, zero-based line, hash of the text). Use it with the other `todo` commands. If the note changed since you listed, the command fails with "changed since it was listed": run `todo list` again for fresh ids rather than guessing.

**Dates** accept `today`, `tomorrow`, weekday names (`fri` means the next Friday), `+3d`, `+2w`, `+1m`, `nov 12`, or `YYYY-MM-DD`.

**Priorities** order what to raise with the user: overdue p0/p1 todos matter most. When the user asks what's on their plate, start with `groundwork todo list --due today` and `--due overdue`.

## Daily notes

Daily notes live in the daily notes folder (often `Daily/`), named by date. They usually contain a `todos` block:

````markdown
```todos
day
```
````

In the app this renders as a live list for that note's date: overdue, due, carried over from earlier days, and done. Leave these blocks as they are. Todos aren't copied between days; the block shows them where they live.

## HTML pages

Groundwork shows HTML pages live, in a tab or embedded in a note. Build one when a note can't show what's needed: a dashboard, a demo, a comparison the user clicks through, a form whose answers you read back.

- **A single file** `Name.html` (CSS and JS inline), or **a bundle**: a folder `Name.page/` with an `index.html` and any other files (scripts, CSS, data). A bundle shows as one item.
- **Link** with the extension: `[[Name.html]]`, `[[Name.page]]`. **Embed** in a note with `![[Name.page]]`, which sizes itself to the content, or `![[Name.page|400]]` for 400 pixels tall.
- **Write the files directly**; there's no `page create`. Open pages reload when their files change.
- **Relative URLs load vault files:** `<script type="module" src="app.js">`, `fetch("data.json")`, `<img src="../diagram.png">`. Network access (CDNs, APIs) works unless `.groundwork/config.yml` sets `pages: { allow_network: false }`, but prefer no external dependencies so pages work offline.
- **Pages are sandboxed.** They can't touch the app, and `localStorage` only lasts until the page reloads. Keep anything that should last in `groundwork.state`.
- **Follow light and dark mode:** `:root { color-scheme: light dark; }`, plus `@media (prefers-color-scheme: dark)` for your own colours.
- **Links to notes open in Groundwork:** `<a href="../Plan.md">` or `<a href="[[Plan]]">`. Web links open in the browser. These links count as backlinks, but renaming a note doesn't rewrite them, so check a page's links after a rename.

The bridge, `window.groundwork`, is there before the page's own scripts run:

```js
groundwork.path                          // this page's vault path
await groundwork.state.get()             // the saved state, or null
await groundwork.state.set({ chosen: "B" })  // replace it; anything JSON can hold
groundwork.onStateChange((state) => {})  // the state changed elsewhere (e.g. `page state --set`)
await groundwork.readFile("data.csv")    // a vault file's text: relative to the page, "/" for the vault root
await groundwork.navigate("[[Plan]]")    // open a note in Groundwork
```

**Reading back what the user did:** `groundwork page state <page>` prints the saved state. It's kept in `Name.page/state.json`, or `.groundwork/page-state/<path>.json` for a single file; `--json` says which. Shape the state so you can read it without the page: `{ "chosen": "Option B", "why": "..." }`, not indexes into a list. `--set` replaces the state, and an open page updates live.

A typical flow: build the page, ask the user to open it in Groundwork and tell you when they're done, then run `groundwork page state`.

## Projects, repos and tickets

- **A project** is any folder with a `.groundwork.yml` (name, overview note, work folder, the `code` it uses). Make one with `groundwork project create`. A note belongs to the projects linked in its `projects:` frontmatter (`projects: ["[[Acme]]"]`, links to overview notes) plus the project folder it's in.
- **Repos** are defined once in `.groundwork/repos.yml`, with optional components (a part of a monorepo with its own path, setup, commands and docs). Code is named `repo` or `repo:component`. Where a repo is checked out is per machine: `groundwork repo locate`.
- **A ticket** is a note with `type: ticket` frontmatter (`ticket`, `jira`, `projects`, `code`, `repo`, `worktree`, `branch`, `status`, `workspace`). It usually has a git worktree in the repo's worktree folder and a workspace in the app whose terminals open there.
- **Find your bearings with `groundwork context`** before working on code or a ticket: run in a worktree, it names the ticket, its projects, the components involved with their commands and docs to read first, the actions, and notes worth reading. The repo's own `CLAUDE.md` and READMEs stay the source of truth for how its code works.
- **Make tickets with `groundwork ticket create`**, never by hand: it makes the branch and worktree, runs setup, writes the note from the ticket template and links everything. Fill in the note's summary afterwards. Don't edit `.groundwork.yml` or `repos.yml` unless asked.

```sh
groundwork context [--note <note> | --cwd <dir>] [--json]   # default: the current folder
groundwork project list | show <project>
groundwork project create <folder>     # makes a folder (new or existing) a project
groundwork repo list | show <repo>
groundwork repo locate <repo> <path> [--worktrees <dir>]
groundwork ticket create [--key INT-123|<url>] [--title "Fix login"] [--slug fix-login] [--project <p>]... [--code repo:component]... [--repo <r>] [--note <existing note>] [--no-worktree] [--no-setup]
groundwork ticket list [--repo r] [--project p] [--status active|closed|all] [--component repo:c]
groundwork ticket show <note>          # details and the worktree's git state
groundwork ticket close <note> [--force]   # removes the worktree; refuses if work would be lost
groundwork ticket restore <note>
groundwork ticket strays               # worktrees without a ticket note (adopt with create --adopt <path>)
groundwork code who <path|repo:path>   # components, projects and open tickets touching it
```

The first project in `--project` is the ticket's home: its note goes in that project's work folder. A ticket that affects two projects gets both. Ask the user which projects and components a ticket touches when the request doesn't say.

## Asking the user

When the user is in the conversation, ask there. When they may be elsewhere (a long task, a background agent, a terminal they aren't watching), use Groundwork's inbox:

```sh
groundwork ask "Which environment should I deploy to?" --choice staging --choice prod [--link "[[Note]]"] [--timeout 600]
groundwork notify "Reorganised Meetings/ into one folder per month" [--link "[[Meetings]]"]
```

- `ask` shows the question in the app's inbox (with a macOS notification when the app is in the background), waits, and prints the answer. Choices are suggestions; the user can type something else. It fails if the user dismisses the question or `--timeout` passes, so decide what to do then.
- `notify` posts something to know and returns at once. Use it when you finish something the user should look at, not for every step.
- Both work while the app is closed: the item waits in the inbox until it opens. `--link` points at the note it's about.

## The app's window: opening notes, workspaces and terminal tabs

These act on the running app (they fail if it isn't open) and the vault it has open:

```sh
groundwork open <note|path> [--line N]  # show a note, page or file in the window
groundwork workspace list               # id · name · folder · note
groundwork workspace create <name> [--cwd <folder>] [--open]
groundwork workspace open <id|name>
groundwork tab list                     # id · workspace · title; marks this tab
groundwork tab new [--workspace <id|name>] [--cwd <folder>] [--cmd "<command line>"] [--background]   # prints its id
groundwork tab send "<text>" [--tab <id>] [--no-enter]   # types it, then presses Enter
groundwork tab read [--tab <id>] [--lines N]             # what the tab shows, as text
groundwork tab fork [--tab <id>] [--background]          # fork a Claude Code tab's conversation into a new tab
```

- Tab ids are terminal ids: `GROUNDWORK_TAB_ID` is yours, and `--tab` defaults to it. `tab new` joins your workspace unless told otherwise.
- After writing or changing a note the user should look at, `groundwork open` it rather than describing where it is.
- To run something long next to you (a dev server, tests), `tab new --cmd "..." --background`, then `tab read --tab <id> --lines 40` to see how it's going. Don't `tab send` into a tab the user is working in without being asked.
- `tab fork` with no `--tab` forks your own session: the new tab carries on this conversation separately.
