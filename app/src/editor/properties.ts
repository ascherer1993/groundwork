/**
 * Editing list properties from the properties panel:
 * - people (`people:`) and projects (`projects:`): a picker adds them as
 *   links, and each one has a button that takes it out. The YAML is
 *   rewritten by the backend's in-place editor, so other properties and
 *   comments stay as written, and the change goes through the editor, so it
 *   can be undone.
 * - a ticket's repos (`repos:`): adding one makes its worktree and removing
 *   one takes the worktree away (PLAN §5.6), so these go through the ticket
 *   flows rather than the text.
 */
import type { EditorView } from "@codemirror/view";
import { parse as parseYaml } from "yaml";
import { api } from "../api/client";
import { addTicketRepo, removeTicketRepo, repoName } from "../state/tickets";
import { useWorkspaces } from "../state/workspaces";
import { splitWikilink } from "../markdown/syntax";

/** Properties whose values are people. */
export const PEOPLE_PROPERTIES = new Set(["people"]);
/** Properties whose values are projects. */
export const PROJECT_PROPERTIES = new Set(["projects"]);

/** How the panel edits a property's values, if it does. */
export type PickKind = "people" | "projects" | "repos";

export function pickKind(key: string, data: Record<string, unknown>): PickKind | null {
  if (PEOPLE_PROPERTIES.has(key)) return "people";
  if (PROJECT_PROPERTIES.has(key)) return "projects";
  // `repo:` is how tickets from before multi-repo tickets name theirs.
  if ((key === "repos" || key === "repo") && data.type === "ticket") return "repos";
  return null;
}

/** What the add button says. */
export const ADD_LABEL: Record<PickKind, string> = {
  people: "Add a person",
  projects: "Add a project",
  repos: "Add a repo",
};

/**
 * Rows a ticket always shows, even before it has any, so projects and repos
 * can be picked without typing their keys.
 */
export function missingTicketRows(data: Record<string, unknown>): string[] {
  if (data.type !== "ticket") return [];
  const rows: string[] = [];
  if (!("projects" in data)) rows.push("projects");
  if (!("repos" in data) && !("repo" in data) && data.status !== "closed") rows.push("repos");
  return rows;
}

/** A value as shown: a repo's name, a workspace's name instead of its id. */
export function displayValue(key: string, kind: PickKind | null, value: string): string {
  if (kind === "repos") return repoName(value);
  if (key === "workspace") {
    const ws = useWorkspaces.getState().list.find((w) => w.id === value);
    if (ws) return ws.name;
  }
  return value;
}

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
  // The buttons don't take focus: the editor would get it, with its cursor
  // in the frontmatter, and show the YAML instead of the panel.
  root.addEventListener("mousedown", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(".property-remove, .property-add")) e.preventDefault();
  });
  root.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const remove = target?.closest<HTMLElement>(".property-remove");
    const add = target?.closest<HTMLElement>(".property-add");
    if (!remove && !add) return;
    e.preventDefault();
    e.stopPropagation();
    const row = (remove ?? add)!.closest<HTMLElement>(".property");
    const key = row?.dataset.key ?? "";
    const kind = row?.dataset.kind as PickKind | undefined;
    if (!key || !kind) return;
    if (remove) {
      const index = Number(remove.dataset.index);
      const values = listValues(currentYaml(view), key);
      if (!(index in values)) return;
      if (kind === "repos") {
        void removeTicketRepo(source, values[index]!);
        return;
      }
      void setValues(
        view,
        key,
        values.filter((_, i) => i !== index),
      );
    } else if (add) {
      if (kind === "repos") void addTicketRepo(source);
      else if (kind === "projects") openProjectPicker(view, add, key, source);
      else openPeoplePicker(view, add, key, source);
    }
  });
}

let closeOpenPicker: (() => void) | null = null;

/** Something a picker offers. */
interface Choice {
  name: string;
  detail?: string;
  /** The note it links to, if it has one. */
  path?: string;
  /** Lowercased text the search matches. */
  search: string;
}

