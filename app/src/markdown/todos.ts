/**
 * Live todo lists: the `todos` code block (a daily note's day view, or a
 * filtered list) and the Todos sidebar view. Each todo stays in the note it
 * was written in; ticking, rescheduling or cancelling one here edits that
 * line through the backend.
 */
import type { EditorView } from "@codemirror/view";
import { api } from "../api/client";
import type { Todo } from "../api/generated/Todo";
import type { TodoFilter } from "../api/generated/TodoFilter";
import { todoField } from "../editor/todoField";
import { confirmDialog, promptDialog, useUi } from "../state/ui";
import { message, onVaultChange } from "../state/vault";
import { isoDate, parseNatural } from "./dates";
import { hydrate } from "./hydrate";
import { renderInline } from "./render";
import { escapeHtml } from "./syntax";
import { hasMeta, parseTaskMeta, type TaskMeta, taskMetaHtml } from "./tasks";

/** Fired on a live block after it re-renders, so editors can re-measure. */
export const CONTENT_RESIZED = "groundwork:content-resized";

export type TodosSpec =
  | { kind: "day" }
  | { kind: "agenda"; filter: TodoFilter }
  | { kind: "list"; filter: TodoFilter; title?: string };

/**
 * Reads a `todos` block. `day` shows the note's day; otherwise each line is
 * a `key: value` filter (`tag`, `path`, `due`, `status`, `priority`, `text`,
 * `title`), and a first line of `agenda` groups the results by date.
 */
export function parseTodosSpec(source: string): TodosSpec {
  const lines = source
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines[0]?.toLowerCase() === "day") return { kind: "day" };
  const agenda = lines[0]?.toLowerCase() === "agenda";
  const filter: TodoFilter = { tags: [] };
  let title: string | undefined;
  for (const line of agenda ? lines.slice(1) : lines) {
    const m = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m as unknown as [string, string, string];
    switch (key.toLowerCase()) {
      case "tag":
      case "tags":
        filter.tags.push(...value.split(/[\s,]+/).filter(Boolean));
        break;
      case "path":
      case "project":
        filter.path = value;
        break;
      case "due":
        if (["overdue", "today", "week", "any", "none"].includes(value)) {
          filter.due = value as TodoFilter["due"];
        }
        break;
      case "status":
        if (["open", "done", "cancelled", "all"].includes(value)) {
          filter.status = value as TodoFilter["status"];
        }
        break;
      case "priority": {
        // `p1` means p1 or higher (p0).
        const p = value.match(/^p?([0-5])$/i);
        if (p) filter.maxPriority = Number(p[1]);
        break;
      }
      case "text":
        filter.text = value;
        break;
      case "title":
        title = value;
        break;
    }
  }
  return agenda ? { kind: "agenda", filter } : { kind: "list", filter, title };
}

/** `Mon, Nov 2`-style short date. */
function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function daysBetween(from: string, to: string): number {
  const at = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
    return new Date(y, m - 1, d).getTime();
  };
  return Math.round((at(to) - at(from)) / 86_400_000);
}

function metaOf(todo: Todo): TaskMeta {
  return {
    priority: todo.priority === 3 ? undefined : todo.priority,
    due: todo.due,
    scheduled: todo.scheduled,
    created: todo.created,
    done: todo.done,
    cancelled: todo.cancelled,
  };
}

