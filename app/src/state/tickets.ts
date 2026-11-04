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
import { confirmDialog, formDialog, useUi } from "./ui";
import { message, onVaultChange, useVault } from "./vault";
import { isTerminal, NOTES, type TerminalParams, useWorkspace } from "./workspace";
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
      "Its main checkout on this Mac (any folder in it). Worktrees go in a folder beside it unless you choose one.",
    fields: [
      { label: "Checkout", value: repo?.location?.path ?? "~/" },
      {
        label: "Worktrees folder",
        value: repo?.location?.worktrees ?? "",
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

/** Note · Split · Workspace: which one is on screen for a note with a workspace. */
export type NoteMode = "note" | "split" | "workspace";

export function noteMode(path: string, workspace: string): NoteMode {
  const ws = useWorkspace.getState();
  if (ws.area !== workspace) return "note";
  return ws.fileTab(workspace, path) ? "split" : "workspace";
}

/** The note in the notes area. */
export function showNote(path: string) {
  useWorkspace.getState().setArea(NOTES);
  useWorkspace.getState().open(path);
}

/** The note's workspace, with a terminal if it has none. */
export async function showWorkspace(workspace: string) {
  const ws = useWorkspace.getState();
  ws.setArea(workspace);
  const dock = ws.docks[workspace];
  if (dock && !dock.panels.some(isTerminal)) await ws.openTerminal();
}

/** The note beside the workspace's terminals. `run` goes to a new terminal. */
export async function showSplit(path: string, workspace: string, run?: string) {
  const ws = useWorkspace.getState();
  ws.setArea(workspace);
  const dock = ws.docks[workspace];
  if (!dock) return;
  const tab = ws.fileTab(workspace, path);
  if (tab) tab.api.setActive();
  else if (dock.panels.length === 0) ws.open(path);
  else ws.open(path, { split: "left" });
  if (run || !dock.panels.some(isTerminal)) {
    await ws.openTerminal(undefined, { split: "right", run });
  }
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
  // Its tabs close as their terminals end; take them off screen first.
  const workspace = ticket?.workspace;
  if (workspace && useWorkspace.getState().area === workspace) {
    useWorkspace.getState().setArea(NOTES);
    useWorkspace.getState().open(path);
  }
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
      case "terminal": {
        const workspace = note ? ticketAt(note)?.workspace : undefined;
        const ws = useWorkspace.getState();
        if (workspace && ws.docks[workspace]) ws.setArea(workspace);
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
        detail: a.kind === "url" ? a.run : a.kind === "terminal" ? a.run : undefined,
        run: () => runAction(a, note),
      })),
    });
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

/** A project's vault folder, if `path` is one. */
export function projectAt(folder: string): ProjectInfo | undefined {
  return useTickets.getState().projects.find((p) => p.folder === folder);
}

/** The vault folder, absolute. */
export function vaultPath(): string {
  return useVault.getState().vault?.path ?? "";
}
