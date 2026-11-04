/**
 * Workspaces: named sets of terminal tabs and splits with a folder, each
 * with its own layout (`workspace.ts` holds the docks). One is current: its
 * terminals are the ones on screen beside or instead of the notes. Kept per
 * vault in the data folder, since they're machine-local.
 */
import { create } from "zustand";
import { api } from "../api/client";
import type { Workspace } from "../api/generated/Workspace";
import { confirmDialog, formDialog, promptDialog, useUi } from "./ui";
import { message, useVault } from "./vault";
import {
  isTerminal,
  savedView,
  setWorkspaceHooks,
  type TerminalParams,
  useWorkspace,
} from "./workspace";

interface WorkspacesState {
  list: Workspace[];
  loaded: boolean;
  load(): Promise<void>;
  /** Reloads the list (after the backend made or removed one), keeping the current one. */
  refresh(): Promise<void>;
  /**
   * Makes a workspace current, as chosen from the list or ⌘1…, with its note
   * (if it has one) open beside its terminals.
   */
  pick(id: string): void;
  /** Resolves once a workspace's dock is mounted, so it can take tabs. */
  ready(id: string): Promise<boolean>;
  /** Asks for a name, creates the workspace, shows it and opens a terminal. */
  create(): Promise<void>;
  rename(id: string): Promise<void>;
  /** Where its new terminals start; open ones stay where they are. */
  changeFolder(id: string): Promise<void>;
  /** After confirming, ends its terminals and forgets it. */
  remove(id: string): Promise<void>;
}

export const useWorkspaces = create<WorkspacesState>((set, get) => ({
  list: [],
  loaded: false,

  async load() {
    set({ list: [], loaded: false });
    useWorkspace.setState({ workspace: null, view: "note" });
    try {
      const list = await api.workspaces();
      const saved = savedView();
      const current = list.find((w) => w.id === saved.workspace) ?? list[0];
      // Restored before `loaded`, which the terminals following the notes wait for.
      set({ list });
      useWorkspace.setState({ pinned: saved.pinned });
      useWorkspace.getState().showWorkspace(current?.id ?? null, current ? saved.view : "note");
      set({ loaded: true });
    } catch (err) {
      set({ loaded: true });
      useUi.getState().notify(message(err));
    }
  },

  async refresh() {
    try {
      const list = await api.workspaces();
      set({ list });
      leaveIfGone(list);
    } catch (err) {
      useUi.getState().notify(message(err));
    }
  },

  pick(id) {
    const ws = useWorkspace.getState();
    ws.showWorkspace(id);
    const note = get().list.find((w) => w.id === id)?.note;
    if (!note || ws.activePath === note) return;
    const tab = ws.fileTab(note);
    if (tab) tab.api.setActive();
    else ws.open(note, { background: true });
  },

  async ready(id) {
    for (let i = 0; i < 50; i++) {
      if (useWorkspace.getState().docks[id]) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  },

  async create() {
    const values = await formDialog({
      title: "New workspace",
      message: "Its terminals start in this folder.",
      fields: [
        { label: "Name", placeholder: "Name" },
        { label: "Folder", value: useVault.getState().vault?.path ?? "" },
      ],
      confirmLabel: "Create",
    });
    const [name, cwd] = values ?? [];
    if (!name?.trim()) return;
    try {
      const workspace = await api.createWorkspace(name.trim(), cwd?.trim() || undefined);
      set((s) => ({ list: [...s.list, workspace] }));
      // Its dock mounts on the next render; then it can take a terminal.
      await get().ready(workspace.id);
      useWorkspace.getState().showWorkspace(workspace.id);
      await useWorkspace.getState().openTerminal();
    } catch (err) {
      useUi.getState().notify(message(err));
    }
  },

  async rename(id) {
    const workspace = get().list.find((w) => w.id === id);
    const name = await promptDialog({
      title: "Rename workspace",
      value: workspace?.name ?? "",
      confirmLabel: "Rename",
    });
    if (!name?.trim() || name.trim() === workspace?.name) return;
    try {
      const updated = await api.updateWorkspace(id, { name: name.trim() });
      set((s) => ({ list: s.list.map((w) => (w.id === id ? updated : w)) }));
    } catch (err) {
      useUi.getState().notify(message(err));
    }
  },

  async changeFolder(id) {
    const workspace = get().list.find((w) => w.id === id);
    const cwd = await formDialog({
      title: "Change folder",
      message: "New terminals start in this folder. Open ones stay where they are.",
      fields: [{ label: "Folder", value: workspace?.cwd ?? "" }],
      confirmLabel: "Change",
    }).then((values) => values?.[0]?.trim());
    if (!cwd || cwd === workspace?.cwd) return;
    try {
      const updated = await api.updateWorkspace(id, { cwd });
      set((s) => ({ list: s.list.map((w) => (w.id === id ? updated : w)) }));
    } catch (err) {
      useUi.getState().notify(message(err));
    }
  },

  async remove(id) {
    const workspace = get().list.find((w) => w.id === id);
    const dock = useWorkspace.getState().docks[id];
    const terminals = (dock?.panels ?? [])
      .filter(isTerminal)
      .map((p) => (p.params as unknown as TerminalParams).terminal);
    const ok = await confirmDialog({
      title: `Delete “${workspace?.name ?? "workspace"}”?`,
      message: terminals.length
        ? `Its ${terminals.length === 1 ? "terminal" : `${terminals.length} terminals`} will end.`
        : undefined,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteWorkspace(id);
      set((s) => ({ list: s.list.filter((w) => w.id !== id) }));
      leaveIfGone(get().list);
      await Promise.all(terminals.map((t) => api.killTerminal(t).catch(() => {})));
    } catch (err) {
      useUi.getState().notify(message(err));
    }
  },
}));

/** If the current workspace is gone, another takes its place (or only notes show). */
function leaveIfGone(list: Workspace[]) {
  const ws = useWorkspace.getState();
  if (!ws.workspace || list.some((w) => w.id === ws.workspace)) return;
  const next = list[0]?.id ?? null;
  ws.showWorkspace(next, next ? undefined : "note");
}

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

setWorkspaceHooks({
  folder: (id) => useWorkspaces.getState().list.find((w) => w.id === id)?.cwd,
  // A terminal with no workspace to go in gets one named after its folder.
  async make(cwd) {
    const folder = cwd ?? useVault.getState().vault?.path;
    try {
      const workspace = await api.createWorkspace(folder ? baseName(folder) : "Terminals", folder);
      useWorkspaces.setState((s) => ({ list: [...s.list, workspace] }));
      if (!(await useWorkspaces.getState().ready(workspace.id))) return null;
      useWorkspace.getState().showWorkspace(workspace.id);
      return workspace.id;
    } catch (err) {
      useUi.getState().notify(message(err));
      return null;
    }
  },
});
