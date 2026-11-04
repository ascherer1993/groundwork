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

## Projects

The design (folders containing `.groundwork.yml`, `projects:` frontmatter linking a note to project overview notes) is planned, but the app doesn't use it yet and the CLI has no `project` commands. A note can already carry `projects: ["[[Acme]]"]`, since that's an ordinary link. If asked to create a project, tell the user that projects aren't supported yet. Offer a folder with an overview note, and copy an existing project's `.groundwork.yml` only if one exists in the vault.

## Asking the user

For now, ask questions in the conversation. (A `groundwork ask` command that shows the question in the app is planned.)
