/**
 * Tab and Shift-Tab on a list item (PLAN §5.2): nest it under the item above,
 * or bring it back out to its parent's level, with what's under it. A
 * numbered item nested this way starts again at 1 (shown as a, b, c; a level
 * further, i, ii, iii); brought back out, it carries on its parent's
 * numbering, and the numbers after it follow. The file keeps plain Markdown
 * numbers, so it reads the same in Obsidian; the letters are only drawn
 * (`orderedLabel`).
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, StateCommand } from "@codemirror/state";

/** A list item's line: `  2. text` or `- text`. */
interface Item {
  /** Leading whitespace, as written. */
  indent: string;
  /** Its width in columns (a tab reaching the next multiple of 4). */
  cols: number;
  /** `-`, `*`, `+`, or a number's delimiter (`.` or `)`). */
  bullet?: string;
  delim?: string;
  num: number;
  /** Where the item's text starts, in columns: where children go. */
  content: number;
}

const ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))(?:([ \t]+)|$)/;

function columns(ws: string, start = 0): number {
  let col = start;
  for (const ch of ws) col = ch === "\t" ? col + 4 - (col % 4) : col + 1;
  return col;
}

function parseItem(text: string): Item | null {
  const m = ITEM.exec(text);
  if (!m) return null;
  const [, indent = "", bullet, num, delim, space = ""] = m;
  const cols = columns(indent);
  const marker = bullet ?? `${num}${delim}`;
  return {
    indent,
    cols,
    bullet,
    delim,
    num: num ? Number(num) : 0,
    // An empty item still takes one space after its marker.
    content: columns(space || " ", cols + marker.length),
  };
}

const isBlank = (text: string) => !/\S/.test(text);
const leading = (text: string) => /^[ \t]*/.exec(text)![0];

/** `text` with its number replaced (an ordered item's). */
function withNumber(text: string, num: number): string {
  return text.replace(/^([ \t]*)\d+/, `$1${num}`);
}

/** `text` with its leading whitespace replaced. */
function withIndent(text: string, indent: string): string {
  return indent + text.slice(leading(text).length);
}

/** `text` indented to `cols` columns: tabs when it used tabs, else spaces. */
function reindent(text: string, cols: number): string {
  const ws = leading(text);
  // Keep tabs when the line used them and the width allows.
  const tabs = ws.includes("\t") ? "\t".repeat(Math.floor(cols / 4)) + " ".repeat(cols % 4) : null;
  return (tabs ?? " ".repeat(cols)) + text.slice(ws.length);
}

/** Reads and rewrites lines by number, recording only the lines that change. */
class Lines {
  readonly edits = new Map<number, string>();
  constructor(private state: EditorState) {}
  get count() {
    return this.state.doc.lines;
  }
  text(n: number): string {
    return this.edits.get(n) ?? this.state.doc.line(n).text;
  }
  set(n: number, text: string) {
    this.edits.set(n, text);
  }
  /** The changes, each as small as the line's edit (so the cursor keeps its place). */
  changes() {
    return [...this.edits].flatMap(([n, next]) => {
      const line = this.state.doc.line(n);
      const old = line.text;
      if (old === next) return [];
      let start = 0;
      while (start < old.length && start < next.length && old[start] === next[start]) start++;
      let end = 0;
      while (
        end < old.length - start &&
        end < next.length - start &&
        old[old.length - 1 - end] === next[next.length - 1 - end]
      ) {
        end++;
      }
      return [
        {
          from: line.from + start,
          to: line.to - end,
          insert: next.slice(start, next.length - end),
        },
      ];
    });
  }
}

/** The last line of item `n`'s block: what's indented under it, without trailing blanks. */
function blockEnd(lines: Lines, n: number, cols: number): number {
  let last = n;
  for (let i = n + 1; i <= lines.count; i++) {
    const text = lines.text(i);
    if (isBlank(text)) continue;
    if (columns(leading(text)) <= cols) break;
    last = i;
  }
  return last;
}

/**
 * Renumbers the ordered items at `cols` from line `from` on, counting from
 * `next`, until the run ends (something less indented, or another kind of
 * item at that level). Like CodeMirror's Enter, it only renumbers a run that
 * was in sequence, starting at `was`: a list written `1. 1. 1.` stays so.
 */
function renumberRun(
  lines: Lines,
  from: number,
  cols: number,
  delim: string,
  next: number,
  was: number,
) {
  for (let i = from; i <= lines.count; i++) {
    const text = lines.text(i);
    if (isBlank(text)) continue;
    const width = columns(leading(text));
    if (width > cols) continue;
    if (width < cols) return;
    const item = parseItem(text);
    if (!item || item.delim !== delim || item.num !== was++) return;
    lines.set(i, withNumber(text, next++));
  }
}

/** The item above `n` at its own level, if any (its line). */
function previousSibling(lines: Lines, n: number, cols: number): number | null {
  for (let i = n - 1; i >= 1; i--) {
    const text = lines.text(i);
    if (isBlank(text)) continue;
    const width = columns(leading(text));
    if (width > cols) continue;
    if (width < cols) return null;
    return parseItem(text) ? i : null;
  }
  return null;
}

/** The item `n` is nested in (its line), if any. */
function parentItem(lines: Lines, n: number, cols: number): number | null {
  for (let i = n - 1; i >= 1; i--) {
    const text = lines.text(i);
    if (isBlank(text)) continue;
    const item = parseItem(text);
    if (columns(leading(text)) < cols) return item && item.content <= cols ? i : null;
  }
  return null;
}

