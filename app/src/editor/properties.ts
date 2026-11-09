/**
 * Editing list properties that hold people (`people:`) from the properties
 * panel: a picker of the vault's contacts adds them as links, and each one
 * has a button that takes it out. The YAML is rewritten by the backend's
 * in-place editor, so other properties and comments stay as written, and the
 * change goes through the editor, so it can be undone.
 */
import type { EditorView } from "@codemirror/view";
import { parse as parseYaml } from "yaml";
import { api } from "../api/client";
import type { Person } from "../api/generated/Person";
import { splitWikilink } from "../markdown/syntax";

/** Properties whose values are people. */
export const PEOPLE_PROPERTIES = new Set(["people"]);

/** The property's values as strings, as they're written. */
function listValues(yaml: string, key: string): string[] {
  let data: unknown;
  try {
    data = parseYaml(yaml);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object") return [];
  const value = (data as Record<string, unknown>)[key];
  if (value === null || value === undefined || value === "") return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

/** The note a value links to: `[[Jane Doe|Jane]]` → `Jane Doe`. */
function linkTarget(value: string): string {
  const wiki = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(value);
  if (wiki) return splitWikilink(wiki[1]!).target;
  const md = /^\s*\[[^\]]*\]\(([^)]+)\)\s*$/.exec(value);
  if (md) return decodeURIComponent(md[1]!);
  return value.trim();
}

/**
 * Replaces the note's text with `next`, as the smallest change, unless the
 * note changed while `next` was being worked out.
 */
function applyText(view: EditorView, before: string, next: string) {
  const doc = view.state.doc.toString();
  if (doc !== before || next === before) return;
  let start = 0;
  while (start < before.length && start < next.length && before[start] === next[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < next.length - start &&
    before[before.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  view.dispatch({
    changes: { from: start, to: before.length - end, insert: next.slice(start, next.length - end) },
    userEvent: "input.property",
  });
}

async function setValues(view: EditorView, key: string, values: string[]) {
  const before = view.state.doc.toString();
  const next = await api.setListProperty(before, key, values);
  applyText(view, before, next);
}

/** The current yaml of the note's frontmatter, read fresh from the editor. */
function currentYaml(view: EditorView): string {
  const text = view.state.doc.toString();
  const m = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(text);
  return m ? m[1]! : "";
}

/** Wires the panel's add and remove buttons. */
export function attachPropertyEditing(view: EditorView, root: HTMLElement, source: string) {
  root.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const remove = target?.closest<HTMLElement>(".property-remove");
    const add = target?.closest<HTMLElement>(".property-add");
    if (!remove && !add) return;
    e.preventDefault();
    e.stopPropagation();
    if (remove) {
      const key = remove.closest(".property")?.querySelector(".property-key")?.textContent ?? "";
      const index = Number(remove.dataset.index);
      const values = listValues(currentYaml(view), key);
      if (!key || !(index in values)) return;
      void setValues(
        view,
        key,
        values.filter((_, i) => i !== index),
      );
    } else if (add?.dataset.key) {
      openPeoplePicker(view, add, add.dataset.key, source);
    }
  });
}

let closeOpenPicker: (() => void) | null = null;

/** A searchable list of contacts under `anchor`; picking one adds them. */
export function openPeoplePicker(
  view: EditorView,
  anchor: HTMLElement,
  key: string,
  source: string,
) {
  closeOpenPicker?.();

  const menu = document.createElement("div");
  menu.className = "menu people-picker";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Add a person");
  const input = document.createElement("input");
  input.className = "people-picker-input";
  input.placeholder = "Find a contact…";
  input.setAttribute("aria-label", "Find a contact");
  const list = document.createElement("div");
  list.className = "people-picker-list";
  list.setAttribute("role", "listbox");
  menu.append(input, list);
  document.body.append(menu);

  const rect = anchor.getBoundingClientRect();
  const width = 280;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.width = `${width}px`;

  let people: Person[] = [];
  let taken = new Set<string>();
  let shown: Person[] = [];
  let active = 0;
  let busy = false;
  let loaded = false;

  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", onOutside, true);
    if (closeOpenPicker === close) closeOpenPicker = null;
  };
  const onOutside = (e: MouseEvent) => {
    if (!(e.target instanceof Node) || !menu.contains(e.target)) close();
  };
  document.addEventListener("mousedown", onOutside, true);
  closeOpenPicker = close;

  /** Paths of the people the property already links to. */
  const refreshTaken = async () => {
    const targets = listValues(currentYaml(view), key).map(linkTarget);
    const paths = targets.length ? await api.resolveLinks(source, targets) : [];
    taken = new Set(paths.filter((p): p is string => !!p));
  };

  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = people.filter(
      (p) =>
        !taken.has(p.path) &&
        (!q ||
          p.name.toLowerCase().includes(q) ||
          p.role?.toLowerCase().includes(q) ||
          p.company?.toLowerCase().includes(q)),
    );
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren();
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "people-picker-empty";
      empty.textContent = !loaded
        ? "Loading…"
        : people.length
          ? "No more contacts match"
          : "No contacts yet. People are notes in Contacts/ or with type: person.";
      list.append(empty);
      return;
    }
    shown.forEach((person, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "people-picker-item";
      item.setAttribute("role", "option");
      if (i === active) item.setAttribute("aria-selected", "true");
      const name = document.createElement("span");
      name.className = "people-picker-name";
      name.textContent = person.name;
      item.append(name);
      const detail = [person.role, person.company].filter(Boolean).join(" · ");
      if (detail) {
        const d = document.createElement("span");
        d.className = "people-picker-detail";
        d.textContent = detail;
        item.append(d);
      }
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => void pick(person));
      item.addEventListener("mousemove", () => {
        if (active !== i) {
          active = i;
          render();
        }
      });
      list.append(item);
    });
    list.querySelector("[aria-selected]")?.scrollIntoView({ block: "nearest" });
  };

  const pick = async (person: Person) => {
    if (busy) return;
    busy = true;
    try {
      const link = await api.formatLink(source, person.path);
      const values = listValues(currentYaml(view), key);
      await setValues(view, key, [...values, link]);
      taken.add(person.path);
      input.value = "";
      render();
      input.focus();
    } finally {
      busy = false;
    }
  };

  input.addEventListener("input", () => {
    active = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      view.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const person = shown[active];
      if (person) void pick(person);
    }
  });

  input.focus();
  render();
  void Promise.all([api.people(), refreshTaken()])
    .then(([all]) => {
      people = all;
      loaded = true;
      render();
    })
    .catch(() => {});
}
