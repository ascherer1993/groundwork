/**
 * Tabs and splits (dockview) for files and terminals, per-tab history, and
 * link navigation. Notes (and pages) live in one dock; each workspace has a
 * dock of its own for its terminals (see `workspaces.ts`). The view decides
 * what's on screen: the notes, the notes beside the current workspace's
 * terminals, or the terminals alone.
 */
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { create } from "zustand";
import { api } from "../api/client";
import type { FileChange } from "../api/generated/FileChange";
import type { TabInfo } from "../api/generated/TabInfo";
import type { TerminalInfo } from "../api/generated/TerminalInfo";
import { displayName, isPagePath, projectOfView, TODO_BOARD } from "../lib/paths";
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
  /** The links panel beside the file is open (closed by default). */
  links?: boolean;
}

/** A terminal tab's params. */
export interface TerminalParams {
  /** The session in `groundworkd`. */
  terminal: string;
  /** Where it started, for a replacement shell if the session is gone. */
  cwd: string;
  /** The Claude Code session last seen in it, to resume or fork after a restart. */
  session?: string;
  /** A name you gave the tab, shown instead of what the program set. */
  name?: string;
}

export function isTerminal(panel: IDockviewPanel): boolean {
  return "terminal" in panel.params!;
}

/** A terminal tab's title: what the program set, else its folder's name. */
export function terminalTitle(title: string, cwd: string): string {
  return title.trim() || cwd.slice(cwd.lastIndexOf("/") + 1) || cwd;
}

export interface TerminalOptions {
  /** Beside the active tab instead of in its group. */
  split?: "right" | "below";
  /** A command line to type into the new shell. */
  run?: string;
  /** The workspace it goes in. By default `beside`'s, else the current one (made if there's none). */
  workspace?: string;
  /** A terminal whose group the new tab joins. */
  beside?: string;
  /** Leave what's on screen as it is. */
  background?: boolean;
}

export interface OpenOptions {
  newTab?: boolean;
  split?: "right" | "below" | "left";
  subpath?: string;
  line?: number;
  /** Put the cursor here and focus the editor; past the end means the end. */
  offset?: number;
  editTitle?: boolean;
  /** Leave the view as it is, even if the notes aren't on screen. */
  background?: boolean;
}

/** The notes dock's key in `docks`. */
export const NOTES = "notes";

/** Notes alone, notes beside terminals, or terminals alone. */
export type View = "note" | "split" | "terminal";

interface WorkspaceState {
  /** The notes dock and each workspace's, by workspace id. */
  docks: Record<string, DockviewApi>;
  view: View;
  /** The workspace whose terminals show in the split and terminal views. */
  workspace: string | null;
  /** Keeps the current workspace when other notes open (see `follow.ts`). */
  locked: boolean;
  /** Which side the last click or keypress went to, for ⌘W. */
  focused: "notes" | "terminals";
  /** Bumped when any dock's tabs change, for views that list them. */
  tabsVersion: number;
  /** The file in the notes dock's active tab. */
  activePath: string | null;
  /** Each workspace's active terminal tab: the terminal's id. */
  activeTerminals: Record<string, string | null>;

