/**
 * Projects, repos and tickets (PLAN §5.6): what the backend knows, kept
 * fresh as the vault changes, and the flows around them: making a ticket
 * (locating its repo first if needed), opening its workspace with setup
 * running, closing and restoring, a note's Note · Split · Workspace modes,
 * and running actions.
 */
import { create } from "zustand";
import { api } from "../api/client";
import type { Action } from "../api/generated/Action";
import type { CreatedTicket } from "../api/generated/CreatedTicket";
import type { NewTicket } from "../api/generated/NewTicket";
import type { ProjectInfo } from "../api/generated/ProjectInfo";
import type { RepoInfo } from "../api/generated/RepoInfo";
import type { SetupStep } from "../api/generated/SetupStep";
import type { Ticket } from "../api/generated/Ticket";
import { openExternalUrl } from "../lib/fileUrl";
import { launchAgent } from "./claude";
import { projectViewPath } from "../lib/paths";
import { confirmDialog, formDialog, type MenuEntry, useUi } from "./ui";
import { message, onVaultChange, useVault } from "./vault";
import { isTerminal, type TerminalParams, useWorkspace } from "./workspace";
import { useWorkspaces } from "./workspaces";

interface TicketsState {
  /** Every ticket, closed ones too. */
  tickets: Ticket[];
  projects: ProjectInfo[];
  repos: RepoInfo[];
  /** Why the config couldn't be read, if it couldn't. */
  error: string | null;
  /** The new-ticket dialog, with what it starts filled in with. */
  draft: NewTicket | null;
  load(): Promise<void>;
  /** Opens the new-ticket dialog. */
  newTicket(prefill?: NewTicket): Promise<void>;
  closeDraft(): void;
}

export const useTickets = create<TicketsState>((set) => ({
  tickets: [],
  projects: [],
  repos: [],
  error: null,
  draft: null,

  async load() {
    try {
      const [tickets, projects, repos] = await Promise.all([
        api.tickets({ status: "all" }),
        api.projects(),
        api.repos(),
      ]);
      set({ tickets, projects, repos, error: null });
    } catch (err) {
      set({ tickets: [], projects: [], repos: [], error: message(err) });
    }
  },

  async newTicket(prefill = {}) {
    await useTickets.getState().load();
    const { error } = useTickets.getState();
    if (error) {
      useUi.getState().notify(error);
      return;
    }
    set({ draft: prefill });
  },

  closeDraft: () => set({ draft: null }),
}));

let reloadTimer: ReturnType<typeof setTimeout> | null = null;
/** Starts following the vault; once, when a vault opens. */
export function watchTickets() {
  void useTickets.getState().load();
  if (watching) return;
  watching = true;
  onVaultChange(() => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void useTickets.getState().load(), 200);
  });
}
let watching = false;

export function ticketAt(path: string | null | undefined): Ticket | undefined {
  return path ? useTickets.getState().tickets.find((t) => t.path === path) : undefined;
}