/** The one line the selection is on, when it's a list item outside code. */
function itemLine(state: EditorState): { n: number; item: Item } | null {
  const range = state.selection.main;
  if (state.selection.ranges.length > 1) return null;
  const line = state.doc.lineAt(range.from);
  if (range.to > line.to) return null;
  const item = parseItem(line.text);
  if (!item) return null;
  for (
    let node: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(
      line.from,
      1,
    );
    node;
    node = node.parent as typeof node
  ) {
    if (/^(FencedCode|CodeBlock|Frontmatter|MathBlock)$/.test(node.name)) return null;
  }
  return { n: line.number, item };
}

/** Tab: nests the item under the one above it. */
export const indentListItem: StateCommand = ({ state, dispatch }) => {
  const at = itemLine(state);
  if (!at) return false;
  const { n, item } = at;
  const lines = new Lines(state);
  const above = previousSibling(lines, n, item.cols);
  // The first item has nothing to nest under: Tab does nothing.
  if (above == null) return true;
  const sibling = parseItem(lines.text(above))!;
  const end = blockEnd(lines, n, item.cols);
  // It joins the item above's children, if it has some; otherwise it lines
  // up with that item's text (a tab further, when the list uses tabs).
  let indent = sibling.indent.includes("\t") ? `${sibling.indent}\t` : " ".repeat(sibling.content);
  let cols = Infinity;
  for (let i = above + 1; i < n; i++) {
    const child = parseItem(lines.text(i));
    if (child && child.cols > sibling.cols && child.cols < cols) {
      cols = child.cols;
      indent = child.indent;
    }
  }
  cols = columns(indent);
  const shift = cols - item.cols;

  // The new level's numbering: after the item above's last child there, else 1.
  let num = item.num;
  if (item.delim) {
    num = 1;
    for (let i = above + 1; i < n; i++) {
      const child = parseItem(lines.text(i));
      if (child && child.cols === cols) num = child.delim === item.delim ? child.num + 1 : 1;
    }
  }
  lines.set(n, withIndent(item.delim ? withNumber(lines.text(n), num) : lines.text(n), indent));
  for (let i = n + 1; i <= end; i++) {
    const text = lines.text(i);
    if (!isBlank(text)) lines.set(i, reindent(text, columns(leading(text)) + shift));
  }
  // The items after it at its old level close the gap.
  if (item.delim && sibling.delim === item.delim) {
    renumberRun(lines, end + 1, sibling.cols, item.delim, sibling.num + 1, item.num + 1);
  }

  dispatch(
    state.update({ changes: lines.changes(), scrollIntoView: true, userEvent: "input.indent" }),
  );
  return true;
};

/** Shift-Tab: brings the item out to its parent's level, after the parent. */
export const outdentListItem: StateCommand = ({ state, dispatch }) => {
  const at = itemLine(state);
  if (!at) return false;
  const { n, item } = at;
  const lines = new Lines(state);
  const up = parentItem(lines, n, item.cols);
  // Not nested in an item: leave it to plain unindenting.
  if (up == null) return false;
  const parent = parseItem(lines.text(up))!;
  const end = blockEnd(lines, n, item.cols);
  const shift = item.cols - parent.cols;

  const num = item.delim ? (parent.delim === item.delim ? parent.num + 1 : 1) : item.num;
  lines.set(
    n,
    withIndent(item.delim ? withNumber(lines.text(n), num) : lines.text(n), parent.indent),
  );
  for (let i = n + 1; i <= end; i++) {
    const text = lines.text(i);
    if (!isBlank(text)) lines.set(i, reindent(text, Math.max(0, columns(leading(text)) - shift)));
  }
  if (item.delim) {
    // The items that followed it at its old level are now its children, from 1.
    renumberRun(lines, end + 1, item.cols, item.delim, 1, item.num + 1);
    // Its new level carries on after it.
    if (parent.delim === item.delim) {
      const after = blockEnd(lines, n, parent.cols);
      renumberRun(lines, after + 1, parent.cols, item.delim, num + 1, parent.num + 1);
    }
  }

  dispatch(
    state.update({ changes: lines.changes(), scrollIntoView: true, userEvent: "delete.dedent" }),
  );
  return true;
};

/**
 * How an ordered item's number shows at a depth (1 for a top-level list):
 * 1, 2, 3; then a, b, c; then i, ii, iii; then over again.
 */
export function orderedLabel(num: number, depth: number): string {
  switch ((depth - 1) % 3) {
    case 1:
      return alpha(num);
    case 2:
      return roman(num);
    default:
      return String(num);
  }
}

/** 1 → a, 26 → z, 27 → aa, as CSS's `lower-alpha` counts. */
function alpha(num: number): string {
  if (num < 1) return String(num);
  let out = "";
  for (let n = num; n > 0; n = Math.floor((n - 1) / 26)) {
    out = String.fromCharCode(97 + ((n - 1) % 26)) + out;
  }
  return out;
}

const ROMAN: [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

/** 4 → iv, as CSS's `lower-roman` counts (numbers past 3999 stay numbers). */
function roman(num: number): string {
  if (num < 1 || num > 3999) return String(num);
  let out = "";
  let n = num;
  for (const [value, letters] of ROMAN) {
    while (n >= value) {
      out += letters;
      n -= value;
    }
  }
  return out;
}
