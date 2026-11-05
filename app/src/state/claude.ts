/**
 * Claude Code in terminal tabs: the session each tab last ran (from the
 * hooks; kept in the tab's params too, so it outlives a restart), and the
 * tab menu's Fork session and Resume conversation.
 */
import { api } from "../api/client";
import { useTerminals } from "./terminals";
import type { MenuEntry } from "./ui";
import { useUi } from "./ui";
import { message } from "./vault";
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

/** The menu of a terminal's tab. */
export function terminalMenu(terminal: string): MenuEntry[] {
  const session = sessionOf(terminal);
  const items: MenuEntry[] = [];
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
