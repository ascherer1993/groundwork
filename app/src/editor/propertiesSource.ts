/**
 * In live preview, a note's properties are a panel, and its YAML shows only
 * when asked for (the panel's `</>` button) or when something jumps into it
 * (a search hit). The cursor otherwise stays out of the frontmatter: clicks,
 * arrow keys and selections that would land in it land just below it, so the
 * panel never turns into text under the pointer.
 */
import {
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * A place jumped to (a search hit, a link to a line): the block holding it
 * shows its source, focused or not, until the selection next moves.
 */
export const revealAt = StateEffect.define<number>();

/** Opens (true) or closes the properties' YAML. */
export const showPropertiesSource = StateEffect.define<boolean>();

/** The end of the frontmatter's closing line, or null when there's none. */
export function frontmatterEnd(doc: Text): number | null {
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== "---") return null;
  const last = Math.min(doc.lines, 5000);
  for (let i = 2; i <= last; i++) {
    const line = doc.line(i);
    const t = line.text.trimEnd();
    if (t === "---" || t === "...") return line.to;
  }
  return null;
}

/** Whether the properties show as YAML. */
export const propertiesSource = StateField.define<boolean>({
  create: () => false,
  update(open, tr) {
    for (const e of tr.effects) if (e.is(showPropertiesSource)) return e.value;
    const end = frontmatterEnd(tr.state.doc);
    if (end === null) return false;
    if (!tr.selection) return open;
    const inside = tr.state.selection.main.head <= end;
    if (inside && (tr.isUserEvent("select.search") || tr.effects.some((e) => e.is(revealAt))))
      return true;
    return open && inside;
  },
});

/** Keeps the selection below the frontmatter while it's a panel. */
const keepBelowProperties = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection) return tr;
  if (
    tr.isUserEvent("select.search") ||
    tr.effects.some((e) => e.is(revealAt) || (e.is(showPropertiesSource) && e.value))
  )
    return tr;
  if (tr.startState.field(propertiesSource, false)) return tr;
  const doc = tr.newDoc;
  const end = frontmatterEnd(doc);
  // With nothing below it, there's nowhere else for the cursor.
  if (end === null || end >= doc.length) return tr;
  const sel = tr.newSelection;
  if (!sel.ranges.some((r) => r.anchor <= end || r.head <= end)) return tr;
  const below = end + 1;
  const ranges = sel.ranges.map((r) =>
    EditorSelection.range(Math.max(r.anchor, below), Math.max(r.head, below)),
  );
  return [tr, { selection: EditorSelection.create(ranges, sel.mainIndex), sequential: true }];
});

/** Shows the YAML, with the cursor at the end of its first property. */
export function openPropertiesSource(view: EditorView) {
  const doc = view.state.doc;
  const end = frontmatterEnd(doc);
  if (end === null) return;
  const anchor = doc.lines > 2 && doc.line(2).to < end ? doc.line(2).to : doc.line(1).to;
  view.dispatch({
    selection: { anchor },
    effects: showPropertiesSource.of(true),
    scrollIntoView: true,
  });
  view.focus();
}

export const propertiesEditing = [propertiesSource, keepBelowProperties];
