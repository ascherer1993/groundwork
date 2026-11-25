/**
 * What the properties panel knows about properties: their types, which are
 * picked from the vault (people, projects, teams, notes, a ticket's repos),
 * and writing them back.
 *
 * Every change is made by the backend's in-place editor (`frontmatter.rs`),
 * so other properties and comments stay as written, and goes through the
 * editor, so it can be undone.
 */
import type { EditorView } from "@codemirror/view";
import { parse as parseYaml } from "yaml";
import { api } from "../api/client";
import type { PropertyValue } from "../api/generated/PropertyValue";
import { repoName } from "../state/tickets";
import { useWorkspaces } from "../state/workspaces";
import { useUi } from "../state/ui";
import { message } from "../state/vault";
import { splitFrontmatter, splitWikilink } from "../markdown/syntax";

/** How the panel edits a property's values, when they're picked rather than typed. */
export type PickKind = "people" | "projects" | "teams" | "notes" | "repos";

/** The property every note offers for linking related notes. */
export const REFERENCES = "references";

export function pickKind(key: string, data: Record<string, unknown>): PickKind | null {
  if (key === "people") return "people";
  if (key === "projects") return "projects";
  if (key === "team" || key === "teams") return "teams";
  if (key === REFERENCES) return "notes";
  // `repo:` is how tickets from before multi-repo tickets name theirs.
  if ((key === "repos" || key === "repo") && data.type === "ticket") return "repos";
  return null;
}

/** What the add field says. */
export const ADD_LABEL: Record<PickKind, string> = {
  people: "Add a person",
  projects: "Add a project",
  teams: "Add a team",
  notes: "Add a note",
  repos: "Add a repo",
};

/** A contact: `type: person` (or `contact`), or in `Contacts/`. */
export function isPerson(path: string, data: Record<string, unknown>): boolean {
  const type = String(data.type ?? "").toLowerCase();
  return type === "person" || type === "contact" || path.startsWith("Contacts/");
}

/**
 * Rows shown before a note has them, so they can be filled in without
 * typing their names: every note's references, a contact's team, a ticket's
 * projects and repos.
 */