  /**
   * Sets up a mounted area's dock: restores its layout and saves changes.
   * Returns the cleanup to run when it unmounts.
   */
  attach(dock: DockviewApi, area: string, layout?: unknown): () => void;
  setView(view: View): void;
  /**
   * Makes a workspace the current one. Its terminals come on screen (beside
   * the notes, if only notes were showing) unless `view` says otherwise.
   */
  showWorkspace(id: string | null, view?: View): void;
  setFocused(side: "notes" | "terminals"): void;
  setLocked(locked: boolean): void;
  open(path: string, opts?: OpenOptions): void;
  openLink(
    source: string,
    href: string,
    opts?: OpenOptions & { resolved?: string | null },
  ): Promise<void>;
  setMode(panelId: string, mode: ViewMode): void;
  toggleReading(): void;
  /** Opens or closes the links panel beside a tab (the active one by default). */
  toggleLinks(panelId?: string): void;
  back(panelId?: string): void;
  forward(panelId?: string): void;
  closeActive(): void;
  newNote(folder?: string, opts?: OpenOptions): Promise<void>;
  /**
   * A shell in `cwd` in a new tab of the current workspace (made if there's
   * none), which comes on screen. By default it starts in the workspace's
   * folder. `run` is typed into it.
   */
  openTerminal(cwd?: string, opts?: TerminalOptions): Promise<void>;
  /** `openTerminal` for callers that want the tab, or the error. */
  newTerminal(cwd?: string, opts?: TerminalOptions): Promise<TabInfo>;
  /** Shows a running terminal in a new tab of the current workspace (or `opts.workspace`). */
  addTerminal(info: TerminalInfo, opts?: TerminalOptions): Promise<TabInfo | null>;
  /** The notes dock's tab showing `path`, if one does. */
  fileTab(path: string): IDockviewPanel | undefined;
  /** Shows a running terminal (by session id) in a tab, if one has it. */
  showTerminal(id: string): boolean;
  /** Closes a terminal's tab, ending its session; false if no tab has it. */
  closeTerminal(id: string): boolean;
  /** Every terminal in a tab, with the workspace it's in. */
  terminalTabs(): { area: string; panel: IDockviewPanel; terminal: string }[];
  /** The same, as the CLI sees them (`groundwork tab list`). */
  tabInfos(): TabInfo[];
}

let panelCounter = 0;
/** Docks whose saved layout was restored. */
const restored = new WeakSet<DockviewApi>();
let focusNonce = 0;

function titleOf(path: string): string {
  // A view names itself once it's loaded (`ProjectView`).
  const project = projectOfView(path);
  if (project) return project;
  if (path === TODO_BOARD) return "Todo board";
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = name.toLowerCase().endsWith(".md") ? "" : null;
  return ext === null ? name : displayName(name, "note").base;
}

function layoutKey(): string | null {
  const vault = useVault.getState().vault;
  return vault ? `groundwork.layout:${vault.path}` : null;
}

type Remembered = "workspace" | "view" | "locked" | "pinned";

function storageKey(name: Remembered): string | null {
  const vault = useVault.getState().vault;
  return vault ? `groundwork.${name}:${vault.path}` : null;
}

function remember(name: Remembered, value: string | null) {
  try {
    const k = storageKey(name);
    if (!k) return;
    if (value === null) localStorage.removeItem(k);
    else localStorage.setItem(k, value);
  } catch {
    // Not remembered; the defaults show next time.
  }
}

function recall(name: Remembered): string | null {
  try {
    return localStorage.getItem(storageKey(name) ?? "");
  } catch {
    return null;
  }
}

/** The workspace and view last on screen in this vault, and whether it was locked. */
export function savedView(): { workspace: string | null; view: View; locked: boolean } {
  const view = recall("view");
  return {
    workspace: recall("workspace"),
    view: view === "split" || view === "terminal" ? view : "note",
    // Locking was called pinning at first.
    locked: (recall("locked") ?? recall("pinned")) === "true",
  };
}

