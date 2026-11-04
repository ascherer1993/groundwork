/**
 * Workspaces: named sets of terminal tabs and splits with a folder, each
 * with its own layout that the main area switches to (`workspace.ts` holds
 * the docks). Kept per vault in the data folder, since they're machine-local.
 */
import { create } from "zustand";
import { api } from "../api/client";
import type { Workspace } from "../api/generated/Workspace";
import { confirmDialog, formDialog, promptDialog, useUi } from "./ui";
import { message, useVault } from "./vault";
import {
  isTerminal,
  NOTES,
  savedArea,
  setAreaFolders,
  type TerminalParams,
  useWorkspace,
} from "./workspace";

interface WorkspacesState {
  list: Workspace[];
  loaded: boolean;
  load(): Promise<void>;
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
    useWorkspace.setState({ area: NOTES });
    try {
      const list = await api.workspaces();
      set({ list, loaded: true });
      const area = savedArea();
      useWorkspace.getState().setArea(list.some((w) => w.id === area) ? area : NOTES);
    } catch (err) {
      set({ loaded: true });
      useUi.getState().notify(message(err));
    }
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
      await new Promise((resolve) => setTimeout(resolve));
      useWorkspace.getState().setArea(workspace.id);
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
      if (useWorkspace.getState().area === id) useWorkspace.getState().setArea(NOTES);
      set((s) => ({ list: s.list.filter((w) => w.id !== id) }));
      await Promise.all(terminals.map((t) => api.killTerminal(t).catch(() => {})));
    } catch (err) {
      useUi.getState().notify(message(err));
    }
  },
}));

setAreaFolders((area) => useWorkspaces.getState().list.find((w) => w.id === area)?.cwd);
