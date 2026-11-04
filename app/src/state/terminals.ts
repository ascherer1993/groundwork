/**
 * What each terminal is doing, for the badges in the Workspaces view:
 * - waiting: it rang the bell or sent a notification you haven't seen, or
 *   Claude Code is waiting on you
 * - finished: a command (or Claude's turn) ended while you were looking
 *   elsewhere
 * - running: a program besides the shell is in the foreground; Claude Code
 *   while its hooks say it's working (without the plugin: while it draws)
 * - idle: anything else
 *
 * Fed by the events of every attached terminal, on screen or not, and by
 * Claude Code's hooks (`agent.changed`).
 */
import { create } from "zustand";
import { api, transport } from "../api/client";
import type { AgentState } from "../api/generated/AgentState";
import type { TerminalInfo } from "../api/generated/TerminalInfo";
import { isTauri } from "../api/transport";
import { seenTerminal } from "./inbox";
import { useUi } from "./ui";
import { isTerminal, type TerminalParams, useWorkspace } from "./workspace";

export type TerminalState = "waiting" | "finished" | "running" | "idle";

export interface TerminalStatus {
  /** The program the terminal started (its shell). */
  program?: string;
  /** What's in the foreground now. */
  process?: string | null;
  /** The shell's current folder. */
  cwd?: string;
  /** When it last wrote output (ms), roughly. */
  lastOutput: number;
  /** What it asked for attention with, until seen. */
  attention?: string;
  finished: boolean;
  /** What Claude Code's hooks last said. */
  agent?: AgentState;
}

/** Claude Code output this recent counts as running. */
const RUNNING_FOR = 3000;

interface TerminalsState {
  byId: Record<string, TerminalStatus>;
  /** Terminals on screen (their tab is showing, in the area on screen). */
  visible: Record<string, boolean>;
  setVisible(id: string, visible: boolean): void;
  /** Records what a newly created or listed terminal is. */
  known(info: TerminalInfo): void;
}

const blank = (): TerminalStatus => ({ lastOutput: 0, finished: false });

export const useTerminals = create<TerminalsState>((set, get) => ({
  byId: {},
  visible: {},

  setVisible(id, visible) {
    set((s) => ({ visible: { ...s.visible, [id]: visible } }));
    if (visible && document.hasFocus()) seen(id);
  },

  known(info) {
    const current = get().byId[info.id] ?? blank();
    patch(info.id, {
      program: info.program,
      process: current.process ?? info.process,
      cwd: current.cwd ?? info.cwd,
    });
  },
}));

export function stateOf(status: TerminalStatus | undefined, now = Date.now()): TerminalState {
  if (!status) return "idle";
  if (status.attention !== undefined) return "waiting";
  if (status.finished) return "finished";
  const busy = !!status.process && status.process !== status.program;
  if (!busy) return "idle";
  if (status.agent) return status.agent === "working" ? "running" : "idle";
  if (status.process === "claude")
    return now - status.lastOutput < RUNNING_FOR ? "running" : "idle";
  return "running";
}

const ORDER: TerminalState[] = ["waiting", "finished", "running", "idle"];

/** The state that matters most among several terminals'. */
export function mostUrgent(states: TerminalState[]): TerminalState {
  return ORDER.find((s) => states.includes(s)) ?? "idle";
}

function patch(id: string, change: Partial<TerminalStatus>) {
  useTerminals.setState((s) => ({
    byId: { ...s.byId, [id]: { ...(s.byId[id] ?? blank()), ...change } },
  }));
}

function isSeen(id: string): boolean {
  return !!useTerminals.getState().visible[id] && document.hasFocus();
}

function seen(id: string) {
  const status = useTerminals.getState().byId[id];
  if (status && (status.attention !== undefined || status.finished)) {
    patch(id, { attention: undefined, finished: false });
  }
  seenTerminal(id);
}

/** The tab showing a terminal, for messages: its title. */
function tabTitle(id: string): string | undefined {
  for (const dock of Object.values(useWorkspace.getState().docks)) {
    const panel = dock.panels.find(
      (p) => isTerminal(p) && (p.params as unknown as TerminalParams).terminal === id,
    );
    if (panel) return panel.title ?? undefined;
  }
}

async function requestAttention() {
  if (!isTauri()) return;
  const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
  await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
}

/** Terminals whose program was looked up, so it's asked once each. */
const asked = new Set<string>();

/** Starts following terminal events; once, when a vault opens. */
export function watchTerminals() {
  if (watching) return;
  watching = true;
  void api
    .agents()
    .then((agents) => agents.forEach((a) => patch(a.tab, { agent: a.state })))
    .catch(() => {});
  transport.listen((event) => {
    switch (event.event) {
      case "agent.changed": {
        const { tab: id, state, message } = event.payload.agent;
        const looking = isSeen(id);
        if (state === "waiting") {
          patch(id, { agent: state, attention: looking ? undefined : (message ?? "") });
          if (looking) seenTerminal(id);
        } else if (state === "finished") {
          patch(id, { agent: state, attention: undefined, finished: !looking });
        } else {
          patch(id, { agent: state, attention: undefined, finished: false });
        }
        return;
      }
      case "terminal.output": {
        const { id } = event.payload;
        const now = Date.now();
        // Only often enough to keep "running" accurate.
        if (now - (useTerminals.getState().byId[id]?.lastOutput ?? 0) > 1000) {
          patch(id, { lastOutput: now });
        }
        return;
      }
      case "terminal.process": {
        const { id, process, cwd } = event.payload;
        const before = useTerminals.getState().byId[id];
        const program = before?.program;
        if (!program && !asked.has(id)) {
          asked.add(id);
          void api
            .terminals()
            .then((all) => all.forEach(useTerminals.getState().known))
            .catch(() => {});
        }
        const ended =
          !!program && !!before?.process && before.process !== program && process === program;
        patch(id, {
          process,
          cwd: cwd ?? before?.cwd,
          finished: before?.finished || (ended && !isSeen(id)),
        });
        return;
      }
      case "terminal.bell": {
        const { id } = event.payload;
        if (!isSeen(id))
          patch(id, { attention: useTerminals.getState().byId[id]?.attention ?? "" });
        return;
      }
      case "terminal.notify": {
        const { id, title, body } = event.payload;
        if (isSeen(id)) return;
        patch(id, { attention: body });
        const from = title ?? tabTitle(id) ?? "Terminal";
        useUi.getState().notify(`${from}: ${body}`, {
          label: "Show",
          run: () => useWorkspace.getState().showTerminal(id),
        });
        if (!document.hasFocus()) void requestAttention().catch(() => {});
        return;
      }
      case "terminal.exit": {
        const { id } = event.payload;
        useTerminals.setState((s) => {
          const byId = { ...s.byId };
          const visible = { ...s.visible };
          delete byId[id];
          delete visible[id];
          return { byId, visible };
        });
        return;
      }
    }
  });
  // Coming back to the window counts as seeing what's on screen.
  window.addEventListener("focus", () => {
    for (const [id, visible] of Object.entries(useTerminals.getState().visible)) {
      if (visible) seen(id);
    }
  });
}

let watching = false;
