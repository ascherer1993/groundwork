/**
 * Tabs and splits (dockview) for files and terminals, per-tab history, and
 * link navigation. The main area shows one "area" at a time: the notes
 * layout, or a workspace's own layout (see `workspaces.ts`). Each area has
 * its own dock; `dock` is the one on screen.
 */
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { create } from "zustand";
import { api } from "../api/client";
import type { FileChange } from "../api/generated/FileChange";
import type { TerminalInfo } from "../api/generated/TerminalInfo";
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

/** A terminal tab's params. */
export interface TerminalParams {
  /** The session in `groundworkd`. */
  terminal: string;
  /** Where it started, for a replacement shell if the session is gone. */
  cwd: string;
}

export function isTerminal(panel: IDockviewPanel): boolean {
  return "terminal" in panel.params!;
}

/** A terminal tab's title: what the program set, else its folder's name. */
export function terminalTitle(title: string, cwd: string): string {
  return title.trim() || cwd.slice(cwd.lastIndexOf("/") + 1) || cwd;
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

/** The notes area: the layout that isn't a workspace's. */
export const NOTES = "notes";

interface WorkspaceState {
  /** The dock on screen. */
  dock: DockviewApi | null;
  /** Every mounted area's dock, by area. */
  docks: Record<string, DockviewApi>;
  /** `NOTES`, or the id of the workspace on screen. */
  area: string;
  /** Bumped when any dock's tabs change, for views that list them. */
  tabsVersion: number;
  activePanelId: string | null;
  activePath: string | null;

  /**
   * Sets up a mounted area's dock: restores its layout and saves changes.
   * Returns the cleanup to run when it unmounts.
   */
  attach(dock: DockviewApi, area: string, layout?: unknown): () => void;
  /** Puts an area on screen. */
  setArea(area: string): void;
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
  /**
   * A shell in `cwd` in a new tab of the area on screen. By default it starts
   * in the workspace's folder, or the vault root in the notes area.
   */
  openTerminal(cwd?: string): Promise<void>;
  /** Shows a running terminal in a new tab of the area on screen. */
  addTerminal(info: TerminalInfo): void;
  /** Shows a running terminal (by session id) in a tab, if one has it. */
  showTerminal(id: string): boolean;
  /** Every terminal in a tab, with the area it's in. */
  terminalTabs(): { area: string; panel: IDockviewPanel; terminal: string }[];
}

let panelCounter = 0;
/** Docks whose saved layout was restored. */
const restored = new WeakSet<DockviewApi>();
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

function areaKey(): string | null {
  const vault = useVault.getState().vault;
  return vault ? `groundwork.area:${vault.path}` : null;
}

/** The area last on screen in this vault. */
export function savedArea(): string {
  try {
    return localStorage.getItem(areaKey() ?? "") ?? NOTES;
  } catch {
    return NOTES;
  }
}

/** Where terminals in an area start by default. */
let areaFolders: (area: string) => string | undefined = () => undefined;
export function setAreaFolders(fn: (area: string) => string | undefined) {
  areaFolders = fn;
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

/** The active tab if it shows a file (not a terminal). */
function activeFile(dock: DockviewApi | null | undefined): IDockviewPanel | undefined {
  const panel = dock?.activePanel;
  return panel && !isTerminal(panel) ? panel : undefined;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  dock: null,
  docks: {},
  area: NOTES,
  tabsVersion: 0,
  activePanelId: null,
  activePath: null,

  attach(dock, area, layout) {
    let disposed = false;
    const listeners: { dispose(): void }[] = [];
    // Once per dock, though React may attach it twice (StrictMode).
    if (!restored.has(dock)) {
      restored.add(dock);
      try {
        if (area === NOTES) {
          const saved = layoutKey() && localStorage.getItem(layoutKey()!);
          if (saved) dock.fromJSON(JSON.parse(saved));
        } else if (layout) {
          dock.fromJSON(layout as Parameters<DockviewApi["fromJSON"]>[0]);
        }
      } catch {
        dock.clear();
      }
    }
    for (const panel of dock.panels) {
      const n = Number(panel.id.replace(/^tab-/, ""));
      if (n > panelCounter) panelCounter = n;
    }
    set((s) => ({ docks: { ...s.docks, [area]: dock } }));
    const sync = () => {
      if (get().area !== area) return;
      const panel = dock.activePanel;
      const path = panel && !isTerminal(panel) ? paramsOf(panel).path : null;
      set({ dock, activePanelId: panel?.id ?? null, activePath: path });
      if (path) useVault.getState().revealInTree(path);
    };
    sync();
    listeners.push(dock.onDidActivePanelChange(sync));
    const touch = () => !disposed && set((s) => ({ tabsVersion: s.tabsVersion + 1 }));
    listeners.push(
      dock.onDidAddPanel((panel) => {
        touch();
        panel.api.onDidTitleChange(touch);
      }),
    );
    for (const panel of dock.panels) panel.api.onDidTitleChange(touch);
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      if (disposed) return;
      if (area !== NOTES) {
        void api.saveWorkspaceLayout(area, dock.toJSON()).catch(() => {});
        return;
      }
      const k = layoutKey();
      try {
        if (k) localStorage.setItem(k, JSON.stringify(dock.toJSON()));
      } catch {
        // Storage can be unavailable; layout just won't persist.
      }
    };
    listeners.push(
      dock.onDidLayoutChange(() => {
        touch();
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 300);
      }),
    );
    // Don't lose a change made just before quitting or reloading.
    const flush = () => saveTimer && save();
    window.addEventListener("beforeunload", flush);
    // Closing a terminal tab ends its session, as closing a terminal window
    // does. Not when the whole dock goes (switching vaults, deleting a
    // workspace): those decide for themselves.
    listeners.push(
      dock.onDidRemovePanel((panel) => {
        touch();
        if (!isTerminal(panel)) return;
        const { terminal } = panel.params as unknown as TerminalParams;
        setTimeout(() => {
          if (!disposed) void api.killTerminal(terminal).catch(() => {});
        });
      }),
    );
    return () => {
      flush();
      disposed = true;
      listeners.forEach((l) => l.dispose());
      window.removeEventListener("beforeunload", flush);
      set((s) => {
        const docks = { ...s.docks };
        if (docks[area] === dock) delete docks[area];
        return { docks, dock: s.dock === dock ? null : s.dock };
      });
    };
  },

  setArea(area) {
    const dock = get().docks[area] ?? null;
    const panel = dock?.activePanel;
    const path = panel && !isTerminal(panel) ? paramsOf(panel).path : null;
    set({ area, dock, activePanelId: panel?.id ?? null, activePath: path });
    if (path) useVault.getState().revealInTree(path);
    try {
      const k = areaKey();
      if (k) localStorage.setItem(k, area);
    } catch {
      // Not remembered; the notes area shows next time.
    }
  },

  open(path, opts = {}) {
    const dock = get().dock;
    if (!dock) return;
    const focus =
      opts.subpath !== undefined || opts.line !== undefined || opts.offset !== undefined
        ? { subpath: opts.subpath, line: opts.line, offset: opts.offset, nonce: ++focusNonce }
        : undefined;
    // A file opened from a terminal tab goes in a new tab beside it.
    const active = dock.activePanel;
    const file = activeFile(dock);

    if (file && !opts.newTab && !opts.split) {
      const current = paramsOf(file);
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
      update(file, params);
      return;
    }

    const params: PanelParams = {
      path,
      mode: file ? (paramsOf(file).mode === "reading" ? "live" : paramsOf(file).mode) : "live",
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
    if (panel && !isTerminal(panel))
      update(panel, { ...paramsOf(panel), mode, focus: undefined, editTitle: false });
  },

  toggleReading() {
    const panel = activeFile(get().dock);
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
    const panel = panelId ? dock?.getPanel(panelId) : activeFile(dock);
    if (!panel || isTerminal(panel)) return;
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
    const panel = panelId ? dock?.getPanel(panelId) : activeFile(dock);
    if (!panel || isTerminal(panel)) return;
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

  async openTerminal(cwd) {
    const area = get().area;
    try {
      // The view resizes it to fit once it's on screen.
      const info = await api.createTerminal(
        { cols: 100, rows: 30 },
        cwd ?? areaFolders(area),
        area === NOTES ? undefined : area,
      );
      get().addTerminal(info);
    } catch (err) {
      useUi.getState().notify(message(err));
    }
  },

  addTerminal(info) {
    const dock = get().dock;
    if (!dock) return;
    const params: TerminalParams = { terminal: info.id, cwd: info.cwd };
    const active = dock.activePanel;
    dock.addPanel({
      id: `tab-${++panelCounter}`,
      component: "terminal",
      title: terminalTitle(info.title, info.cwd),
      params: params as unknown as Record<string, unknown>,
      position: active ? { referencePanel: active, direction: "within" } : undefined,
    });
  },

  showTerminal(id) {
    const tab = get()
      .terminalTabs()
      .find((t) => t.terminal === id);
    if (!tab) return false;
    get().setArea(tab.area);
    tab.panel.api.setActive();
    return true;
  },

  terminalTabs() {
    return Object.entries(get().docks).flatMap(([area, dock]) =>
      dock.panels.filter(isTerminal).map((panel) => ({
        area,
        panel,
        terminal: (panel.params as unknown as TerminalParams).terminal,
      })),
    );
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
  for (const dock of Object.values(useWorkspace.getState().docks)) followChangesIn(dock, changes);
}

function followChangesIn(dock: DockviewApi, changes: FileChange[]) {
  const moves = new Map<string, string>();
  const removed = new Set<string>();
  for (const c of changes) {
    if (c.kind === "moved" && c.from) moves.set(c.from, c.path);
    if (c.kind === "removed") removed.add(c.path);
  }
  if (!moves.size && !removed.size) return;
  const remap = (p: string) => moves.get(p) ?? p;
  for (const panel of dock.panels.filter((p) => !isTerminal(p))) {
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
