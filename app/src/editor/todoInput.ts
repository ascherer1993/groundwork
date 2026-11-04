/**
 * Typing todos: `@fri` becomes `📅 2026-11-06`, `!p1` becomes `⏫`, and a
 * task you write gets its `➕ created` stamp once you leave its line.
 */
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  pickedCompletion,
} from "@codemirror/autocomplete";
import { type EditorState, Transaction } from "@codemirror/state";
import { type EditorView, type PluginValue, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { parseNatural } from "../markdown/dates";
import { today } from "../markdown/syntax";

const TASK_LINE = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[.\]\s/;
const DUE = /\s*📅️?\s*\d{4}-\d{2}-\d{2}/u;
const PRIORITY = /\s*(?:🔺|⏫|🔼|🔽|⏬)️?/u;
const CREATED = /➕️?\s*\d{4}-\d{2}-\d{2}/u;
const BLOCK_ID = /\s\^[A-Za-z0-9-]+\s*$/;

/** p0–p5, as in PLAN §4.9. */
const PRIORITIES = [
  { marker: "🔺", label: "highest" },
  { marker: "⏫", label: "high" },
  { marker: "🔼", label: "medium" },
  { marker: "", label: "normal (no marker)" },
  { marker: "🔽", label: "low" },
  { marker: "⏬", label: "lowest" },
];

const DATE_SUGGESTIONS = [
  "today",
  "tomorrow",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "+1w",
  "+2w",
  "+1m",
];

function friendly(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Replaces `from..to` with `insert`, also removing any existing marker
 * matching `existing` elsewhere on the line, so a task keeps one due date
 * and one priority.
 */
function replaceMarker(existing: RegExp, insert: string) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const line = view.state.doc.lineAt(from);
    const changes = [{ from, to, insert }];
    const old = line.text.match(existing);
    if (old && old.index !== undefined) {
      const start = line.from + old.index;
      const end = start + old[0].length;
      if (end <= from || start >= to) changes.push({ from: start, to: end, insert: "" });
    }
    view.dispatch({
      changes,
      userEvent: "input.complete",
      annotations: pickedCompletion.of(completion),
    });
  };
}

const DUE_SECTION = { name: "Due", rank: 0 };
const PRIORITY_SECTION = { name: "Priority", rank: 1 };

function priorityOptions(typed: string): Completion[] {
  return PRIORITIES.map((p, i) => ({
    label: `p${i}`,
    detail: `${p.marker} ${p.label}`.trim(),
    apply: replaceMarker(PRIORITY, p.marker),
  })).filter((o) => o.label.startsWith(typed));
}

/**
 * `@…` offers dates and then priorities (`@p1` narrows to one); `!…` offers
 * priorities only. Outside `taskLinesOnly` (the add-a-todo field) every line
 * counts.
 */
function completions(taskLinesOnly: boolean) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    if (taskLinesOnly && !TASK_LINE.test(line.text)) return null;

    const date = ctx.matchBefore(/(?:^|\s)@[\w+-]*(?: \d{0,2})?$/);
    if (date) {
      const at = date.from + date.text.indexOf("@");
      const typed = date.text.slice(date.text.indexOf("@") + 1).toLowerCase();
      // Soonest first, one entry per day (`tomorrow` hides `wednesday`).
      const dates = new Map<string, string>();
      for (const word of [typed, ...DATE_SUGGESTIONS.filter((s) => s.startsWith(typed))]) {
        const iso = word && parseNatural(word);
        if (iso && !dates.has(iso)) dates.set(iso, word);
      }
      const options: Completion[] = [...dates]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([iso, word]) => ({
          label: `@${word}`,
          detail: friendly(iso),
          section: DUE_SECTION,
          apply: replaceMarker(DUE, `📅 ${iso}`),
        }));
      if (!typed || /^p[0-5]?$/.test(typed)) {
        options.push(
          ...priorityOptions(typed).map((o) => ({
            ...o,
            label: `@${o.label}`,
            section: PRIORITY_SECTION,
          })),
        );
      }
      return options.length ? { from: at, options, filter: false } : null;
    }

    const priority = ctx.matchBefore(/(?:^|\s)!p?[0-5]?$/i);
    if (priority) {
      const at = priority.from + priority.text.indexOf("!");
      const typed = priority.text.slice(priority.text.indexOf("!") + 1).toLowerCase();
      const options = priorityOptions(typed).map((o) => ({ ...o, label: `!${o.label}` }));
      return options.length ? { from: at, options, filter: false } : null;
    }
    return null;
  };
}

/** Completions for task lines in notes. */
export const todoCompletions = completions(true);
/** Completions for the add-a-todo field, where the text isn't a task line yet. */
export const todoFieldCompletions = completions(false);

function isTask(state: EditorState, pos: number): boolean {
  return TASK_LINE.test(state.doc.lineAt(pos).text);
}

/** The line with ` ➕ date` added before any block id. */
export function withCreatedStamp(text: string, date: string): string {
  const block = text.match(BLOCK_ID);
  const body = (block ? text.slice(0, block.index) : text).trimEnd();
  return `${body} ➕ ${date}${block ? block[0] : ""}`;
}

/**
 * Remembers task lines written in this editor and stamps each with
 * `➕ today` once the cursor leaves it (or the editor loses focus).
 */
export const createdStamps = ViewPlugin.fromClass(
  class implements PluginValue {
    /** Starts of new task lines not stamped yet. */
    pending: number[] = [];
    scheduled = false;

    constructor(readonly view: EditorView) {}

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.pending = this.pending.map((p) => update.changes.mapPos(p, -1));
        const userEdit = update.transactions.some(
          (tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"),
        );
        if (userEdit) {
          const back = update.changes.invertedDesc;
          update.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
            for (let pos = fromB; pos <= toB;) {
              const line = update.state.doc.lineAt(pos);
              const before = back.mapPos(line.from, -1);
              const wasTask =
                before <= update.startState.doc.length && isTask(update.startState, before);
              if (
                isTask(update.state, line.from) &&
                !wasTask &&
                !this.pending.includes(line.from)
              ) {
                this.pending.push(line.from);
              }
              pos = line.to + 1;
            }
          });
        }
      }
      if (
        this.pending.length &&
        (update.selectionSet || update.docChanged || update.focusChanged)
      ) {
        this.schedule();
      }
    }

    schedule() {
      if (this.scheduled) return;
      this.scheduled = true;
      // Views can't dispatch while updating.
      queueMicrotask(() => {
        this.scheduled = false;
        this.stamp();
      });
    }

    stamp() {
      const { state } = this.view;
      const cursorLine = state.doc.lineAt(state.selection.main.head).from;
      const focused = this.view.hasFocus;
      const changes: { from: number; to: number; insert: string }[] = [];
      const keep: number[] = [];
      for (const start of new Set(this.pending)) {
        if (start > state.doc.length) continue;
        const line = state.doc.lineAt(start);
        if (focused && line.from === cursorLine) {
          keep.push(line.from);
          continue;
        }
        const text = line.text.replace(TASK_LINE, "").trim();
        if (!TASK_LINE.test(line.text) || !text || CREATED.test(line.text)) continue;
        changes.push({
          from: line.from,
          to: line.to,
          insert: withCreatedStamp(line.text, today()),
        });
      }
      this.pending = keep;
      if (changes.length) {
        this.view.dispatch({
          changes,
          // Undo shouldn't stop at the stamp; it isn't something you typed.
          annotations: Transaction.addToHistory.of(false),
        });
      }
    }
  },
);
