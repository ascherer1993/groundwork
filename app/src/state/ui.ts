import { create } from "zustand";

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export type MenuEntry = MenuItem | "separator";

interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

export interface DialogField {
  label: string;
  value?: string;
  placeholder?: string;
}

interface Dialog {
  id: number;
  title: string;
  message?: string;
  /** Text inputs; none for a plain confirmation. */
  fields?: DialogField[];
  confirmLabel: string;
  danger?: boolean;
  /** The field values, or `null` if cancelled. */
  resolve: (values: string[] | null) => void;
}

/** One row in a palette: a command, a template… */
export interface PaletteItem {
  id: string;
  label: string;
  /** Shown after the label, dimmed (e.g. a folder). */
  detail?: string;
  /** Shown on the right (e.g. a shortcut). */
  hint?: string;
  run(): void | Promise<void>;
}

interface Palette {
  id: number;
  placeholder: string;
  items: PaletteItem[];
  /** Remembers choices under this key and lists recent ones first. */
  recentKey?: string;
}

interface Hover {
  /** Vault path of the previewed file. */
  path: string;
  subpath?: string;
  x: number;
  y: number;
}

export type SidebarView = "files" | "search" | "tags" | "todos" | "workspaces" | "tickets";

interface UiState {
  switcherOpen: boolean;
  sidebarView: SidebarView;
  search: { query: string; /** Bumped to focus the search box. */ nonce: number };
  rightPanelOpen: boolean;
  menu: { x: number; y: number; items: MenuEntry[] } | null;
  toast: Toast | null;
  dialog: Dialog | null;
  palette: Palette | null;
  /** The "Set up Claude Code" dialog. */
  setupOpen: boolean;
  hover: Hover | null;
  /** Tree path being renamed inline. */
  renaming: string | null;

  setSwitcher(open: boolean): void;
  setSidebarView(view: SidebarView): void;
  /** Shows the search view and focuses it, optionally with a new query. */
  searchFor(query?: string): void;
  openPalette(palette: Omit<Palette, "id">): void;
  closePalette(): void;
  openSetup(): void;
  settingsOpen: boolean;
  setSettingsOpen(open: boolean): void;
  closeSetup(): void;
  toggleRightPanel(): void;
  showMenu(x: number, y: number, items: MenuEntry[]): void;
  closeMenu(): void;
  notify(message: string, action?: Toast["action"]): void;
  dismissToast(): void;
  showHover(hover: Hover | null): void;
  setRenaming(path: string | null): void;
}

let toastId = 0;
let dialogId = 0;
let paletteId = 0;

export const useUi = create<UiState>((set) => ({
  switcherOpen: false,
  sidebarView: "files",
  search: { query: "", nonce: 0 },
  rightPanelOpen: true,
  menu: null,
  toast: null,
  dialog: null,
  palette: null,
  setupOpen: false,
  settingsOpen: false,
  hover: null,
  renaming: null,

  setSwitcher: (switcherOpen) => set({ switcherOpen }),
  setSidebarView: (sidebarView) => set({ sidebarView }),
  searchFor: (query) =>
    set((s) => ({
      sidebarView: "search",
      search: { query: query ?? s.search.query, nonce: s.search.nonce + 1 },
    })),
  openPalette: (palette) => set({ palette: { ...palette, id: ++paletteId }, switcherOpen: false }),
  closePalette: () => set({ palette: null }),
  openSetup: () => set({ setupOpen: true, palette: null, switcherOpen: false }),
  closeSetup: () => set({ setupOpen: false }),
  setSettingsOpen: (settingsOpen) =>
    set(settingsOpen ? { settingsOpen, palette: null, switcherOpen: false } : { settingsOpen }),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  showMenu: (x, y, items) => set({ menu: { x, y, items } }),
  closeMenu: () => set({ menu: null }),
  notify: (message, action) => set({ toast: { id: ++toastId, message, action } }),
  dismissToast: () => set({ toast: null }),
  showHover: (hover) => set({ hover }),
  setRenaming: (renaming) => set({ renaming }),
}));

/** Asks for confirmation. Resolves `true` if confirmed. */
export function confirmDialog(opts: {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) =>
    useUi.setState({
      dialog: {
        id: ++dialogId,
        confirmLabel: "OK",
        ...opts,
        resolve: (values) => resolve(values !== null),
      },
    }),
  );
}

/** Asks for a line of text. Resolves `null` if cancelled. */
export function promptDialog(opts: {
  title: string;
  value?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return formDialog({
    title: opts.title,
    confirmLabel: opts.confirmLabel,
    fields: [{ label: opts.title, value: opts.value }],
  }).then((values) => values?.[0] ?? null);
}

/** Asks for several values at once. Resolves `null` if cancelled. */
export function formDialog(opts: {
  title: string;
  message?: string;
  fields: DialogField[];
  confirmLabel?: string;
}): Promise<string[] | null> {
  return new Promise((resolve) =>
    useUi.setState({
      dialog: { id: ++dialogId, confirmLabel: "OK", ...opts, resolve },
    }),
  );
}