function noteTitle(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

const ICON_CALENDAR = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`;
const ICON_X = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

interface Section {
  id: string;
  title: string;
  todos: Todo[];
  /** Extra text after the source, per todo (e.g. "5d"). */
  note?: (todo: Todo) => string | null;
}

function itemHtml(todo: Todo, section: Section): string {
  const open = todo.status === "todo" || todo.status === "other";
  const checked = todo.status === "done";
  const source = todo.daily ? shortDate(todo.daily) : noteTitle(todo.path);
  const extra = section.note?.(todo);
  const origin = `<a class="internal-link todo-source" href="#" data-href="${escapeHtml(todo.path)}" data-resolved="${escapeHtml(todo.path)}" data-line="${todo.line}">${todo.daily ? "from " : ""}${escapeHtml(source)}</a>${extra ? ` · ${escapeHtml(extra)}` : ""}`;
  return `<li class="todo-item${open ? "" : " is-closed"}" data-id="${escapeHtml(todo.id)}" data-status="${todo.status}">
  <input type="checkbox" class="todo-checkbox" aria-label="Done: ${escapeHtml(todo.text)}"${checked ? " checked" : ""}${todo.status === "cancelled" ? " disabled" : ""}>
  <div class="todo-body">
    <span class="todo-text">${renderInline(todo.text)}</span>
    <span class="todo-details">${hasMeta(metaOf(todo)) ? taskMetaHtml(metaOf(todo), open) : ""}<span class="todo-origin">${origin}</span></span>
  </div>
  <span class="todo-actions">
    <button type="button" class="icon" data-action="reschedule" title="Reschedule" aria-label="Reschedule">${ICON_CALENDAR}</button>
    <button type="button" class="icon" data-action="cancel" title="Cancel" aria-label="Cancel">${ICON_X}</button>
  </span>
</li>`;
}

function sectionsHtml(sections: Section[], empty: string): string {
  const shown = sections.filter((s) => s.todos.length);
  if (!shown.length) return `<p class="todos-empty muted">${escapeHtml(empty)}</p>`;
  return shown
    .map(
      (s) => `<section class="todos-section" data-section="${s.id}">
  <h4>${escapeHtml(s.title)} <span class="todos-count">${s.todos.length}</span></h4>
  <ul>${s.todos.map((t) => itemHtml(t, s)).join("")}</ul>
</section>`,
    )
    .join("");
}

/** Groups open todos by when they're due, relative to today. */
function agendaSections(todos: Todo[]): Section[] {
  const today = isoDate(new Date());
  const week = isoDate(new Date(Date.now() + 7 * 86_400_000));
  const sections: Section[] = [
    { id: "overdue", title: "Overdue", todos: [] },
    { id: "today", title: "Today", todos: [] },
    { id: "upcoming", title: "Next 7 days", todos: [] },
    { id: "later", title: "Later", todos: [] },
    { id: "undated", title: "No date", todos: [] },
  ];
  const [overdue, due, upcoming, later, undated] = sections as [
    Section,
    Section,
    Section,
    Section,
    Section,
  ];
  for (const t of todos) {
    if (!t.due) undated.todos.push(t);
    else if (t.due < today) overdue.todos.push(t);
    else if (t.due === today) due.todos.push(t);
    else if (t.due <= week) upcoming.todos.push(t);
    else later.todos.push(t);
  }
  return sections;
}

/** Splits `@date` and `!p1` (or `@p1`) out of a typed todo. */
export function parseTodoInput(input: string): { text: string; due?: string; priority?: number } {
  // Markers the completions inserted (`📅 2026-11-06`, `⏫`)…
  const { meta, ranges } = parseTaskMeta(input);
  let text = input;
  for (const r of [...ranges].reverse()) text = text.slice(0, r.from) + text.slice(r.to);
  let due = meta.due;
  let priority = meta.priority;
  // …and `@date` / `!p1` typed without picking a suggestion.
  // Two-word dates first (`@nov 12`), then one word.
  for (const re of [/(^|\s)@(\w+ \d{1,2})(?=\s|$)/, /(^|\s)@(\S+)/]) {
    const m = text.match(re);
    const date = m && parseNatural(m[2]!);
    if (m && date) {
      due = date;
      text = text.slice(0, m.index!) + text.slice(m.index! + m[0].length);
      break;
    }
  }
  const p = text.match(/(^|\s)[!@]p([0-5])(?=\s|$)/i);
  if (p) {
    priority = Number(p[2]);
    text = text.slice(0, p.index!) + text.slice(p.index! + p[0].length);
  }
  return { text: text.replace(/\s+/g, " ").trim(), due, priority };
}

async function update(id: string, change: Parameters<typeof api.updateTodo>[1]) {
  try {
    await api.updateTodo(id, change);
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

async function reschedule(todo: Todo) {
  const value = await promptDialog({
    title: "Reschedule",
    value: todo.due ?? "",
    confirmLabel: "Save",
  });
  if (value === null) return;
  if (!value.trim()) return update(todo.id, { kind: "due", date: null });
  const date = parseNatural(value);
  if (!date) {
    useUi.getState().notify(`“${value}” isn’t a date. Try fri, tomorrow, +3d or nov 12.`);
    return;
  }
  return update(todo.id, { kind: "due", date });
}

/**
 * Renders a todo list into `el` and keeps it current as the vault changes.
 * `notePath` is the note holding the block (for day views and adding).
 * Returns a function that stops updating.
 */
export function mountTodos(el: HTMLElement, spec: TodosSpec, notePath: string): () => void {
  el.classList.add("todos-view");
  // The list re-renders; the add field (day views) stays, keeping what's typed.
  const list = document.createElement("div");
  el.replaceChildren(list);
  let field: EditorView | null = null;
  if (spec.kind === "day") {
    const form = document.createElement("div");
    form.className = "todo-add";
    el.append(form);
    field = todoField(form, {
      label: "Add a todo",
      placeholder: "Add a todo…  @date  !priority",
      onSubmit: (input) => {
        const { text, due, priority } = parseTodoInput(input);
        if (!text) return;
        api
          .addTodo({ path: notePath, text, due: due ?? date ?? undefined, priority })
          .catch((err) => useUi.getState().notify(message(err)));
      },
    });
  }
  let todosById = new Map<string, Todo>();
  let date: string | null = null;
  let generation = 0;

  const render = async () => {
    const mine = ++generation;
    let html: string;
    let all: Todo[];
    try {
      if (spec.kind === "day") {
        const day = await api.todoDay(notePath);
        date = day.date;
        all = [...day.overdue, ...day.due, ...day.carried, ...day.done];
        html = sectionsHtml(
          [
            { id: "overdue", title: "Overdue", todos: day.overdue },
            { id: "due", title: "Due", todos: day.due },
            {
              id: "carried",
              title: "Carried over",
              todos: day.carried,
              note: (t) => (t.daily ? `${daysBetween(t.daily, day.date)}d` : null),
            },
            { id: "done", title: "Done", todos: day.done },
          ],
          "Nothing due, overdue or carried over.",
        );
      } else {
        all = await api.todos(spec.filter);
        const sections =
          spec.kind === "agenda"
            ? agendaSections(all)
            : [{ id: "list", title: spec.title ?? "Todos", todos: all }];
        html = sectionsHtml(sections, "No todos.");
      }
    } catch (err) {
      if (mine === generation) list.innerHTML = `<p class="error">${escapeHtml(message(err))}</p>`;
      return;
    }
    if (mine !== generation) return;
    todosById = new Map(all.map((t) => [t.id, t]));
    list.innerHTML = html;
    await hydrate(list, notePath || "");
    el.dispatchEvent(new Event(CONTENT_RESIZED, { bubbles: true }));
  };

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLElement>(".todo-item");
    const todo = item && todosById.get(item.dataset.id!);
    if (!todo) return;
    if (target.matches(".todo-checkbox")) {
      // Our own checkboxes, not the note's: don't let note handlers see this.
      e.stopPropagation();
      e.preventDefault();
      void update(todo.id, { kind: todo.status === "done" ? "reopen" : "done" });
      return;
    }
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (action === "reschedule") void reschedule(todo);
    if (action === "cancel") {
      void confirmDialog({
        title: "Cancel this todo?",
        message: todo.text,
        confirmLabel: "Cancel todo",
        danger: true,
      }).then((ok) => {
        if (ok) void update(todo.id, { kind: "cancel" });
      });
    }
  };

  // Keys typed in the add field belong to it, not to an editor around it.
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest(".todo-add")) e.stopPropagation();
  };

  el.addEventListener("click", onClick, true);
  el.addEventListener("keydown", onKey);
  const unsubscribe = onVaultChange(() => {
    if (!el.isConnected) return stop();
    void render();
  });
  function stop() {
    unsubscribe();
    el.removeEventListener("click", onClick, true);
    el.removeEventListener("keydown", onKey);
    field?.destroy();
  }
  void render();
  return stop;
}