export function missingRows(path: string, data: Record<string, unknown>): string[] {
  const rows: string[] = [];
  if (data.type === "ticket") {
    if (!("projects" in data)) rows.push("projects");
    if (!("repos" in data) && !("repo" in data) && data.status !== "closed") rows.push("repos");
  }
  if (isPerson(path, data) && !("team" in data) && !("teams" in data)) rows.push("team");
  if (!(REFERENCES in data)) rows.push(REFERENCES);
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

// Types

export type PropType = "text" | "list" | "number" | "checkbox" | "date" | "datetime" | "object";

export const TYPES: PropType[] = ["text", "list", "number", "checkbox", "date", "datetime"];

export const TYPE_LABEL: Record<PropType, string> = {
  text: "Text",
  list: "List",
  number: "Number",
  checkbox: "Checkbox",
  date: "Date",
  datetime: "Date & time",
  object: "Object",
};

/** Properties that are lists before they have values. */
const LIST_KEYS = new Set([
  "tags",
  "aliases",
  "cssclasses",
  "links",
  "people",
  "projects",
  "team",
  "teams",
  REFERENCES,
  "repos",
]);
const DATE_KEYS = new Set(["date", "due", "start", "end", "deadline", "birthday"]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** A new property's type, from its name. */
export function typeForName(key: string): PropType {
  const k = key.toLowerCase();
  if (LIST_KEYS.has(k)) return "list";
  if (DATE_KEYS.has(k)) return "date";
  return "text";
}

/**
 * Types chosen in the panel, by note and key, for this session. YAML can't
 * say that an empty value is meant to be a date, so the choice is kept here
 * as long as the value fits it.
 */
const chosen = new Map<string, PropType>();

export function chooseType(source: string, key: string, type: PropType) {
  chosen.set(`${source}\n${key}`, type);
}

function fits(type: PropType, value: unknown): boolean {
  if (value === null || value === undefined || value === "") return type !== "object";
  switch (type) {
    case "list":
      return Array.isArray(value);
    case "number":
      return typeof value === "number";
    case "checkbox":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && DATE_RE.test(value);
    case "datetime":
      return typeof value === "string" && DATETIME_RE.test(value);
    case "text":
      return typeof value === "string";
    default:
      return false;
  }
}

/** How the panel shows a property's value. */
export function typeOf(
  source: string,
  key: string,
  value: unknown,
  kind: PickKind | null,
): PropType {
  if (kind) return "list";
  const picked = chosen.get(`${source}\n${key}`);
  if (picked && fits(picked, value)) return picked;
  if (Array.isArray(value)) {
    return value.some((v) => v !== null && typeof v === "object" && !(v instanceof Date))
      ? "object"
      : "list";
  }
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (value instanceof Date) return "datetime";
  if (value !== null && typeof value === "object") return "object";
  if (typeof value === "string") {
    if (DATE_RE.test(value)) return "date";
    if (DATETIME_RE.test(value)) return "datetime";
    return "text";
  }
  if (LIST_KEYS.has(key.toLowerCase())) return "list";
  return "text";
}

/** A value as text, as it reads in the note. */
export function plain(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 16);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** `value` written as a property of `type`. */
export function convert(value: unknown, type: PropType): PropertyValue {
  const list = (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value])
    .map(plain)
    .filter((s) => s !== "");
  const text = Array.isArray(value) ? list.join(", ") : plain(value);
  switch (type) {
    case "list":
      return { kind: "list", value: list };
    case "number": {
      const n = typeof value === "number" ? value : Number.parseFloat(text);
      return Number.isFinite(n) ? { kind: "number", value: n } : { kind: "empty" };
    }
    case "checkbox":
      return { kind: "bool", value: value === true || /^(true|yes|on|1|x)$/i.test(text.trim()) };
    case "date": {
      const m = /^\d{4}-\d{2}-\d{2}/.exec(text);
      return m ? { kind: "text", value: m[0] } : { kind: "empty" };
    }
    case "datetime": {
      const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(text);
      return m ? { kind: "text", value: `${m[1]}T${m[2] ?? "00:00"}` } : { kind: "empty" };
    }
    default:
      return text ? { kind: "text", value: text } : { kind: "empty" };
  }
}

/** Whether `key` can be written as a plain YAML key. */
export function keyProblem(key: string, taken: Iterable<string>): string | null {
  if (!key) return "Give the property a name.";
  if (/[:#"'\n]/.test(key) || /^[-[\]{}?&*!|>%@`]/.test(key))
    return "Property names can't contain : # or quotes, or start with a symbol.";
  for (const k of taken) if (k === key) return `There's already a “${key}” property.`;
  return null;
}

// Reading and writing

/** The note's properties, read fresh from the editor. */
export function currentData(view: EditorView): Record<string, unknown> {
  const fm = splitFrontmatter(view.state.doc.toString());
  if (fm.yaml === null) return {};
  try {
    const data = parseYaml(fm.yaml);
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The property's values as strings, as they're written. */
export function listValues(view: EditorView, key: string): string[] {
  const value = currentData(view)[key];
  if (value === null || value === undefined || value === "") return [];
  return (Array.isArray(value) ? value : [value]).map(plain);
}

/** The note a value links to: `[[Jane Doe|Jane]]` → `Jane Doe`. */
export function linkTarget(value: string): string {
  const wiki = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(value);
  if (wiki) return splitWikilink(wiki[1]!).target;
  const md = /^\s*\[[^\]]*\]\(([^)]+)\)\s*$/.exec(value);
  if (md) {
    try {
      return decodeURIComponent(md[1]!);
    } catch {
      return md[1]!;
    }
  }
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

async function edit(view: EditorView, change: (text: string) => Promise<string>) {
  const before = view.state.doc.toString();
  try {
    applyText(view, before, await change(before));
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

export function setValues(view: EditorView, key: string, values: string[]) {
  return edit(view, (text) => api.setListProperty(text, key, values));
}

/** Sets `key` to `value`, or removes it when `value` is null. */
export function setProperty(view: EditorView, key: string, value: PropertyValue | null) {
  return edit(view, (text) => api.setProperty(text, key, value));
}

export function renameProperty(view: EditorView, from: string, to: string) {
  return edit(view, (text) => api.renameProperty(text, from, to));
}

// What pickers offer

/** Something a picked property can take. */
export interface Choice {
  name: string;
  detail?: string;
  /** The note it links to, if it has one. */
  path?: string;
  /** Lowercased text the search matches. */
  search: string;
}

export async function loadChoices(kind: Exclude<PickKind, "repos" | "notes">): Promise<Choice[]> {
  if (kind === "people") {
    return (await api.people()).map((p) => {
      const detail = [p.role, p.company].filter(Boolean).join(" · ");
      return {
        name: p.name,
        detail: detail || undefined,
        path: p.path,
        search: [p.name, p.role, p.company].filter(Boolean).join(" ").toLowerCase(),
      };
    });
  }
  if (kind === "teams") {
    return (await api.teams()).map((t) => ({
      name: t.name,
      detail: t.path.includes("/") ? t.path.slice(0, t.path.lastIndexOf("/")) : undefined,
      path: t.path,
      search: t.name.toLowerCase(),
    }));
  }
  return (await api.projects()).map((p) => ({
    name: p.name,
    detail: p.folder,
    path: p.overview ?? undefined,
    search: `${p.name} ${p.folder} ${p.id}`.toLowerCase(),
  }));
}

/** What a picker says when it has nothing to offer. */
export const NONE: Record<Exclude<PickKind, "repos" | "notes">, string> = {
  people: "No contacts yet. People are notes in Contacts/ or with type: person.",
  projects: "No projects yet. A project is any folder with a .groundwork.yml.",
  teams: "No teams yet. Type a name to make one in Teams/.",
};

/** Makes a team note in `Teams/`; returns its path. */
export async function createTeam(name: string): Promise<string> {
  const clean = name.replace(/[\\/:*?"<>|#^[\]]/g, " ").trim();
  return api.createFile(`Teams/${clean}.md`, `---\ntype: team\n---\n# ${clean}\n`);
}

/** Where the note's text starts, below its properties. */
export function bodyStart(view: EditorView): number {
  return splitFrontmatter(view.state.doc.toString()).length;
}
