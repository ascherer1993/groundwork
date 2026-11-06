/**
 * Claude Code in terminal tabs: the session each tab last ran (from the
 * hooks; kept in the tab's params too, so it outlives a restart), and the
 * tab menu (Rename, Fork session, Resume conversation). Also agents: a Claude
 * Code session started with a prompt, in a tab you can watch.
 */
import { api } from "../api/client";
import { useTerminals } from "./terminals";
import { formDialog, type MenuEntry, promptDialog, useUi } from "./ui";
import { message, useVault } from "./vault";
import { type TerminalParams, useWorkspace } from "./workspace";

/** Session ids are typed into a shell. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

function tabOf(terminal: string) {
  return useWorkspace
    .getState()
    .terminalTabs()
    .find((t) => t.terminal === terminal);
}

function paramsOf(terminal: string): TerminalParams | undefined {
  return tabOf(terminal)?.panel.params as unknown as TerminalParams | undefined;
}

/** The Claude Code session last seen in a terminal's tab. */
export function sessionOf(terminal: string): string | undefined {
  const session = useTerminals.getState().byId[terminal]?.session ?? paramsOf(terminal)?.session;
  return session && SESSION_ID.test(session) ? session : undefined;
}

/** Keeps a terminal's session in its tab, to resume after a restart. */
export function rememberSession(terminal: string, session: string) {
  const tab = tabOf(terminal);
  if (!tab || paramsOf(terminal)?.session === session) return;
  tab.panel.api.updateParameters({ session });
}

function claudeRunning(terminal: string): boolean {
  return useTerminals.getState().byId[terminal]?.process === "claude";
}

/** A new tab beside it, in its folder, carrying on the conversation separately. */
export async function forkSession(terminal: string) {
  const session = sessionOf(terminal);
  if (!session) return;
  const cwd = useTerminals.getState().byId[terminal]?.cwd ?? paramsOf(terminal)?.cwd;
  await useWorkspace.getState().openTerminal(cwd, {
    beside: terminal,
    run: `claude --resume ${session} --fork-session`,
  });
}

/** Picks up the tab's last conversation in its shell. */
export async function resumeConversation(terminal: string) {
  const session = sessionOf(terminal);
  if (!session) return;
  useWorkspace.getState().showTerminal(terminal);
  try {
    await api.terminalInput(terminal, `claude --resume ${session}\r`);
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

/** Names a terminal's tab; an empty name goes back to the program's title. */
export async function renameTab(terminal: string) {
  const tab = tabOf(terminal);
  if (!tab) return;
  const name = await promptDialog({
    title: "Rename tab",
    message: "Leave it empty to show what's running in it.",
    value: paramsOf(terminal)?.name ?? tab.panel.title ?? "",
    confirmLabel: "Rename",
  });
  if (name === null || name === undefined) return;
  tab.panel.api.updateParameters({ name: name.trim() || undefined });
}

/** The menu of a terminal's tab. */
export function terminalMenu(terminal: string): MenuEntry[] {
  const session = sessionOf(terminal);
  const items: MenuEntry[] = [
    { label: "Rename tab…", action: () => void renameTab(terminal) },
    "separator",
  ];
  if (session) {
    items.push({ label: "Fork session", action: () => void forkSession(terminal) });
    if (!claudeRunning(terminal)) {
      items.push({ label: "Resume conversation", action: () => void resumeConversation(terminal) });
    }
    items.push("separator");
  }
  items.push({ label: "Close tab", action: () => tabOf(terminal)?.panel.api.close() });
  return items;
}

/** Shows a terminal tab's menu where it was right-clicked. */
export function showTerminalMenu(e: React.MouseEvent, terminal: string) {
  e.preventDefault();
  useUi.getState().showMenu(e.clientX, e.clientY, terminalMenu(terminal));
}

interface AgentOptions {
  /** Where it starts: the vault by default. */
  cwd?: string;
  /** The workspace whose terminals it joins: the current one by default. */
  workspace?: string;
  /** Asked first; the answers fill `{{input.<name>}}`. */
  inputs?: { name: string; label: string }[];
  /** The dialog's title, when there are inputs. */
  title?: string;
}

/**
 * Starts Claude Code in a new terminal tab with a prompt: an agent action's
 * own, or a named one (`new-ticket`, `triage`). Returns whether it started.
 */
export async function launchAgent(
  which: { prompt: string } | { name: string },
  opts: AgentOptions = {},
): Promise<boolean> {
  const vars: Record<string, string> = {};
  if (opts.inputs?.length) {
    const values = await formDialog({
      title: opts.title ?? "Start Claude",
      fields: opts.inputs.map((i) => ({ label: i.label })),
      confirmLabel: "Start",
    });
    if (!values) return false;
    opts.inputs.forEach((input, i) => (vars[`input.${input.name}`] = values[i]?.trim() ?? ""));
  }
  try {
    const command = await api.agentCommand(which, vars);
    const ws = useWorkspace.getState();
    if (opts.workspace && ws.docks[opts.workspace]) ws.showWorkspace(opts.workspace);
    else if (ws.view === "note") ws.setView("split");
    await ws.openTerminal(opts.cwd ?? useVault.getState().vault?.path, { run: command });
    return true;
  } catch (err) {
    useUi.getState().notify(message(err));
    return false;
  }
}

/** "New ticket from Jira": Claude reads the issue and sets the ticket up. */
export function newTicketFromJira() {
  return launchAgent(
    { name: "new-ticket" },
    {
      title: "New ticket from Jira",
      inputs: [{ name: "ticket", label: "Jira key or link" }],
    },
  );
}

/** Claude goes through overdue and stale todos, asking about each in the inbox. */
export function triageTodos() {
  return launchAgent({ name: "triage" });
}