/** `cd`s between folders, stopping at the first failure. */
export function setupLine(steps: SetupStep[]): string | undefined {
  const first = steps[0];
  if (!first) return undefined;
  const quote = (s: string) => (/^[\w/.+=:,@%-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  const parts = [`cd ${quote(first.cwd)}`];
  let cwd = first.cwd;
  for (const step of steps) {
    if (step.cwd !== cwd) {
      cwd = step.cwd;
      parts.push(`cd ${quote(cwd)}`);
    }
    parts.push(step.command);
  }
  if (cwd !== first.cwd) parts.push(`cd ${quote(first.cwd)}`);
  return parts.join(" && ");
}

/** Asks where a repo is checked out on this machine. Resolves `true` once recorded. */
export async function locateRepo(id: string): Promise<boolean> {
  const repo = useTickets.getState().repos.find((r) => r.id === id);
  const values = await formDialog({
    title: `Where is ${repo?.name ?? id}?`,
    message:
      "Its main checkout on this Mac (any folder in it). Unless you choose a folder, worktrees go in “<checkout>-worktrees” beside it (dev/api → dev/api-worktrees).",
    fields: [
      { label: "Checkout", value: repo?.location?.path ?? "~/", type: "folder" },
      {
        label: "Worktrees folder",
        value: repo?.location?.worktrees ?? "",
        type: "folder",
        placeholder: "<checkout>-worktrees",
      },
    ],
    confirmLabel: "Save",
  });
  const [path, worktrees] = values ?? [];
  if (!path?.trim()) return false;
  try {
    await api.locateRepo(id, path.trim(), worktrees?.trim() || undefined);
    await useTickets.getState().load();
    return true;
  } catch (err) {
    useUi.getState().notify(message(err));
    return false;
  }
}

const NOT_LOCATED = /^the (.+) repo hasn't been located on this machine$/;

/** Makes a ticket, locating its repo first if this machine doesn't know it. Then opens it. */
export async function createTicket(ticket: NewTicket): Promise<boolean> {
  for (;;) {
    try {
      const created = await api.createTicket(ticket);
      await openCreated(created);
      return true;
    } catch (err) {
      const repo = message(err).match(NOT_LOCATED)?.[1];
      if (repo && (await locateRepo(repo))) continue;
      if (!repo) useUi.getState().notify(message(err));
      return false;
    }
  }
}

/**
 * Shows a new (or restored) ticket in its workspace: the note on the left,
 * a terminal running the worktree's setup on the right.
 */
async function openCreated(created: CreatedTicket) {
  void useTickets.getState().load();
  const workspace = created.workspace;
  if (!workspace) {
    useWorkspace.getState().open(created.ticket.path);
    return;
  }
  await useWorkspaces.getState().refresh();
  await useWorkspaces.getState().ready(workspace.id);
  await showSplit(created.ticket.path, workspace.id, setupLine(created.setup));
}

/** The note beside its workspace's terminals. `run` goes to a new terminal. */
export async function showSplit(path: string, workspace: string, run?: string) {
  const ws = useWorkspace.getState();
  if (!ws.docks[workspace]) return;
  ws.showWorkspace(workspace, "split");
  const tab = ws.fileTab(path);
  if (tab) tab.api.setActive();
  else ws.open(path);
  if (run || !ws.docks[workspace]!.panels.length) await ws.openTerminal(undefined, { run });
}

/** Closes a ticket after confirming, saying what would be lost. */
export async function closeTicket(path: string): Promise<void> {
  const ticket = ticketAt(path);
  const name = ticket?.title ?? path;
  let git;
  try {
    git = await api.ticketGit(path);
  } catch (err) {
    useUi.getState().notify(message(err));
    return;
  }
  const warnings: string[] = [];
  if (git.exists) {
    if (git.dirty) warnings.push("it has uncommitted changes");
    if (git.unpushed > 0)
      warnings.push(
        git.unpushed === 1 ? "1 commit isn't pushed" : `${git.unpushed} commits aren't pushed`,
      );
    else if (!git.onRemote) warnings.push("its branch isn't on the remote");
  }
  const ok = await confirmDialog({
    title: `Close “${name}”?`,
    message: warnings.length
      ? `Its worktree has work that would be lost: ${warnings.join(", ")}. Close anyway?`
      : git.exists
        ? "Its worktree is removed and its terminals end. The note stays."
        : "Its terminals end. The note stays.",
    confirmLabel: warnings.length ? "Close anyway" : "Close ticket",
    danger: warnings.length > 0,
  });
  if (!ok) return;
  // Its tabs close as their terminals end, and another workspace takes its place.
  const workspace = ticket?.workspace;
  const terminals = workspace
    ? (useWorkspace.getState().docks[workspace]?.panels ?? [])
        .filter(isTerminal)
        .map((p) => (p.params as unknown as TerminalParams).terminal)
    : [];
  try {
    await api.closeTicket(path, warnings.length > 0);
    await Promise.all(terminals.map((t) => api.killTerminal(t).catch(() => {})));
    await useWorkspaces.getState().refresh();
    await useTickets.getState().load();
    useUi.getState().notify(`Closed “${name}”`);
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

export async function restoreTicket(path: string): Promise<void> {
  for (;;) {
    try {
      await openCreated(await api.restoreTicket(path));
      return;
    } catch (err) {
      const repo = message(err).match(NOT_LOCATED)?.[1];
      if (repo && (await locateRepo(repo))) continue;
      if (!repo) useUi.getState().notify(message(err));
      return;
    }
  }
}

/**
 * The repo a folder on this Mac is in (its main checkout or its worktrees
 * folder, the innermost if they nest), by name. `null` outside every
 * located repo.
 */
export function repoOfFolder(folder: string | undefined): string | null {
  if (!folder) return null;
  const inside = (root: string) =>
    folder === root || folder.startsWith(root.endsWith("/") ? root : `${root}/`);
  let best: { id: string; length: number } | null = null;
  for (const r of useTickets.getState().repos) {
    for (const root of [r.location?.path, r.location?.worktrees]) {
      if (root && inside(root) && (!best || root.length > best.length))
        best = { id: r.id, length: root.length };
    }
  }
  return best ? repoName(best.id) : null;
}

/** A repo's name, as `repos.yml` gives it. */
export function repoName(id: string): string {
  return useTickets.getState().repos.find((r) => r.id === id)?.name ?? id;
}

/**
 * Gives a ticket a worktree in another repo (asking which, and where it's
 * checked out if this Mac doesn't know), then runs its setup in a new
 * terminal there, in the ticket's workspace.
 */
export async function addTicketRepo(path: string, repo?: string): Promise<void> {
  await useTickets.getState().load();
  const ticket = ticketAt(path);
  if (!ticket) return;
  if (!repo) {
    const have = new Set(ticket.worktree ? ticket.repos.map((r) => r.id) : []);
    const choices = useTickets.getState().repos.filter((r) => !have.has(r.id));
    useUi.getState().openPalette({
      placeholder: `Add a repo to “${ticket.title}”…`,
      items: [
        ...choices.map((r) => ({
          id: r.id,
          label: r.name,
          detail: r.location ? (r.description ?? undefined) : "not located on this Mac yet",
          run: () => addTicketRepo(path, r.id),
        })),
        {
          id: "new-repo",
          label: "Another repo, from its checkout…",
          detail: "adds it to the vault’s repos",
          run: async () => {
            const id = await addRepo();
            if (id) await addTicketRepo(path, id);
          },
        },
      ],
    });
    return;
  }
  for (;;) {
    try {
      const created = await api.addTicketRepo(path, repo);
      void useTickets.getState().load();
      const added = created.ticket.repos.find((r) => r.id === repo)?.worktreePath;
      const workspace = created.workspace;
      if (workspace) {
        await useWorkspaces.getState().refresh();
        await useWorkspaces.getState().ready(workspace.id);
        const ws = useWorkspace.getState();
        ws.showWorkspace(workspace.id, ws.view === "note" ? "split" : ws.view);
        await ws.openTerminal(added ?? undefined, { run: setupLine(created.setup) });
      }
      useUi.getState().notify(`Added ${repoName(repo)} to “${created.ticket.title}”`);
      return;
    } catch (err) {
      const missing = message(err).match(NOT_LOCATED)?.[1];
      if (missing && (await locateRepo(missing))) continue;
      if (!missing) useUi.getState().notify(message(err));
      return;
    }
  }
}

/**
 * Adds a repo the vault doesn't know yet (`repos.yml`), from its checkout on
 * this Mac. Resolves its id once added.
 */
export async function addRepo(): Promise<string | null> {
  const values = await formDialog({
    title: "Add a repo",
    message:
      "Choose its checkout on this Mac. It's added to the vault's repos (.groundwork/repos.yml), where setup and components can be added later.",
    fields: [
      { label: "Checkout", value: "~/", type: "folder" },
      { label: "Name", placeholder: "its folder’s name" },
    ],
    confirmLabel: "Add repo",
  });
  const [checkout, name] = values ?? [];
  if (!checkout?.trim() || checkout.trim() === "~/") return null;
  try {
    const repo = await api.addRepo(checkout.trim(), name?.trim() || undefined);
    await useTickets.getState().load();
    useUi.getState().notify(`Added ${repo.name}`);
    return repo.id;
  } catch (err) {
    useUi.getState().notify(message(err));
    return null;
  }
}

/**
 * Takes a repo off a ticket, after asking: its worktree goes and the
 * terminals working in it end; the branch stays, so adding the repo again
 * brings its commits back. Uncommitted changes need a second, explicit yes.
 */
export async function removeTicketRepo(path: string, repo: string): Promise<void> {
  const ticket = ticketAt(path);
  const name = repoName(repo);
  const worktree = ticket?.repos.find((r) => r.id === repo)?.worktreePath;
  const active = ticket?.status !== "closed";
  const ok = await confirmDialog({
    title: `Remove ${name} from “${ticket?.title ?? path}”?`,
    message:
      active && worktree
        ? `Its worktree is removed and terminals working in it end. The branch ${ticket?.branch ?? ""} stays, so adding ${name} again brings its commits back.`
        : `${name} is taken off the ticket.`,
    confirmLabel: "Remove repo",
  });
  if (!ok) return;
  let force = false;
  for (;;) {
    try {
      const removed = await api.removeTicketRepo(path, repo, force);
      await Promise.all([useTickets.getState().load(), useWorkspaces.getState().refresh()]);
      useUi.getState().notify(`Removed ${name} from “${removed.ticket.title}”`);
      return;
    } catch (err) {
      const text = message(err);
      if (!force && /not removed: it has uncommitted changes/.test(text)) {
        force = await confirmDialog({
          title: `${name} has uncommitted changes`,
          message: "They're lost if its worktree is removed. Remove it anyway?",
          confirmLabel: "Remove anyway",
          danger: true,
        });
        if (force) continue;
        return;
      }
      useUi.getState().notify(text);
      return;
    }
  }
}

/**
 * Moves ticket notes kept in project folders into the vault's tickets
 * folder, after asking. Links to them are rewritten, and each keeps the
 * projects its old folder gave it.
 */
export async function gatherTickets(): Promise<void> {
  const ok = await confirmDialog({
    title: "Move tickets into the tickets folder?",
    message:
      "Ticket notes in other folders (such as a project’s Work folder) move into the vault’s tickets folder, with their subnotes. Links to them are updated, and a ticket that belonged to a project only by its folder gets that project in its properties. Folders left empty go to the Trash.",
    confirmLabel: "Move tickets",
  });
  if (!ok) return;
  try {
    const moved = await api.gatherTickets();
    await useTickets.getState().load();
    useUi
      .getState()
      .notify(
        moved.length === 0
          ? "Every ticket is already in the tickets folder"
          : moved.length === 1
            ? `Moved “${moved[0]!.from}” to ${moved[0]!.to}`
            : `Moved ${moved.length} tickets into the tickets folder`,
      );
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

/** Makes one of a ticket's repos its default, where its workspace's terminals start. */
export async function setDefaultTicketRepo(path: string, repo: string): Promise<void> {
  try {
    await api.setDefaultTicketRepo(path, repo);
    await Promise.all([useTickets.getState().load(), useWorkspaces.getState().refresh()]);
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

/** Somewhere a new terminal in a workspace can start. */
export interface TerminalPlace {
  label: string;
  detail?: string;
  cwd: string;
  /** The ticket's default repo. */
  isDefault?: boolean;
  /** One of the ticket's worktrees (not a component in one). */
  worktree?: boolean;
}

const shellQuote = (s: string) =>
  /^[\w/.+=:,@%-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;

/**
 * `--add-dir` options for Claude Code started in `cwd`: the other worktrees
 * of the ticket it's in (found by `cwd`, else by `workspace`'s note), so it
 * can read the other repos' code. Empty outside a ticket in several repos.
 */
export function addDirsFor(cwd: string | undefined, workspace?: string | null): string {
  const tickets = useTickets.getState().tickets;
  const inside = (wt: string) => !!cwd && (cwd === wt || cwd.startsWith(`${wt}/`));
  let ticket = tickets.find((t) => t.repos.some((r) => r.worktreePath && inside(r.worktreePath)));
  if (!ticket && workspace) {
    const note = useWorkspaces.getState().list.find((w) => w.id === workspace)?.note;
    ticket = note ? ticketAt(note) : undefined;
  }
  if (!ticket?.worktree || ticket.status === "closed") return "";
  return ticket.repos
    .map((r) => r.worktreePath)
    .filter((wt): wt is string => !!wt && !inside(wt))
    .map((wt) => ` --add-dir ${shellQuote(wt)}`)
    .join("");
}

/**
 * Where a workspace's new terminals can start besides its folder: for a
 * ticket's, each of its worktrees (the default first), then each component
 * it touches. Also the ticket, for menus that add or change its repos.
 */
export async function terminalPlaces(
  area: string,
): Promise<{ ticket?: Ticket; places: TerminalPlace[] }> {
  const note = useWorkspaces.getState().list.find((w) => w.id === area)?.note;
  if (!note) return { places: [] };
  const [context] = await Promise.all([
    api.context({ note }).catch(() => null),
    useTickets.getState().tickets.length ? null : useTickets.getState().load(),
  ]);
  const ticket = context?.ticket ?? ticketAt(note);
  const places: TerminalPlace[] = [];
  const repos = ticket?.worktree ? ticket.repos : [];
  repos.forEach((r, i) => {
    if (r.worktreePath)
      places.push({
        label: repoName(r.id),
        detail: r.worktreePath,
        cwd: r.worktreePath,
        isDefault: i === 0 && repos.length > 1,
        worktree: true,
      });
  });
  for (const c of context?.components ?? []) {
    if (!c.absPath) continue;
    const name = c.id.slice(c.id.indexOf(":") + 1);
    places.push({
      label: repos.length > 1 ? `${name} (${repoName(c.id.slice(0, c.id.indexOf(":")))})` : name,
      detail: c.path,
      cwd: c.absPath,
    });
  }
  return { ticket: ticket ?? undefined, places };
}

/**
 * A workspace's new-terminal menu: its folder, then its ticket's worktrees
 * (the default starred) and components, then the vault root unless that's
 * already its folder, then the ticket's repo choices.
 * `open` starts the terminal (in the workspace's folder without a `cwd`).
 */
export async function newTerminalItems(
  area: string,
  open: (cwd?: string) => void,
): Promise<MenuEntry[]> {
  const { ticket, places } = await terminalPlaces(area);
  const items: MenuEntry[] = [{ label: "New terminal", action: () => open() }];
  for (const p of places)
    items.push({
      label: `New terminal in ${p.label}`,
      starred: p.isDefault,
      action: () => open(p.cwd),
    });
  // For working on the vault itself, without adding it as a repo.
  const root = useVault.getState().vault?.path;
  const folder = useWorkspaces.getState().list.find((w) => w.id === area)?.cwd;
  const bare = (path: string) => path.replace(/\/+$/, "");
  if (root && (!folder || bare(folder) !== bare(root)))
    items.push({ label: "New terminal in vault root", action: () => open(root) });
  // Claude in a worktree, able to read the ticket's other repos too.
  const worktrees = places.filter((p) => p.worktree);
  if (worktrees.length > 1) {
    items.push("separator");
    for (const p of worktrees)
      items.push({
        label: `New Claude in ${p.label}`,
        starred: p.isDefault,
        action: () => void claudeIn(area, p.cwd),
      });
  }
  const repos = ticket ? repoMenuItems(ticket) : [];
  if (repos.length) items.push("separator", ...repos);
  return items;
}

/** Starts Claude Code in a new tab of a workspace, seeing the ticket's other worktrees. */
async function claudeIn(area: string, cwd: string) {
  const ws = useWorkspace.getState();
  if (ws.docks[area]) ws.showWorkspace(area, ws.view === "note" ? "split" : ws.view);
  await ws.openTerminal(cwd, { run: `claude${addDirsFor(cwd, area)}` });
}

/** A menu's items for a ticket's repos: make one the default, or add another. */
export function repoMenuItems(ticket: Ticket) {
  const items: { label: string; action: () => void }[] = [];
  const repos = ticket.worktree ? ticket.repos : [];
  if (repos.length > 1)
    for (const r of repos.slice(1))
      items.push({
        label: `Make ${repoName(r.id)} the default`,
        action: () => void setDefaultTicketRepo(ticket.path, r.id),
      });
  if (ticket.status !== "closed")
    items.push({ label: "Add repo…", action: () => void addTicketRepo(ticket.path) });
  for (const r of repos)
    items.push({
      label: `Remove ${repoName(r.id)}…`,
      action: () => void removeTicketRepo(ticket.path, r.id),
    });
  return items;
}

/** The note's workspace, made (and linked from the note) if it has none. */
export async function noteWorkspace(path: string): Promise<string | null> {
  try {
    const workspace = await api.noteWorkspace(path);
    await useWorkspaces.getState().refresh();
    await useWorkspaces.getState().ready(workspace.id);
    return workspace.id;
  } catch (err) {
    useUi.getState().notify(message(err));
    return null;
  }
}

/**
 * Runs an action: `shell` in the background, `terminal` in a new tab (in
 * the note's workspace when it has one), `url` in the browser.
 */
export async function runAction(action: Action, note?: string): Promise<void> {
  try {
    switch (action.kind) {
      case "url":
        await openExternalUrl(action.run);
        return;
      case "agent": {
        const workspace = note ? ticketAt(note)?.workspace : undefined;
        await launchAgent(
          { prompt: action.run },
          {
            cwd: action.cwd,
            workspace: workspace ?? undefined,
            inputs: action.inputs,
            title: action.label,
          },
        );
        return;
      }
      case "terminal": {
        const workspace = note ? ticketAt(note)?.workspace : undefined;
        const ws = useWorkspace.getState();
        if (workspace && ws.docks[workspace]) ws.showWorkspace(workspace);
        await ws.openTerminal(action.cwd, { run: action.run });
        return;
      }
      default:
        await api.runAction(action.id, note ? { note } : { cwd: action.cwd });
        useUi.getState().notify(`${action.label}: started`);
    }
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

/** The actions for a note, in a palette. */
export async function pickAction(note: string) {
  try {
    const context = await api.context({ note });
    if (!context.actions.length) {
      useUi.getState().notify("No actions for this note.");
      return;
    }
    useUi.getState().openPalette({
      placeholder: "Run an action…",
      recentKey: "actions",
      items: context.actions.map((a) => ({
        id: a.id,
        label: a.label,
        detail:
          a.kind === "agent"
            ? "Claude"
            : a.kind === "url" || a.kind === "terminal"
              ? a.run
              : undefined,
        run: () => runAction(a, note),
      })),
    });
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

/** A project's vault folder, if `path` is one. */
/** Opens a project's view in the current tab, or a new one. */
export function openProjectView(id: string, opts: { newTab?: boolean } = {}) {
  useWorkspace.getState().open(projectViewPath(id), opts);
}

export function projectAt(folder: string): ProjectInfo | undefined {
  return useTickets.getState().projects.find((p) => p.folder === folder);
}

/** Makes a folder (new or existing) a project, then opens its overview. */
export async function createProject(folder: string): Promise<boolean> {
  try {
    const project = await api.createProject(folder);
    await useTickets.getState().load();
    useVault.getState().revealInTree(project.folder);
    useVault.getState().toggleFolder(project.folder, true);
    if (project.overview) useWorkspace.getState().open(project.overview);
    useUi.getState().notify(`“${project.name}” is a project`);
    return true;
  } catch (err) {
    useUi.getState().notify(message(err));
    return false;
  }
}

/** The vault folder, absolute. */
export function vaultPath(): string {
  return useVault.getState().vault?.path ?? "";
}
