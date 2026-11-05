/**
 * Formatting commands for the note being edited: checkboxes, lists, bold…
 * They have shortcuts (`state/keys.ts`, the Editor group) and are in the
 * palette. Each works on every selection and returns whether it did anything.
 */
import { EditorSelection, type EditorState, type SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { today, toggleTaskLine } from "../markdown/syntax";

type Command = (view: EditorView) => boolean;

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TASK = /^(\s*)([-*+]|\d+[.)])\s+\[.\](?:\s|$)/;
const BULLET = /^[-*+]$/;

/**
 * Rewrites each line the selections touch. `edit` gets the line and its
 * place among them. Cursors stay with the text they were in.
 */
export function editLines(state: EditorState, edit: (text: string, n: number) => string) {
  const numbers = new Set<number>();
  for (const r of state.selection.ranges) {
    const last = state.doc.lineAt(r.to).number;
    for (let n = state.doc.lineAt(r.from).number; n <= last; n++) numbers.add(n);
  }
  const changes: { from: number; to: number; insert: string }[] = [];
  const delta = new Map<number, number>();
  [...numbers]
    .sort((a, b) => a - b)
    .forEach((number, i) => {
      const line = state.doc.line(number);
      const next = edit(line.text, i);
      if (next === line.text) return;
      changes.push({ from: line.from, to: line.to, insert: next });
      delta.set(number, next.length - line.text.length);
    });
  if (!changes.length) return null;
  const tr = state.update({ changes });
  // A selection from a line's start keeps it, so it still covers whole lines.
  const move = (pos: number, start: boolean) => {
    const line = state.doc.lineAt(pos);
    const from = tr.changes.mapPos(line.from, -1);
    if (start && pos === line.from) return from;
    const d = delta.get(line.number) ?? 0;
    return from + Math.max(0, Math.min(line.length + d, pos - line.from + d));
  };
  const ranges = state.selection.ranges.map((r) =>
    EditorSelection.range(
      move(r.anchor, !r.empty && r.anchor === r.from),
      move(r.head, !r.empty && r.head === r.from),
    ),
  );
  return { changes, selection: EditorSelection.create(ranges, state.selection.mainIndex) };
}

function lines(edit: (text: string, n: number) => string): Command {
  return (view) => {
    const spec = editLines(view.state, edit);
    if (!spec) return false;
    view.dispatch({ ...spec, userEvent: "input.format", scrollIntoView: true });
    return true;
  };
}

/** Plain text and list items become open tasks; tasks are checked or unchecked. */
export function checkboxLine(text: string, date = today()): string {
  if (TASK.test(text)) return toggleTaskLine(text, date) ?? text;
  const list = text.match(LIST);
  if (list) return `${list[1]}${list[2]} [ ] ${list[3]}`;
  const indent = text.match(/^\s*/)![0];
  return `${indent}- [ ] ${text.slice(indent.length)}`;
}

/** Adds `- `, or takes it off a bulleted line; numbered lines become bulleted. */
export function bulletLine(text: string): string {
  const list = text.match(LIST);
  if (list && BULLET.test(list[2]!)) return `${list[1]}${list[3]}`;
  if (list) return `${list[1]}- ${list[3]}`;
  const indent = text.match(/^\s*/)![0];
  return `${indent}- ${text.slice(indent.length)}`;
}

/** Numbers the lines from 1, or takes the numbers off numbered ones. */
export function numberedLine(text: string, n: number): string {
  const list = text.match(LIST);
  if (list && !BULLET.test(list[2]!)) return `${list[1]}${list[3]}`;
  if (list) return `${list[1]}${n + 1}. ${list[3]}`;
  const indent = text.match(/^\s*/)![0];
  return `${indent}${n + 1}. ${text.slice(indent.length)}`;
}

/** Puts `mark` around each selection, or takes it away if it's there. */
export function wrap(mark: string): Command {
  return (view) => {
    const { state } = view;
    const spec = state.changeByRange((r: SelectionRange) => {
      const text = state.sliceDoc(r.from, r.to);
      const before = state.sliceDoc(r.from - mark.length, r.from);
      const after = state.sliceDoc(r.to, r.to + mark.length);
      // Inside the marks: take them away.
      if (text.length >= 2 * mark.length && text.startsWith(mark) && text.endsWith(mark)) {
        return {
          changes: [
            { from: r.from, to: r.from + mark.length },
            { from: r.to - mark.length, to: r.to },
          ],
          range: EditorSelection.range(r.from, r.to - 2 * mark.length),
        };
      }
      if (before === mark && after === mark) {
        return {
          changes: [
            { from: r.from - mark.length, to: r.from },
            { from: r.to, to: r.to + mark.length },
          ],
          range: EditorSelection.range(r.from - mark.length, r.to - mark.length),
        };
      }
      return {
        changes: [
          { from: r.from, insert: mark },
          { from: r.to, insert: mark },
        ],
        range: EditorSelection.range(r.from + mark.length, r.to + mark.length),
      };
    });
    view.dispatch(state.update(spec, { userEvent: "input.format", scrollIntoView: true }));
    return true;
  };
}

/** `[text]()` with the cursor in the brackets or parentheses; a selected URL becomes the target. */
export const insertLink: Command = (view) => {
  const { state } = view;
  const spec = state.changeByRange((r) => {
    const text = state.sliceDoc(r.from, r.to);
    if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(text)) {
      return {
        changes: { from: r.from, to: r.to, insert: `[](${text})` },
        range: EditorSelection.cursor(r.from + 1),
      };
    }
    const insert = `[${text}]()`;
    const cursor = text ? r.from + insert.length - 1 : r.from + 1;
    return {
      changes: { from: r.from, to: r.to, insert },
      range: EditorSelection.cursor(cursor),
    };
  });
  view.dispatch(state.update(spec, { userEvent: "input.format", scrollIntoView: true }));
  return true;
};

function insertText(text: () => string): Command {
  return (view) => {
    view.dispatch(view.state.replaceSelection(text()), {
      userEvent: "input",
      scrollIntoView: true,
    });
    return true;
  };
}

function now(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** By shortcut id. */
export const EDITOR_COMMANDS: Record<string, Command> = {
  "editor-checkbox": lines((text) => checkboxLine(text)),
  "editor-bullet": lines(bulletLine),
  "editor-numbered": lines(numberedLine),
  "editor-bold": wrap("**"),
  "editor-italic": wrap("*"),
  "editor-strikethrough": wrap("~~"),
  "editor-highlight": wrap("=="),
  "editor-code": wrap("`"),
  "editor-link": insertLink,
  "editor-date": insertText(today),
  "editor-time": insertText(now),
};
