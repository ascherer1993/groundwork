/**
 * The inbox: questions from `groundwork ask`, notes from `groundwork notify`,
 * and Claude Code waiting on you in a terminal. New items notify you (a macOS
 * notification while the window is in the background) and the dock icon
 * counts what's open.
 */
import { create } from "zustand";
import { api, transport } from "../api/client";
import type { InboxItem } from "../api/generated/InboxItem";
import { isTauri } from "../api/transport";
import { useTerminals } from "./terminals";
import { useUi } from "./ui";
import { message } from "./vault";
import { useWorkspace } from "./workspace";

interface InboxState {
  items: InboxItem[];
  open: boolean;
  setOpen(open: boolean): void;
  load(): Promise<void>;
  answer(id: string, answer?: string): Promise<void>;
}

export const useInbox = create<InboxState>((set, get) => ({
  items: [],
  open: false,

  setOpen(open) {
    set({ open });
  },

  async load() {
    try {
      const items = await api.inbox();
      set({ items });
      void badge(items.length);
    } catch {
      // Shown as empty.
    }
  },

  async answer(id, answer) {
    // Gone at once; the reload confirms it.
    set({ items: get().items.filter((i) => i.id !== id) });
    try {
      await api.answerInbox(id, answer);
    } catch (err) {
      useUi.getState().notify(message(err));
    }
    await get().load();
  },
}));

/** Dismisses a terminal's attention items: you've seen it. */
export function seenTerminal(id: string) {
  for (const item of useInbox.getState().items) {
    if (item.kind === "attention" && item.tab === id) void useInbox.getState().answer(item.id);
  }
}

/** Shows the terminal an item came from. */
export function goToTab(item: InboxItem): boolean {
  if (!item.tab) return false;
  useInbox.getState().setOpen(false);
  return useWorkspace.getState().showTerminal(item.tab);
}

export function title(item: InboxItem): string {
  switch (item.kind) {
    case "ask":
      return "Question";
    case "notify":
      return "Note";
    case "attention":
      return "Claude is waiting";
  }
}

async function badge(count: number) {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setBadgeCount(count || undefined);
  } catch {
    // No badge.
  }
}

/** A notification for a new item; macOS's while the window is in the background. */
async function announce(item: InboxItem) {
  if (document.hasFocus()) {
    // Attention for the terminal on screen needs no word.
    if (item.kind === "attention") return;
    useUi.getState().notify(`${title(item)}: ${item.text}`, {
      label: item.kind === "ask" ? "Answer" : "Show",
      run: () => useInbox.getState().setOpen(true),
    });
    return;
  }
  if (!isTauri()) return;
  try {
    const n = await import("@tauri-apps/plugin-notification");
    let granted = await n.isPermissionGranted();
    if (!granted) granted = (await n.requestPermission()) === "granted";
    if (granted) n.sendNotification({ title: title(item), body: item.text });
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
    await getCurrentWindow().requestUserAttention(
      item.kind === "notify" ? UserAttentionType.Informational : UserAttentionType.Critical,
    );
  } catch {
    // The badge still counts it.
  }
}

let watching = false;

/** Loads the inbox and follows changes; once. */
export function watchInbox() {
  if (watching) return;
  watching = true;
  void useInbox.getState().load();
  transport.listen((event) => {
    if (event.event !== "inbox.changed") return;
    const { added } = event.payload;
    // Claude waiting in the terminal you're looking at: you've seen it.
    if (
      added?.kind === "attention" &&
      added.tab &&
      useTerminals.getState().visible[added.tab] &&
      document.hasFocus()
    ) {
      void useInbox.getState().answer(added.id);
      return;
    }
    void useInbox.getState().load();
    if (added) void announce(added);
  });
}
