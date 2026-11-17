/**
 * Suggestions under a text field in the properties panel: notes after `[[`,
 * contacts, projects, teams, tags, property names. Arrow keys move, Enter or
 * Tab picks, Escape closes. The field keeps focus throughout.
 */
import fuzzysort from "fuzzysort";
import { api } from "../api/client";
import type { FileSummary } from "../api/generated/FileSummary";
import { useVault } from "../state/vault";

export interface Suggestion {
  label: string;
  detail?: string;
  /** Shown in italics, for "Create …" and the like. */
  action?: boolean;
  pick: () => void | Promise<void>;
}

/** What to offer for the field's text; null hides the list. */
export type SuggestSource = (
  input: HTMLInputElement | HTMLTextAreaElement,
) => Suggestion[] | null | Promise<Suggestion[] | null>;

export interface SuggestHandle {
  /** Re-reads the field and shows what matches. */
  refresh(): void;
  close(): void;
  isOpen(): boolean;
}

let closeOpen: (() => void) | null = null;

/** Closes whichever suggestion list is open. */
export function closeSuggestions() {
  closeOpen?.();
}

export function attachSuggest(
  input: HTMLInputElement | HTMLTextAreaElement,
  source: SuggestSource,
  opts: { openOnFocus?: boolean; label?: string } = {},
): SuggestHandle {
  let menu: HTMLDivElement | null = null;
  let items: Suggestion[] = [];
  let active = 0;
  let generation = 0;

  const close = () => {
    generation++;
    menu?.remove();
    menu = null;
    items = [];
    if (closeOpen === close) closeOpen = null;
  };

  const render = () => {
    if (!items.length || !input.isConnected) {
      menu?.remove();
      menu = null;
      return;
    }
    if (!menu) {
      if (closeOpen !== close) closeOpen?.();
      closeOpen = close;
      menu = document.createElement("div");
      menu.className = "menu property-suggest";
      menu.setAttribute("role", "listbox");
      if (opts.label) menu.setAttribute("aria-label", opts.label);
      menu.addEventListener("mousedown", (e) => e.preventDefault());
      document.body.append(menu);
    }
    const rect = input.getBoundingClientRect();
    const width = Math.max(240, Math.min(320, rect.width));
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    const below = window.innerHeight - rect.bottom;
    if (below < 220 && rect.top > below) {
      menu.style.top = "";
      menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    } else {
      menu.style.bottom = "";
      menu.style.top = `${rect.bottom + 4}px`;
    }
    menu.replaceChildren(
      ...items.map((item, i) => {
        const el = document.createElement("button");
        el.type = "button";
        el.tabIndex = -1;
        el.className = "property-suggest-item";
        el.setAttribute("role", "option");
        if (i === active) el.setAttribute("aria-selected", "true");
        const name = document.createElement("span");
        name.className = "property-suggest-name";
        if (item.action) name.classList.add("is-action");
        name.textContent = item.label;
        el.append(name);
        if (item.detail) {
          const d = document.createElement("span");
          d.className = "property-suggest-detail";
          d.textContent = item.detail;
          el.append(d);
        }
        el.addEventListener("mousemove", () => {
          if (active !== i) {
            active = i;
            render();
          }
        });
        el.addEventListener("click", () => choose(i));
        return el;
      }),
    );
    menu.querySelector("[aria-selected]")?.scrollIntoView({ block: "nearest" });
  };

  const choose = (i: number) => {
    const item = items[i];
    close();
    if (item) void item.pick();
  };

  const refresh = () => {
    const mine = ++generation;
    void Promise.resolve(source(input)).then((found) => {
      if (mine !== generation) return;
      items = found ?? [];
      active = 0;
      render();
    });
  };

  input.addEventListener("input", refresh);
  if (opts.openOnFocus) input.addEventListener("focus", refresh);
  input.addEventListener("blur", close);
  // Before the field's own Enter and Escape.
  input.addEventListener(
    "keydown",
    (e) => {
      if (!menu || !items.length) return;
      const ev = e as KeyboardEvent;
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        active = (active + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        render();
      } else if ((ev.key === "Enter" && !ev.isComposing) || ev.key === "Tab") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        choose(active);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        close();
      }
    },
    { capture: true },
  );

  return { refresh, close, isOpen: () => !!menu };
}

/** Lowercased text, without accents, for matching. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** The vault's notes, pages and canvases matching `query`, best first. */
export function matchFiles(query: string, exclude?: string, limit = 30): FileSummary[] {
  const files = useVault.getState().files.filter((f) => f.kind !== "asset" && f.path !== exclude);
  if (!query.trim()) return files.slice(0, limit);
  return fuzzysort
    .go(query, files, {
      keys: ["title", (f: FileSummary) => f.aliases.join(" "), "path"],
      limit,
    })
    .map((r) => r.obj);
}

/**
 * `[[` in a field: the notes matching what follows it, each replacing the
 * `[[…` (and a `]]` after the cursor) with a link to it.
 */
export function linkSuggestions(
  input: HTMLInputElement | HTMLTextAreaElement,
  source: string,
  onPicked: () => void,
): Suggestion[] | null {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const m = /\[\[([^[\]|#\n]*)$/.exec(before);
  if (!m) return null;
  const start = caret - m[0].length;
  return matchFiles(m[1]!, source).map((file) => ({
    label: file.title,
    detail: folderOf(file.path) || undefined,
    pick: async () => {
      const link = await api.formatLink(source, file.path);
      const after = input.value.slice(caret);
      const rest = after.startsWith("]]") ? after.slice(2) : after;
      input.value = input.value.slice(0, start) + link + rest;
      const at = start + link.length;
      input.setSelectionRange(at, at);
      input.focus();
      onPicked();
    },
  }));
}

export { folderOf };
