/**
 * Keyboard shortcuts: every command that can have one, its default, and the
 * ones you've changed (kept in the app's settings, `settings.json` in the
 * data folder, so they're the same in every vault).
 */
import { create } from "zustand";
import { api } from "../api/client";
import { displayCombo } from "../lib/keyCombo";
import { useUi } from "./ui";
import { message } from "./vault";

export interface KeyCommand {
  /** The palette command it runs, when there is one (see `commands.ts`). */
  id: string;
  label: string;
  group: "General" | "Notes" | "Views and workspaces";
  /** The default combination, or null for none. */
  key: string | null;
}

const workspaceKeys: KeyCommand[] = Array.from({ length: 9 }, (_, i) => ({
  id: `workspace-${i + 1}`,
  label: `Workspace ${i + 1}`,
  group: "Views and workspaces",
  key: `Cmd+${i + 1}`,
}));

export const KEY_COMMANDS: KeyCommand[] = [
  { id: "palette", label: "Command palette", group: "General", key: "Cmd+P" },
  { id: "switcher", label: "Open quick switcher", group: "General", key: "Cmd+O" },
  { id: "search", label: "Search in all notes", group: "General", key: "Shift+Cmd+F" },
  { id: "settings", label: "Settings", group: "General", key: "Cmd+," },
  { id: "close-tab", label: "Close tab", group: "General", key: "Cmd+W" },
  { id: "inbox", label: "Show the inbox", group: "General", key: "Shift+Cmd+I" },
  { id: "toggle-right", label: "Toggle links panel", group: "General", key: "Shift+Cmd+B" },
  { id: "undo-file", label: "Undo the last file change", group: "General", key: "Cmd+Z" },
  { id: "new-note", label: "New note", group: "Notes", key: "Cmd+N" },
  { id: "daily-today", label: "Open today’s daily note", group: "Notes", key: "Shift+Cmd+D" },
  { id: "toggle-reading", label: "Toggle reading view", group: "Notes", key: "Cmd+E" },
  { id: "split-right", label: "Split right", group: "Notes", key: "Cmd+\\" },
  { id: "back", label: "Go back", group: "Notes", key: "Cmd+[" },
  { id: "forward", label: "Go forward", group: "Notes", key: "Cmd+]" },
  { id: "view-note", label: "Show notes only", group: "Views and workspaces", key: "Ctrl+Cmd+1" },
  {
    id: "view-split",
    label: "Show notes and terminals",
    group: "Views and workspaces",
    key: "Ctrl+Cmd+2",
  },
  {
    id: "view-terminal",
    label: "Show terminals only",
    group: "Views and workspaces",
    key: "Ctrl+Cmd+3",
  },
  { id: "new-terminal", label: "New terminal", group: "Views and workspaces", key: "Cmd+T" },
  {
    id: "switch-workspace",
    label: "Switch workspace…",
    group: "Views and workspaces",
    key: "Ctrl+Cmd+W",
  },
  {
    id: "next-workspace",
    label: "Next workspace",
    group: "Views and workspaces",
    key: "Ctrl+Cmd+]",
  },
  {
    id: "previous-workspace",
    label: "Previous workspace",
    group: "Views and workspaces",
    key: "Ctrl+Cmd+[",
  },
  {
    id: "toggle-pin",
    label: "Pin or unpin the terminals",
    group: "Views and workspaces",
    key: null,
  },
  ...workspaceKeys,
];

const BY_ID = new Map(KEY_COMMANDS.map((c) => [c.id, c]));

interface KeysState {
  /** Changed bindings: a combination, or null for none. */
  overrides: Record<string, string | null>;
  /** The command whose new keys are being recorded (shortcuts are off meanwhile). */
  recording: string | null;
  load(): Promise<void>;
  setRecording(id: string | null): void;
  /**
   * Binds a command. Another command with the same keys loses them; its label
   * is returned.
   */
  bind(id: string, combo: string | null): Promise<string | null>;
  reset(id: string): Promise<void>;
  resetAll(): Promise<void>;
}

async function save(overrides: Record<string, string | null>) {
  try {
    await api.saveSettings({ keys: overrides });
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

export const useKeys = create<KeysState>((set, get) => ({
  overrides: {},
  recording: null,

  async load() {
    try {
      const settings = await api.settings();
      set({ overrides: settings.keys });
    } catch {
      // The defaults stand.
    }
  },

  setRecording(id) {
    set({ recording: id });
  },

  async bind(id, combo) {
    const overrides = { ...get().overrides };
    let displaced: string | null = null;
    if (combo) {
      const other = KEY_COMMANDS.find((c) => c.id !== id && bindingOf(c.id, overrides) === combo);
      if (other) {
        overrides[other.id] = null;
        displaced = other.label;
      }
    }
    if (combo === (BY_ID.get(id)?.key ?? null)) delete overrides[id];
    else overrides[id] = combo;
    set({ overrides });
    await save(overrides);
    return displaced;
  },

  async reset(id) {
    const overrides = { ...get().overrides };
    delete overrides[id];
    // Its default may be another command's now; that one gives it up.
    const key = BY_ID.get(id)?.key;
    for (const c of KEY_COMMANDS) {
      if (c.id !== id && key && bindingOf(c.id, overrides) === key) overrides[c.id] = null;
    }
    set({ overrides });
    await save(overrides);
  },

  async resetAll() {
    set({ overrides: {} });
    await save({});
  },
}));

/** A command's combination: yours if you changed it, else the default. */
export function bindingOf(
  id: string,
  overrides: Record<string, string | null> = useKeys.getState().overrides,
): string | null {
  return id in overrides ? (overrides[id] ?? null) : (BY_ID.get(id)?.key ?? null);
}

/** The command bound to a combination, if any. */
export function commandFor(combo: string): string | undefined {
  const { overrides } = useKeys.getState();
  return KEY_COMMANDS.find((c) => bindingOf(c.id, overrides) === combo)?.id;
}

/** A command's keys as shown in menus and tooltips (`⌃⌘1`), or undefined. */
export function keyLabel(id: string): string | undefined {
  const combo = bindingOf(id);
  return combo ? displayCombo(combo) : undefined;
}

/** `keyLabel`, kept up to date as bindings change. */
export function useKeyLabel(id: string): string | undefined {
  const combo = useKeys((s) => bindingOf(id, s.overrides));
  return combo ? displayCombo(combo) : undefined;
}

/** `label (⌘O)`, for tooltips. */
export function withKey(label: string, key: string | undefined): string {
  return key ? `${label} (${key})` : label;
}
