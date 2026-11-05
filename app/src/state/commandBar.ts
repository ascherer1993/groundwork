/**
 * The command bar (PLAN §5.10): ask Claude from anywhere. In the desktop app
 * a global shortcut opens it in a floating window of its own
 * (`command-bar.html`, `commandBar.tsx`); in the browser, and from the
 * palette, it opens over the app. Enter starts a fresh Claude session in the
 * "Agents" workspace, in the vault, with what you had open (the chips you
 * kept) added to its system prompt. Its questions reach the inbox.
 */
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { create } from "zustand";
import { api } from "../api/client";
import type { AgentContext } from "../api/generated/AgentContext";
import { isTauri } from "../api/transport";
import { displayCombo, toAccelerator } from "../lib/keyCombo";
import {
  type BarChip,
  type BarOpening,
  type BarRequest,
  OPEN_EVENT,
  START_EVENT,
} from "../lib/commandBar";
import { isViewPath, projectOfView } from "../lib/paths";
import { bindingOf, useKeys } from "./keys";
import { useUi } from "./ui";
import { message, useVault } from "./vault";
import { useWorkspace } from "./workspace";
import { useWorkspaces } from "./workspaces";

/** The workspace command bar sessions run in. */
export const AGENTS = "Agents";

interface CommandBarState {
  /** Over the app (browser mode, or no window of its own). */
  open: boolean;
  chips: BarChip[];
  close(): void;
}

export const useCommandBar = create<CommandBarState>((set) => ({
  open: false,
  chips: [],
  close: () => set({ open: false }),
}));

/** The note, project and workspace on screen. */
export async function currentChips(): Promise<BarChip[]> {
  if (useVault.getState().status !== "vault") return [];
  const ws = useWorkspace.getState();
  const chips: BarChip[] = [];
  const path = ws.activePath;
  if (path && !isViewPath(path)) {
    const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    chips.push({ kind: "note", value: path, label: name });
  }
  try {
    const viewing = projectOfView(path);
    const project = viewing
      ? (await api.projects()).find((p) => p.id === viewing)
      : path && !isViewPath(path)
        ? (await api.context({ note: path })).projects[0]
        : undefined;
    if (project) chips.push({ kind: "project", value: project.id, label: project.name });
  } catch {
    // No project, then.
  }
  const workspace = useWorkspaces.getState().list.find((w) => w.id === ws.workspace);
  if (workspace && workspace.name !== AGENTS) {
    chips.push({ kind: "workspace", value: workspace.name, label: workspace.name });
  }
  return chips;
}

/** Opens the bar: its own window in the desktop app, else over the app. */
export async function openCommandBar() {
  if (isTauri() && (await showBarWindow())) return;
  useCommandBar.setState({ open: true, chips: await currentChips() });
}

/** The "Agents" workspace, made the first time. */
async function agentsWorkspace(): Promise<string> {
  const found = useWorkspaces.getState().list.find((w) => w.name === AGENTS);
  if (found) return found.id;
  const made = await api.createWorkspace(AGENTS, useVault.getState().vault?.path);
  useWorkspaces.setState((s) => ({ list: [...s.list, made] }));
  await useWorkspaces.getState().ready(made.id);
  return made.id;
}

/** Starts Claude for a request from the bar. */
export async function startFromBar(request: BarRequest): Promise<boolean> {
  const prompt = request.prompt.trim();
  if (!prompt) return false;
  if (useVault.getState().status !== "vault") {
    useUi.getState().notify("Open a vault first: Claude works in it.");
    return false;
  }
  const context: AgentContext = {};
  for (const chip of request.chips) context[chip.kind] = chip.value;
  try {
    const workspace = await agentsWorkspace();
    const command = await api.agentCommand({ prompt }, {}, context);
    const ws = useWorkspace.getState();
    if (request.show && ws.view === "note") ws.setView("split");
    await ws.newTerminal(useVault.getState().vault?.path, {
      run: command,
      workspace,
      background: !request.show,
    });
    if (request.show && isTauri()) {
      await getCurrentWindow().show();
      await getCurrentWindow().setFocus();
    }
    if (!request.show) {
      useUi.getState().notify(`Claude is on it, in the ${AGENTS} workspace.`);
    }
    return true;
  } catch (err) {
    useUi.getState().notify(message(err));
    return false;
  }
}

// ---- The desktop app: a global shortcut and a window of its own -------------

const BAR_WINDOW = "command-bar";
async function showBarWindow(): Promise<boolean> {
  const bar = await WebviewWindow.getByLabel(BAR_WINDOW);
  if (!bar) return false;
  const opening: BarOpening = {
    chips: await currentChips(),
    wasActive: await getCurrentWindow().isFocused(),
  };
  await emitTo(BAR_WINDOW, OPEN_EVENT, opening);
  await bar.center();
  await bar.show();
  await bar.setFocus();
  return true;
}

/**
 * In the desktop app, makes the bar's shortcut global (kept in step with
 * Settings) and starts what the bar's window asks for. Returns a cleanup.
 */
export function installCommandBar(): () => void {
  if (!isTauri()) return () => {};
  let registered: string | null = null;
  let syncing = Promise.resolve();
  const sync = () =>
    (syncing = syncing.then(async () => {
      const combo = bindingOf("command-bar", useKeys.getState().overrides);
      if (combo === registered) return;
      if (registered) await unregister(toAccelerator(registered)).catch(() => {});
      registered = null;
      if (!combo) return;
      try {
        await register(toAccelerator(combo), (e) => {
          if (e.state === "Pressed") void openCommandBar();
        });
        registered = combo;
      } catch (err) {
        useUi
          .getState()
          .notify(
            `${displayCombo(combo)} can’t open the command bar from anywhere: ${message(err)}`,
          );
      }
    }));
  void sync();
  const stopKeys = useKeys.subscribe(() => void sync());
  const stopListening = listen<BarRequest>(START_EVENT, (e) => void startFromBar(e.payload));
  return () => {
    stopKeys();
    void stopListening.then((stop) => stop());
    if (registered) void unregister(toAccelerator(registered)).catch(() => {});
  };
}
