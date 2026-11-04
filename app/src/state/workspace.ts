/**
 * Open files: tabs and splits (dockview), per-tab history, and link navigation.
 */
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { create } from "zustand";
import { api } from "../api/client";
import type { FileChange } from "../api/generated/FileChange";
import { displayName, isPagePath } from "../lib/paths";
import { splitTarget } from "../markdown/syntax";
import { message, newNoteFolder, onVaultChange, useVault } from "./vault";
import { useUi } from "./ui";

export type ViewMode = "live" | "source" | "reading";

/**
 * Where to scroll after opening: a heading/block subpath, a zero-based line,
 * or a character offset (which also focuses the editor).
 */
export interface FocusTarget {
  subpath?: string;
  line?: number;
  offset?: number;
  /** Changes on every request, so repeating the same target still scrolls. */
  nonce: number;
}

export interface PanelParams {
  path: string;
  mode: ViewMode;
  back: string[];
  forward: string[];
  focus?: FocusTarget;
  /** Focus the inline title (for freshly created notes). */
  editTitle?: boolean;
}

export interface OpenOptions {
  newTab?: boolean;
  split?: "right" | "below";
  subpath?: string;
  line?: number;
  /** Put the cursor here and focus the editor; past the end means the end. */
  offset?: number;
  editTitle?: boolean;
}

interface WorkspaceState {
  dock: DockviewApi | null;
  activePanelId: string | null;
  activePath: string | null;

  attach(dock: DockviewApi): void;
  open(path: string, opts?: OpenOptions): void;
  openLink(
    source: string,
    href: string,
    opts?: OpenOptions & { resolved?: string | null },
  ): Promise<void>;
  setMode(panelId: string, mode: ViewMode): void;
  toggleReading(): void;
  back(panelId?: string): void;
  forward(panelId?: string): void;
  closeActive(): void;
  newNote(folder?: string, opts?: OpenOptions): Promise<void>;
}

let panelCounter = 0;
let focusNonce = 0;

function titleOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = name.toLowerCase().endsWith(".md") ? "" : null;
  return ext === null ? name : displayName(name, "note").base;
}

function layoutKey(): string | null {
  const vault = useVault.getState().vault;
  return vault ? `groundwork.layout:${vault.path}` : null;
}

function update(panel: IDockviewPanel, params: PanelParams) {
  panel.api.updateParameters(params as unknown as Record<string, unknown>);
  panel.api.setTitle(titleOf(params.path));
  if (panel.api.isActive) {
    useWorkspace.setState({ activePath: params.path });
    useVault.getState().revealInTree(params.path);
  }
}