/** A searchable list of contacts under `anchor`; picking one adds them. */
export function openPeoplePicker(
  view: EditorView,
  anchor: HTMLElement,
  key: string,
  source: string,
) {
  openPicker(view, anchor, key, source, {
    label: "Add a person",
    placeholder: "Find a contact…",
    noMore: "No more contacts match",
    none: "No contacts yet. People are notes in Contacts/ or with type: person.",
    load: async () =>
      (await api.people()).map((p) => {
        const detail = [p.role, p.company].filter(Boolean).join(" · ");
        return {
          name: p.name,
          detail: detail || undefined,
          path: p.path,
          search: [p.name, p.role, p.company].filter(Boolean).join(" ").toLowerCase(),
        };
      }),
  });
}

/**
 * The vault's projects under `anchor`; picking one adds a link to its
 * overview note (or its name, when it has none). The first is the note's
 * home project.
 */
export function openProjectPicker(
  view: EditorView,
  anchor: HTMLElement,
  key: string,
  source: string,
) {
  openPicker(view, anchor, key, source, {
    label: "Add a project",
    placeholder: "Find a project…",
    noMore: "No more projects match",
    none: "No projects yet. A project is any folder with a .groundwork.yml (palette: New project…).",
    load: async () =>
      (await api.projects()).map((p) => ({
        name: p.name,
        detail: p.folder,
        path: p.overview ?? undefined,
        search: `${p.name} ${p.folder} ${p.id}`.toLowerCase(),
      })),
  });
}

function openPicker(
  view: EditorView,
  anchor: HTMLElement,
  key: string,
  source: string,
  opts: {
    label: string;
    placeholder: string;
    noMore: string;
    none: string;
    load: () => Promise<Choice[]>;
  },
) {
  closeOpenPicker?.();

  const menu = document.createElement("div");
  menu.className = "menu people-picker";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", opts.label);
  const input = document.createElement("input");
  input.className = "people-picker-input";
  input.placeholder = opts.placeholder;
  input.setAttribute("aria-label", opts.placeholder.replace(/…$/, ""));
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

  let choices: Choice[] = [];
  /** Linked notes' paths, and plain values, already in the property. */
  let taken = new Set<string>();
  let shown: Choice[] = [];
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

  const refreshTaken = async () => {
    const targets = listValues(currentYaml(view), key).map(linkTarget);
    const paths = targets.length ? await api.resolveLinks(source, targets) : [];
    taken = new Set([
      ...paths.filter((p): p is string => !!p),
      ...targets.map((t) => t.toLowerCase()),
    ]);
  };
  const isTaken = (c: Choice) =>
    (c.path !== undefined && taken.has(c.path)) || taken.has(c.name.toLowerCase());

  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = choices.filter((c) => !isTaken(c) && (!q || c.search.includes(q)));
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren();
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "people-picker-empty";
      empty.textContent = !loaded ? "Loading…" : choices.length ? opts.noMore : opts.none;
      list.append(empty);
      return;
    }
    shown.forEach((choice, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "people-picker-item";
      item.setAttribute("role", "option");
      if (i === active) item.setAttribute("aria-selected", "true");
      const name = document.createElement("span");
      name.className = "people-picker-name";
      name.textContent = choice.name;
      item.append(name);
      if (choice.detail) {
        const d = document.createElement("span");
        d.className = "people-picker-detail";
        d.textContent = choice.detail;
        item.append(d);
      }
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => void pick(choice));
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

  const pick = async (choice: Choice) => {
    if (busy) return;
    busy = true;
    try {
      const value = choice.path ? await api.formatLink(source, choice.path) : choice.name;
      const values = listValues(currentYaml(view), key);
      await setValues(view, key, [...values, value]);
      taken.add(choice.path ?? choice.name.toLowerCase());
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
      // Back to the note just below the panel; a cursor in the frontmatter
      // would show it as YAML.
      const fm = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(
        view.state.doc.toString(),
      );
      const head = view.state.selection.main.head;
      if (fm && head <= fm[0].length) view.dispatch({ selection: { anchor: fm[0].length } });
      view.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const choice = shown[active];
      if (choice) void pick(choice);
    }
  });

  input.focus();
  render();
  void Promise.all([opts.load(), refreshTaken()])
    .then(([all]) => {
      choices = all;
      loaded = true;
      render();
    })
    .catch(() => {});
}
