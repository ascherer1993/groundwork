/**
 * Todo metadata in the Obsidian Tasks emoji format. In the file it stays on
 * the task's line; live preview and the reading view show it underneath.
 */
import { escapeHtml } from "./syntax";

export interface TaskMeta {
  /** `p0`–`p5` as 0–5; absent means the default, p3. */
  priority?: number;
  due?: string;
  scheduled?: string;
  start?: string;
  created?: string;
  done?: string;
  cancelled?: string;
  recurrence?: string;
}

/** Where a piece of metadata sits in the text, including its leading space. */
export interface MetaRange {
  from: number;
  to: number;
}

const DATE_FIELDS: Record<string, keyof TaskMeta> = {
  "📅": "due",
  "⏳": "scheduled",
  "🛫": "start",
  "➕": "created",
  "✅": "done",
  "❌": "cancelled",
};

/** Mirrors `parse::PRIORITY_MARKERS` in Rust; p3 has no marker. */
const PRIORITIES: Record<string, number> = { "🔺": 0, "⏫": 1, "🔼": 2, "🔽": 4, "⏬": 5 };

const META =
  /\s*(?:(📅|⏳|🛫|➕|✅|❌)️?\s*(\d{4}-\d{2}-\d{2})|(🔺|⏫|🔼|🔽|⏬)️?|🔁️?\s*([^📅⏳🛫➕✅❌🔺⏫🔼🔽⏬^]*[^\s📅⏳🛫➕✅❌🔺⏫🔼🔽⏬^]))/gu;

/** Finds the metadata in a task's text (everything after `[ ]`). */
export function parseTaskMeta(text: string): { meta: TaskMeta; ranges: MetaRange[] } {
  const meta: TaskMeta = {};
  const ranges: MetaRange[] = [];
  for (const m of text.matchAll(META)) {
    const [whole, field, date, priority, recurrence] = m;
    if (field && date) meta[DATE_FIELDS[field] as "due"] = date;
    else if (priority) meta.priority = PRIORITIES[priority];
    else if (recurrence) meta.recurrence = recurrence.trim();
    ranges.push({ from: m.index, to: m.index + whole.length });
  }
  return { meta, ranges };
}

export function hasMeta(meta: TaskMeta): boolean {
  return Object.values(meta).some((v) => v !== undefined);
}

const DAY = 86_400_000;

function parseDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/**
 * `today`, `tomorrow`, `Thu, Nov 5`, or `Nov 5, 2027` in another year.
 * Without `words`, always the date.
 */
function friendly(iso: string, today: Date, words = true): string {
  const date = parseDate(iso);
  const days = Math.round((date.getTime() - today.getTime()) / DAY);
  if (words && days === 0) return "today";
  if (words && days === 1) return "tomorrow";
  if (words && days === -1) return "yesterday";
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString("en-US", {
    weekday: sameYear && Math.abs(days) < 7 ? "short" : undefined,
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

/**
 * The line shown under a task: priority, then dates in the order they matter.
 * `open` is false for done or cancelled tasks, which never show as overdue.
 * Dates are told from `now`; with `words: false`, as dates rather than
 * "today" or "tomorrow" (for a day that isn't today).
 */
export function taskMetaHtml(
  meta: TaskMeta,
  open: boolean,
  now = new Date(),
  { words = true } = {},
): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const when = (iso: string) => friendly(iso, today, words);
  const parts: string[] = [];
  const part = (text: string, cls = "") =>
    parts.push(`<span class="task-meta-item${cls ? ` ${cls}` : ""}">${escapeHtml(text)}</span>`);

  if (meta.priority !== undefined) part(`P${meta.priority}`, `task-priority p${meta.priority}`);
  if (meta.due) {
    const days = Math.round((parseDate(meta.due).getTime() - today.getTime()) / DAY);
    const state = !open ? "" : days < 0 ? "is-overdue" : days === 0 ? "is-due-today" : "";
    part(`${open && days < 0 ? "Overdue" : "Due"} ${when(meta.due)}`, state);
  }
  if (meta.scheduled) part(`Scheduled ${when(meta.scheduled)}`);
  if (meta.start) part(`Starts ${when(meta.start)}`);
  if (meta.recurrence) part(`Repeats ${meta.recurrence}`);
  if (meta.done) part(`Done ${when(meta.done)}`);
  if (meta.cancelled) part(`Cancelled ${when(meta.cancelled)}`);
  if (meta.created) part(`Created ${when(meta.created)}`, "task-created");
  return `<span class="task-meta">${parts.join('<span class="task-meta-sep"> · </span>')}</span>`;
}