/** How workspaces start terminals, and make one when there's none (`workspaces.ts`). */
interface WorkspaceHooks {
  folder(id: string): string | undefined;
  /** A new workspace for terminals in `cwd`, mounted and ready. */
  make(cwd?: string): Promise<string | null>;
  /** Resolves once a workspace's dock is mounted. */
  ready(id: string): Promise<boolean>;
}
let hooks: WorkspaceHooks = {
  folder: () => undefined,
  make: async () => null,
  ready: async () => false,
};
export function setWorkspaceHooks(h: WorkspaceHooks) {
  hooks = h;
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

/** The current workspace, or a new one for terminals in `cwd` if there's none. */
async function terminalWorkspace(cwd?: string, opts: TerminalOptions = {}): Promise<string | null> {
  const { workspace, docks, terminalTabs } = useWorkspace.getState();
  const area =
    opts.workspace ?? terminalTabs().find((t) => t.terminal === opts.beside)?.area ?? workspace;
  if (area && (docks[area] || (await hooks.ready(area)))) return area;
  if (opts.workspace) throw new Error(`no workspace ${opts.workspace}`);
  return hooks.make(cwd);
}

/** The notes dock's active tab. */
function activeFile(): IDockviewPanel | undefined {
  return useWorkspace.getState().docks[NOTES]?.activePanel;
}

/** Counts workspaces coming on screen, to tell whether one did meanwhile. */
let switches = 0;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  docks: {},
  view: "note",
  workspace: null,
  locked: false,
  focused: "notes",
  tabsVersion: 0,
  activePath: null,
  activeTerminals: {},

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
      // Notes hold files and workspaces terminals; older layouts mixed them.
      // (Before the listeners below, so a terminal moved out keeps running.)
      for (const panel of [...dock.panels]) {
        if ((area === NOTES) === isTerminal(panel)) dock.removePanel(panel);
      }
    }
    for (const panel of dock.panels) {
      const n = Number(panel.id.replace(/^tab-/, ""));
      if (n > panelCounter) panelCounter = n;
    }
    set((s) => ({ docks: { ...s.docks, [area]: dock } }));
    if (area === NOTES) {
      const sync = () => {
        const panel = dock.activePanel;
        const path = panel ? paramsOf(panel).path : null;
        set({ activePath: path });
        if (path) useVault.getState().revealInTree(path);
      };
      sync();
      listeners.push(dock.onDidActivePanelChange(sync));
    } else {
      const sync = () => {
        if (disposed) return;
        const panel = dock.activePanel;
        const terminal =
          panel && isTerminal(panel) ? (panel.params as unknown as TerminalParams).terminal : null;
        set((s) => ({ activeTerminals: { ...s.activeTerminals, [area]: terminal } }));
      };
      sync();
      listeners.push(dock.onDidActivePanelChange(sync));
    }
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
    // Tabs opening or closing save at once (a workspace's layout goes to the
    // backend, which a quit could cut off); drags and resizes settle first.
    let saved = dock.panels.length;
    listeners.push(
      dock.onDidLayoutChange(() => {
        touch();
        if (saveTimer) clearTimeout(saveTimer);
        const now = dock.panels.length !== saved;
        saved = dock.panels.length;
        saveTimer = setTimeout(save, now ? 0 : 300);
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
        return { docks };
      });
    };
  },

  setView(view) {
    set({ view, focused: view === "terminal" ? "terminals" : "notes" });
    remember("view", view);
  },

  showWorkspace(id, view) {
    switches++;
    set({ workspace: id });
    remember("workspace", id);
    if (view) get().setView(view);
    else if (id && get().view === "note") get().setView("split");
  },

  setFocused(side) {
    if (get().focused !== side) set({ focused: side });
  },

  setLocked(locked) {
    set({ locked });
    remember("locked", locked ? "true" : null);
    remember("pinned", null);
  },

  open(path, opts = {}) {
    const dock = get().docks[NOTES];
    if (!dock) return;
    // Notes need to be on screen.
    if (get().view === "terminal" && !opts.background) get().setView("split");
    const focus =
      opts.subpath !== undefined || opts.line !== undefined || opts.offset !== undefined
        ? { subpath: opts.subpath, line: opts.line, offset: opts.offset, nonce: ++focusNonce }
        : undefined;
    const active = dock.activePanel;
    const file = active;

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
          ? { referencePanel: active, direction: opts.split }
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
    const panel = get().docks[NOTES]?.getPanel(panelId);
    if (panel) update(panel, { ...paramsOf(panel), mode, focus: undefined, editTitle: false });
  },

  toggleReading() {
    const panel = activeFile();
    if (!panel) return;
    const params = paramsOf(panel);
    // Pages have two modes: the page itself (any mode but source) and source.
    if (isPagePath(params.path)) {
      get().setMode(panel.id, params.mode === "source" ? "reading" : "source");
      return;
    }
    get().setMode(panel.id, params.mode === "reading" ? "live" : "reading");
  },

  toggleLinks(panelId) {
    const panel = panelId ? get().docks[NOTES]?.getPanel(panelId) : activeFile();
    if (!panel) return;
    const params = paramsOf(panel);
    update(panel, { ...params, links: !params.links, focus: undefined, editTitle: false });
  },

  back(panelId) {
    const panel = panelId ? get().docks[NOTES]?.getPanel(panelId) : activeFile();
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
    const panel = panelId ? get().docks[NOTES]?.getPanel(panelId) : activeFile();
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
    const { view, focused, workspace, docks } = get();
    const terminals = view === "terminal" || (view === "split" && focused === "terminals");
    const dock = terminals ? (workspace ? docks[workspace] : undefined) : docks[NOTES];
    dock?.activePanel?.api.close();
  },

  async openTerminal(cwd, opts = {}) {
    try {
      await get().newTerminal(cwd, opts);
    } catch (err) {
      useUi.getState().notify(message(err));
    }
  },

  async newTerminal(cwd, opts = {}) {
    const id = await terminalWorkspace(cwd, opts);
    if (!id) throw new Error("there's no workspace for the terminal");
    const seen = switches;
    // The view resizes it to fit once it's on screen.
    const info = await api.createTerminal({ cols: 100, rows: 30 }, cwd ?? hooks.folder(id), id);
    // Another workspace came on screen while it started (the terminals
    // following a note, a pick): the tab joins its own quietly.
    const moved = switches !== seen && get().workspace !== id;
    const tab = await get().addTerminal(info, {
      ...opts,
      workspace: id,
      background: opts.background || moved,
    });
    // The shell reads it once it starts.
    if (opts.run) await api.terminalInput(info.id, `${opts.run}\r`);
    if (!tab) throw new Error("the terminal's workspace went away");
    return tab;
  },

  async addTerminal(info, opts = {}) {
    const id = await terminalWorkspace(info.cwd, opts);
    const dock = id ? get().docks[id] : undefined;
    if (!id || !dock) return null;
    if (!opts.background) {
      get().showWorkspace(id);
      get().setFocused("terminals");
    }
    const params: TerminalParams = { terminal: info.id, cwd: info.cwd };
    const near =
      get()
        .terminalTabs()
        .find((t) => t.terminal === opts.beside && t.area === id)?.panel ?? dock.activePanel;
    dock.addPanel({
      id: `tab-${++panelCounter}`,
      component: "terminal",
      title: terminalTitle(info.title, info.cwd),
      params: params as unknown as Record<string, unknown>,
      position: near ? { referencePanel: near, direction: opts.split ?? "within" } : undefined,
      inactive: opts.background && !!dock.activePanel,
    });
    return get()
      .tabInfos()
      .find((t) => t.terminal === info.id)!;
  },

  fileTab(path) {
    return get().docks[NOTES]?.panels.find((p) => paramsOf(p).path === path);
  },

  showTerminal(id) {
    const tab = get()
      .terminalTabs()
      .find((t) => t.terminal === id);
    if (!tab) return false;
    get().showWorkspace(tab.area);
    tab.panel.api.setActive();
    return true;
  },

  closeTerminal(id) {
    const tab = get()
      .terminalTabs()
      .find((t) => t.terminal === id);
    tab?.panel.api.close();
    return !!tab;
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

  tabInfos() {
    const shown = shownTerminal(get());
    return get()
      .terminalTabs()
      .map((t) => ({
        terminal: t.terminal,
        workspace: t.area,
        title: t.panel.title ?? "",
        shown: t.terminal === shown,
      }));
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
  const notes = useWorkspace.getState().docks[NOTES];
  if (notes) followChangesIn(notes, changes);
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
  for (const panel of dock.panels) {
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

/** The terminal on screen: the current workspace's active tab, when terminals show. */
export function shownTerminal(s: WorkspaceState): string | null {
  if (s.view === "note" || !s.workspace) return null;
  return s.activeTerminals[s.workspace] ?? null;
}