export function paramsOf(panel: IDockviewPanel): PanelParams {
  return panel.params as unknown as PanelParams;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  dock: null,
  activePanelId: null,
  activePath: null,

  attach(dock) {
    set({ dock });
    const key = layoutKey();
    if (key) {
      try {
        const saved = localStorage.getItem(key);
        if (saved) dock.fromJSON(JSON.parse(saved));
      } catch {
        dock.clear();
      }
    }
    for (const panel of dock.panels) {
      const n = Number(panel.id.replace(/^tab-/, ""));
      if (n > panelCounter) panelCounter = n;
    }
    const sync = () => {
      const panel = dock.activePanel;
      const path = panel ? paramsOf(panel).path : null;
      set({ activePanelId: panel?.id ?? null, activePath: path });
      if (path) useVault.getState().revealInTree(path);
    };
    sync();
    dock.onDidActivePanelChange(sync);
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      const k = layoutKey();
      try {
        if (k) localStorage.setItem(k, JSON.stringify(dock.toJSON()));
      } catch {
        // Storage can be unavailable; layout just won't persist.
      }
    };
    dock.onDidLayoutChange(() => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 300);
    });
    // Don't lose a change made just before quitting or reloading.
    window.addEventListener("beforeunload", () => saveTimer && save());
  },

  open(path, opts = {}) {
    const dock = get().dock;
    if (!dock) return;
    const focus =
      opts.subpath !== undefined || opts.line !== undefined || opts.offset !== undefined
        ? { subpath: opts.subpath, line: opts.line, offset: opts.offset, nonce: ++focusNonce }
        : undefined;
    const active = dock.activePanel;

    if (active && !opts.newTab && !opts.split) {
      const current = paramsOf(active);
      const params: PanelParams =
        current.path === path
          ? { ...current, focus: focus ?? current.focus, editTitle: opts.editTitle }
          : {
              ...current,
              path,
              back: [...current.back, current.path].slice(-50),
              forward: [],
              focus,
              editTitle: opts.editTitle,
            };
      update(active, params);
      return;
    }

    const params: PanelParams = {
      path,
      mode: active
        ? paramsOf(active).mode === "reading"
          ? "live"
          : paramsOf(active).mode
        : "live",
      back: [],
      forward: [],
      focus,
      editTitle: opts.editTitle,
    };
    dock.addPanel({
      id: `tab-${++panelCounter}`,
      component: "file",
      title: titleOf(path),
      params: params as unknown as Record<string, unknown>,
      position: active
        ? opts.split
          ? { referencePanel: active, direction: opts.split === "right" ? "right" : "below" }
          : { referencePanel: active, direction: "within" }
        : undefined,
    });
  },

  async openLink(source, href, opts = {}) {
    const { target, subpath } = splitTarget(href);
    if (!target) {
      get().open(source, { ...opts, subpath, newTab: opts.newTab });
      return;
    }
    try {
      let resolved = opts.resolved;
      if (resolved === undefined) [resolved] = await api.resolveLinks(source, [target]);
      if (resolved) {
        get().open(resolved, { ...opts, subpath });
        return;
      }
      // Like Obsidian, following a link to a missing note creates it. The
      // backend picks the folder (daily notes go to the daily folder).
      const path = await api.createFromLink(source, target);
      get().open(path, opts);
    } catch (err) {
      useUi.getState().notify(message(err));
    }
  },

  setMode(panelId, mode) {
    const panel = get().dock?.getPanel(panelId);
    if (panel) update(panel, { ...paramsOf(panel), mode, focus: undefined, editTitle: false });
  },

  toggleReading() {
    const panel = get().dock?.activePanel;
    if (!panel) return;
    const params = paramsOf(panel);
    // Pages have two modes: the page itself (any mode but source) and source.
    if (isPagePath(params.path)) {
      get().setMode(panel.id, params.mode === "source" ? "reading" : "source");
      return;
    }
    get().setMode(panel.id, params.mode === "reading" ? "live" : "reading");
  },

  back(panelId) {
    const dock = get().dock;
    const panel = panelId ? dock?.getPanel(panelId) : dock?.activePanel;
    if (!panel) return;
    const p = paramsOf(panel);
    const prev = p.back[p.back.length - 1];
    if (!prev) return;
    update(panel, {
      ...p,
      path: prev,
      back: p.back.slice(0, -1),
      forward: [p.path, ...p.forward],
      focus: undefined,
      editTitle: false,
    });
  },

  forward(panelId) {
    const dock = get().dock;
    const panel = panelId ? dock?.getPanel(panelId) : dock?.activePanel;
    if (!panel) return;
    const p = paramsOf(panel);
    const next = p.forward[0];
    if (!next) return;
    update(panel, {
      ...p,
      path: next,
      back: [...p.back, p.path],
      forward: p.forward.slice(1),
      focus: undefined,
      editTitle: false,
    });
  },

  closeActive() {
    get().dock?.activePanel?.api.close();
  },

  async newNote(folder, opts = {}) {
    const where = folder ?? newNoteFolder(get().activePath);
    try {
      const path = await api.createUntitled(where);
      useVault.getState().revealInTree(path);
      get().open(path, { ...opts, editTitle: true });
    } catch (err) {
      useUi.getState().notify(message(err));
    }
  },
}));

/** Keeps open tabs pointing at files that moved, and closes tabs of deleted files. */
function followChanges(changes: FileChange[]) {
  const dock = useWorkspace.getState().dock;
  if (!dock) return;
  const moves = new Map<string, string>();
  const removed = new Set<string>();
  for (const c of changes) {
    if (c.kind === "moved" && c.from) moves.set(c.from, c.path);
    if (c.kind === "removed") removed.add(c.path);
  }
  if (!moves.size && !removed.size) return;
  const remap = (p: string) => moves.get(p) ?? p;
  for (const panel of [...dock.panels]) {
    const p = paramsOf(panel);
    if (removed.has(p.path) && !moves.has(p.path)) {
      panel.api.close();
      continue;
    }
    const path = remap(p.path);
    const back = p.back.map(remap).filter((x) => !removed.has(x));
    const forward = p.forward.map(remap).filter((x) => !removed.has(x));
    if (path !== p.path || back.join() !== p.back.join() || forward.join() !== p.forward.join()) {
      update(panel, { ...p, path, back, forward, editTitle: false });
    }
  }
}

onVaultChange(followChanges);
