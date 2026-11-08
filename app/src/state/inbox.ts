/**
 * The inbox: questions from `groundwork ask`, notes from `groundwork notify`,
 * and Claude Code waiting on you in a terminal. New items show a toast while
 * the window has focus; in the background the desktop shell sends a macOS
 * notification (src-tauri/src/notifications.rs), which can answer a question
 * itself. The dock icon counts what's open.
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
  /** Open items, oldest first. */
  items: InboxItem[];
  /** Answered and dismissed ones, most recent first (loaded when shown). */
  history: InboxItem[];
  open: boolean;
  view: "waiting" | "earlier";
  setOpen(open: boolean): void;
  setView(view: "waiting" | "earlier"): void;
  /** Reloads the open items (and the history, if it's showing). */
  load(): Promise<void>;
  answer(id: string, answer?: string): Promise<void>;
}

/** Numbers loads, so a late one is ignored. */
let loads = 0;

export const useInbox = create<InboxState>((set, get) => ({
  items: [],
  history: [],
  open: false,
  view: "waiting",

  setOpen(open) {
    set(open ? { open, view: "waiting" } : { open });
    // Whatever events were missed (say, the CLI wrote the file while the app
    // restarted), opening shows what's there.
    if (open) void get().load();
  },

  setView(view) {
    set({ view });
    void get().load();
  },

  async load() {
    const n = ++loads;
    try {
      const showHistory = get().open && get().view === "earlier";
      const [items, history] = await Promise.all([
        api.inbox(),
        showHistory ? api.inboxHistory() : Promise.resolve(get().history),
      ]);
      // An older load finishing late doesn't undo a newer one.
      if (n !== loads) return;
      set({ items, history });
      void badge(items.length);
    } catch {
      // Left as it was.
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

/**
 * A toast for a new item while the window has focus; else the shell notifies.
 * One done as it arrives (a finished request's summary) is only in passing.
 */
function announce(item: InboxItem) {
  // Attention for the terminal on screen needs no word.
  if (!document.hasFocus() || item.kind === "attention") return;
  if (item.done) {
    useUi.getState().notify(`Finished: ${item.text}`, {
      label: "Show",
      run: () => showDone(item),
    });
    return;
  }
  useUi.getState().notify(`${title(item)}: ${item.text}`, {
    label: item.kind === "ask" ? "Answer" : "Show",
    run: () => useInbox.getState().setOpen(true),
  });
}

function openItemLink(item: InboxItem): boolean {
  if (item.kind !== "notify" || !item.link) return false;
  void useWorkspace.getState().openLink("", item.link.replace(/^\[\[|\]\]$/g, ""));
  return true;
}

/** What a finished item is about: its note or tab, else the inbox's history. */
function showDone(item: InboxItem) {
  if (goToTab(item) || openItemLink(item)) return;
  useInbox.getState().setOpen(true);
  useInbox.getState().setView("earlier");
}

/** Shows what a clicked notification was about. */
async function showItem(id: string) {
  await useInbox.getState().load();
  const item = useInbox.getState().items.find((i) => i.id === id);
  if (!item) {
    // Done already: a finished request's summary, or answered elsewhere.
    const done = (await api.inboxHistory().catch(() => [])).find((i) => i.id === id);
    if (done) showDone(done);
    else useInbox.getState().setOpen(true);
    return;
  }
  if (item.kind !== "ask" && goToTab(item)) return;
  if (openItemLink(item)) return;
  useInbox.getState().setOpen(true);
}

/** Asks the shell for a sample question notification; resolves to why it can't, or null. */
export async function testNotification(): Promise<string | null> {
  if (!isTauri()) return "notifications only work in the desktop app";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("test_notification");
    return null;
  } catch (err) {
    return String(err);
  }
}

async function followNotifications() {
  const { listen } = await import("@tauri-apps/api/event");
  await listen<{ id?: string; test?: string | null }>("groundwork://notification", (e) => {
    if (e.payload.id) void showItem(e.payload.id);
    else if ("test" in e.payload)
      useUi
        .getState()
        .notify(
          e.payload.test
            ? `The notification answered "${e.payload.test}". Notifications work.`
            : "Notifications work.",
        );
  });
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
    if (added) announce(added);
  });
  window.addEventListener("focus", () => void useInbox.getState().load());
  if (isTauri()) void followNotifications();
}
