/**
 * Hanging indents for lists in live preview: when a list item's line wraps,
 * the next line starts where the item's text does, not back under its bullet,
 * number or checkbox, so items don't run into each other.
 *
 * The marks are widgets and the text font is proportional, so the indent is
 * measured rather than counted. Each list line gets `padding-left: W` and
 * `text-indent: -W`, which leaves its first line where it was; measuring again
 * finds the same W, so the measuring settles after one pass.
 */
import { syntaxTree } from "@codemirror/language";
import { type Range, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/** A line that starts a list item: its indent, mark, and task box if any. */
const ITEM_START = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+\[.\](?=[ \t]|$))?[ \t]*/;

/**
 * Where a list line's text starts, as an offset into the line: past the
 * mark (and task box) on an item's first line, past the indent on the lines
 * that carry on an item.
 */
export function listTextStart(text: string): number {
  return (ITEM_START.exec(text) ?? /^[ \t]*/.exec(text)!)[0].length;
}

/** The lines (by their start) inside list items, leaving out code and quotes. */
function listLines(view: EditorView): number[] {
  const { state } = view;
  const { from, to } = view.viewport;
  const lines = new Set<number>();
  const skip = new Set<number>();
  const each = (a: number, b: number, into: Set<number>) => {
    for (let pos = a; pos <= b;) {
      const line = state.doc.lineAt(pos);
      into.add(line.from);
      pos = line.to + 1;
    }
  };
  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      // Code blocks and quotes pad their lines already.
      if (ref.name === "FencedCode" || ref.name === "CodeBlock" || ref.name === "Blockquote") {
        each(ref.from, ref.to, skip);
        return false;
      }
      if (ref.name === "ListItem") each(ref.from, ref.to, lines);
    },
  });
  return [...lines].filter((l) => !skip.has(l) && l >= from && l <= to).sort((a, b) => a - b);
}

const hangs = StateEffect.define<DecorationSet>();

function hangDeco(width: number) {
  return Decoration.line({
    class: "cm-list-hang",
    attributes: {
      "data-hang": String(width),
      style: `padding-left: ${width}px; text-indent: ${-width}px`,
    },
  });
}

function lineElement(view: EditorView, pos: number): HTMLElement | null {
  const { node } = view.domAtPos(pos);
  const el = node instanceof HTMLElement ? node : node.parentElement;
  return el?.closest<HTMLElement>(".cm-line") ?? null;
}

/** The widths each line has now, by line start. */
function current(set: DecorationSet): Map<number, number> {
  const widths = new Map<number, number>();
  for (let it = set.iter(); it.value; it.next()) {
    widths.set(it.from, Number(it.value.spec.attributes?.["data-hang"] ?? 0));
  }
  return widths;
}

export const listWrap = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    pending = false;

    constructor(readonly view: EditorView) {
      this.measure();
    }

    update(u: ViewUpdate) {
      for (const tr of u.transactions) {
        for (const e of tr.effects) if (e.is(hangs)) this.decorations = e.value;
      }
      if (u.docChanged) this.decorations = this.decorations.map(u.changes);
      // Live preview swaps marks for their source around the cursor, which
      // moves where the text starts without changing the document.
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.geometryChanged ||
        u.selectionSet ||
        u.focusChanged
      ) {
        this.measure();
      }
    }

    measure() {
      if (this.pending) return;
      this.pending = true;
      this.view.requestMeasure({
        key: this,
        read: (view) => {
          this.pending = false;
          const out: { from: number; width: number }[] = [];
          for (const from of listLines(view)) {
            const line = view.state.doc.lineAt(from);
            const el = lineElement(view, from);
            if (!el) continue;
            const start = line.from + listTextStart(line.text);
            const at = view.coordsAtPos(start, start < line.to ? 1 : -1);
            if (!at) continue;
            const had = Number(el.dataset.hang ?? 0);
            const base =
              el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft) - had;
            const width = Math.max(0, Math.round((at.left - base) * 2) / 2);
            if (width > 0) out.push({ from, width });
          }
          return out;
        },
        write: (measured, view) => {
          const now = current(this.decorations);
          const same =
            measured.length === now.size &&
            measured.every(({ from, width }) => Math.abs((now.get(from) ?? -1) - width) < 1);
          if (same) return;
          const set = Decoration.set(
            measured.map(({ from, width }): Range<Decoration> => hangDeco(width).range(from)),
          );
          // Not while CodeMirror is still writing its own measurements, and
          // not if the text has changed since (that measures again anyway).
          const doc = view.state.doc;
          queueMicrotask(() => {
            if (view.dom.isConnected && view.state.doc === doc) {
              view.dispatch({ effects: hangs.of(set) });
            }
          });
        },
      });
    }
  },
  { decorations: (v) => v.decorations },
);
