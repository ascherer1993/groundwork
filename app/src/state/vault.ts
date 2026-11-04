import { create } from "zustand";
import { api, transport } from "../api/client";
import type { FileChange } from "../api/generated/FileChange";
import type { FileSummary } from "../api/generated/FileSummary";
import type { LinkSettings } from "../api/generated/LinkSettings";
import type { RecentVault } from "../api/generated/RecentVault";
import type { TreeNode } from "../api/generated/TreeNode";
import type { VaultInfo } from "../api/generated/VaultInfo";

type Status = "loading" | "welcome" | "vault";

export type ChangeListener = (changes: FileChange[]) => void;

interface VaultState {
  status: Status;
  error: string | null;
  recent: RecentVault[];
  vault: VaultInfo | null;
  tree: TreeNode | null;
  /** Every linkable file, for the quick switcher and `[[` autocomplete. */
  files: FileSummary[];
  settings: LinkSettings;
  /** Bumped on every change, so derived views (backlinks…) know to refresh. */
  revision: number;
  /** Folder paths expanded in the file tree. */
  expanded: Set<string>;

  init(): Promise<void>;
  openVault(path: string): Promise<void>;
  closeVault(): Promise<void>;
  forgetVault(path: string): Promise<void>;
  refresh(): Promise<void>;
  toggleFolder(path: string, open?: boolean): void;
  revealInTree(path: string): void;
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const changeListeners = new Set<ChangeListener>();

/** Subscribes to file changes (from Groundwork or outside it). */
export function onVaultChange(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export const useVault = create<VaultState>((set, get) => ({
  status: "loading",
  error: null,
  recent: [],
  vault: null,
  tree: null,
  files: [],
  settings: {
    format: "shortest",
    markdownLinks: false,
    newFileLocation: "root",
    newFileFolder: "",
  },
  revision: 0,
  expanded: new Set(),

  async init() {
    try {
      const current = await api.currentVault();
      if (current) {
        set({ vault: current, status: "vault", error: null });
        await get().refresh();
        return;
      }
      // Like Obsidian, reopen the last vault on launch.
      const recent = await api.recentVaults();
      const last = recent[0];
      if (last?.exists) {
        await get().openVault(last.path);
        if (get().status === "vault") return;
      }
      set({ recent: await api.recentVaults(), status: "welcome" });
    } catch (err) {
      set({ status: "welcome", error: message(err) });
    }
  },

  async openVault(path) {
    try {
      const vault = await api.openVault(path);
      set({ vault, status: "vault", error: null, expanded: new Set() });
      await get().refresh();
    } catch (err) {
      set({ error: message(err), recent: await api.recentVaults().catch(() => get().recent) });
    }
  },

  async closeVault() {
    await api.closeVault();
    set({
      vault: null,
      tree: null,
      files: [],
      status: "welcome",
      recent: await api.recentVaults(),
    });
  },

  async forgetVault(path) {
    await api.forgetVault(path);
    set({ recent: await api.recentVaults() });
  },

  async refresh() {
    try {
      const [tree, files, settings] = await Promise.all([
        api.tree(),
        api.files(),
        api.linkSettings(),
      ]);
      set((s) => ({ tree, files, settings, revision: s.revision + 1 }));
    } catch (err) {
      set({ error: message(err) });
    }
  },

  toggleFolder(path, open) {
    const expanded = new Set(get().expanded);
    const shouldOpen = open ?? !expanded.has(path);
    if (shouldOpen) expanded.add(path);
    else expanded.delete(path);
    set({ expanded });
  },

  revealInTree(path) {
    const parts = path.split("/");
    const expanded = new Set(get().expanded);
    for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join("/"));
    set({ expanded });
  },
}));

/** Where new notes go, per the vault's "Default location for new notes". */
export function newNoteFolder(activePath: string | null): string {
  const { newFileLocation, newFileFolder } = useVault.getState().settings;
  if (newFileLocation === "folder") return newFileFolder;
  if (newFileLocation === "current" && activePath) {
    return activePath.slice(0, Math.max(0, activePath.lastIndexOf("/")));
  }
  return "";
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void useVault.getState().refresh(), 120);
}

transport.listen((event) => {
  if (event.event !== "vault.changed" || useVault.getState().status !== "vault") return;
  const { changes } = event.payload;
  for (const l of changeListeners) l(changes);
  const structural = changes.some((c) => c.kind !== "modified");
  if (structural) scheduleRefresh();
  else {
    useVault.setState((s) => ({ revision: s.revision + 1 }));
    // Aliases may have changed; refresh the file list quietly.
    void api.files().then((files) => useVault.setState({ files }));
  }
});

transport.onReconnect(() => {
  if (useVault.getState().status === "vault") void useVault.getState().init();
});
