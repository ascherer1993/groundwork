/**
 * Live preview: Markdown renders in place, and an element's syntax shows
 * again while the cursor is inside it.
 *
 * Inline elements come from a view plugin over the visible ranges. Blocks
 * that replace whole lines (frontmatter, callouts, tables, Mermaid, `$$`
 * math) must come from a state field, as CodeMirror requires.
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  type WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { daySpanAt, isDayBlock } from "../markdown/daySpan";
import { hasScheme, splitWikilink } from "../markdown/syntax";
import { hasMeta, parseTaskMeta, taskMetaHtml } from "../markdown/tasks";
import { notePath, refreshPreview } from "./context";
import {
  BulletWidget,
  CheckboxWidget,
  EmbedWidget,
  HrWidget,
  MarkdownBlockWidget,
  MathWidget,
  PropertiesWidget,
  TaskMetaWidget,
  WikiLinkWidget,
} from "./widgets";

const hidden = Decoration.replace({});

/** Whether the editor has focus, as state, so the block field can see it. */
const setFocused = StateEffect.define<boolean>();

const focused = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(setFocused)) value = e.value;
    return value;
  },
  provide: () => EditorView.focusChangeEffect.of((_, focusing) => setFocused.of(focusing)),
});

/**
 * A place jumped to (a search hit, a link to a line): the block holding it
 * shows its source, focused or not, until the selection next moves.
 */
export const revealAt = StateEffect.define<number>();

const revealed = StateField.define<number | null>({
  create: () => null,
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(revealAt)) return e.value;
    return tr.selection || tr.docChanged ? null : value;
  },
});

/**
 * Syntax shows only where the cursor is, and only while the editor has focus;
 * blocks also show around a place jumped to.
 */
function touches(state: EditorState, from: number, to: number): boolean {
  const at = state.field(revealed, false);
  if (at != null && at >= from && at <= to) return true;
  if (!state.field(focused, false)) return false;
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function buildInline(view: EditorView): DecorationSet {
  const { state } = view;
  const source = notePath(state);
  const active = (from: number, to: number) => touches(state, from, to);
  const decos: Range<Decoration>[] = [];
  const tree = syntaxTree(state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (ref) => {
        const node = ref.node;
        switch (ref.name) {
          // Whole blocks are the state field's job; raw code stays raw.
          case "Frontmatter":
          case "MathBlock":
          case "FencedCode":
          case "CodeBlock":
            return false;

          case "HeaderMark": {
            const heading = node.parent;
            if (!heading?.name.startsWith("ATXHeading") || active(heading.from, heading.to)) return;
            let end = ref.to;
            if (ref.from === heading.from && state.sliceDoc(end, end + 1) === " ") end++;
            if (end > ref.from) decos.push(hidden.range(ref.from, end));
            return;
          }

          case "EmphasisMark":
          case "StrikethroughMark":
          case "HighlightMark":
          case "MathMark":
          case "CodeMark": {
            const parent = node.parent;
            if (parent && parent.name !== "FencedCode" && !active(parent.from, parent.to)) {
              decos.push(hidden.range(ref.from, ref.to));
            }
            return;
          }

          case "QuoteMark": {
            const line = state.doc.lineAt(ref.from);
            if (!active(line.from, line.to)) {
              let end = ref.to;
              if (state.sliceDoc(end, end + 1) === " ") end++;
              decos.push(hidden.range(ref.from, end));
            }
            return;
          }

          case "Link": {
            if (active(ref.from, ref.to)) return false;
            const marks = node.getChildren("LinkMark");
            const url = node.getChild("URL");
            if (marks.length < 2 || !url || marks[0]!.to >= marks[1]!.from) return false;
            const href = safeDecode(state.sliceDoc(url.from, url.to));
            decos.push(hidden.range(ref.from, marks[0]!.to));
            decos.push(
              Decoration.mark({
                class: hasScheme(href) ? "cm-md-link cm-external" : "cm-md-link",
                attributes: { "data-href": href },
              }).range(marks[0]!.to, marks[1]!.from),
            );
            decos.push(hidden.range(marks[1]!.from, ref.to));
            return false;
          }

          case "Image": {
            if (active(ref.from, ref.to)) return false;
            const url = node.getChild("URL");
            if (!url) return false;
            const href = state.sliceDoc(url.from, url.to);
            const marks = node.getChildren("LinkMark");
            const alt = marks.length >= 2 ? state.sliceDoc(marks[0]!.to, marks[1]!.from) : "";
            const external = hasScheme(href);
            const widget = new EmbedWidget(
              external ? href : safeDecode(href),
              alt,
              source,
              external,
            );
            decos.push(Decoration.replace({ widget }).range(ref.from, ref.to));
            return false;
          }

          case "WikiLink":
          case "WikiEmbed": {
            if (active(ref.from, ref.to)) {
              decos.push(Decoration.mark({ class: "cm-wikilink-source" }).range(ref.from, ref.to));
              return false;
            }
            const start = ref.name === "WikiEmbed" ? ref.from + 3 : ref.from + 2;
            const link = splitWikilink(state.sliceDoc(start, ref.to - 2));
            const widget =
              ref.name === "WikiEmbed"
                ? new EmbedWidget(
                    link.subpath ? `${link.target}#${link.subpath}` : link.target,
                    link.alias,
                    source,
                  )
                : new WikiLinkWidget(link, source);
            decos.push(Decoration.replace({ widget }).range(ref.from, ref.to));
            return false;
          }

          case "Tag":
            decos.push(Decoration.mark({ class: "cm-tag" }).range(ref.from, ref.to));
            return false;

          case "Comment":
            decos.push(Decoration.mark({ class: "cm-comment" }).range(ref.from, ref.to));
            return false;

          case "BlockRef":
            if (!active(ref.from, ref.to)) {
              decos.push(Decoration.mark({ class: "cm-blockref-hidden" }).range(ref.from, ref.to));
            }
            return false;

          case "TaskMarker": {
            const line = state.doc.lineAt(ref.from);
            const status = state.sliceDoc(ref.from + 1, ref.from + 2);
            if (status !== " " && status !== "/") {
              decos.push(Decoration.mark({ class: "cm-task-closed" }).range(ref.to, line.to));
            }
            // Off the line you're editing, priority and dates move underneath.
            if (!active(line.from, line.to)) {
              const { meta, ranges } = parseTaskMeta(state.sliceDoc(ref.to, line.to));
              for (const r of ranges) decos.push(hidden.range(ref.to + r.from, ref.to + r.to));
              if (hasMeta(meta)) {
                const html = taskMetaHtml(meta, status === " " || status === "/");
                const widget = new TaskMetaWidget(html);
                decos.push(Decoration.widget({ widget, side: 1 }).range(line.to));
              }
            }
            if (active(ref.from, ref.to)) return;
            const checked = /\[[xX]\]/.test(state.sliceDoc(ref.from, ref.to));
            decos.push(
              Decoration.replace({ widget: new CheckboxWidget(checked) }).range(ref.from, ref.to),
            );
            return;
          }

          case "ListMark": {
            const item = node.parent;
            const mark = state.sliceDoc(ref.from, ref.to);
            if (!/^[-*+]$/.test(mark) || active(ref.from, ref.to + 1)) return;
            if (item?.getChild("Task")) {
              // Tasks show only their checkbox, as in Obsidian.
              decos.push(hidden.range(ref.from, Math.min(ref.to + 1, item.to)));
            } else {
              decos.push(
                Decoration.replace({ widget: new BulletWidget() }).range(ref.from, ref.to),
              );
            }
            return;
          }

          case "HorizontalRule":
            if (!active(ref.from, ref.to)) {
              decos.push(Decoration.replace({ widget: new HrWidget() }).range(ref.from, ref.to));
            }
            return false;

          case "InlineMath": {
            if (active(ref.from, ref.to)) return;
            const tex = state.sliceDoc(ref.from + 1, ref.to - 1);
            decos.push(
              Decoration.replace({ widget: new MathWidget(tex, false) }).range(ref.from, ref.to),
            );
            return false;
          }
        }
      },
    });
  }
  return Decoration.set(decos, true);
}

export const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildInline(view);
    }

    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.selectionSet ||
        u.viewportChanged ||
        u.focusChanged ||
        u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshPreview)))
      ) {
        this.decorations = buildInline(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

function lineSpan(state: EditorState, node: { from: number; to: number }) {
  return { from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.to).to };
}

function isCallout(state: EditorState, node: SyntaxNode): boolean {
  return /^\s*>\s*\[![\w-]+\]/.test(state.doc.lineAt(node.from).text);
}

function buildBlocks(state: EditorState): DecorationSet {
  const source = notePath(state);
  const decos: Range<Decoration>[] = [];
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const block = (from: number, to: number, widget: WidgetType) => {
    if (!touches(state, from, to)) {
      decos.push(Decoration.replace({ widget, block: true }).range(from, to));
    }
  };

  tree.iterate({
    enter: (ref) => {
      const node = ref.node;
      switch (ref.name) {
        case "Frontmatter": {
          const { from, to } = lineSpan(state, ref);
          const lines = state.sliceDoc(from, to).split("\n");
          const yaml = lines
            .slice(
              1,
              lines.length > 1 && /^(---|\.\.\.)\s*$/.test(lines[lines.length - 1]!)
                ? -1
                : undefined,
            )
            .join("\n");
          block(from, to, new PropertiesWidget(yaml, source));
          return false;
        }
        case "MathBlock": {
          const { from, to } = lineSpan(state, ref);
          const tex = state
            .sliceDoc(ref.from, ref.to)
            .replace(/^\s*\$\$/, "")
            .replace(/\$\$\s*$/, "");
          block(from, to, new MathWidget(tex.trim(), true));
          return false;
        }
        case "FencedCode": {
          const info = node.getChild("CodeInfo");
          const lang = info && state.sliceDoc(info.from, info.to).trim();
          if (lang === "mermaid" || lang === "todos" || lang === "tickets") {
            const { from, to } = lineSpan(state, ref);
            const text = state.sliceDoc(from, to);
            if (lang === "todos" && isDayBlock(text)) {
              // A day block takes over the todos beside it.
              const { doc } = state;
              const own = daySpanAt(
                (i) => doc.line(i + 1).text,
                doc.lines,
                doc.lineAt(from).number - 1,
                doc.lineAt(to).number - 1,
              );
              block(
                doc.line(own[0] + 1).from,
                doc.line(own[1] + 1).to,
                new MarkdownBlockWidget(text, source, 0, own),
              );
            } else {
              block(from, to, new MarkdownBlockWidget(text, source, 0));
            }
          }
          return false;
        }
        case "Blockquote": {
          if (!isCallout(state, node)) return false;
          const { from, to } = lineSpan(state, ref);
          const firstLine = state.doc.lineAt(from).number - 1;
          block(from, to, new MarkdownBlockWidget(state.sliceDoc(from, to), source, firstLine));
          return false;
        }
        case "Table": {
          const { from, to } = lineSpan(state, ref);
          block(from, to, new MarkdownBlockWidget(state.sliceDoc(from, to), source, 0));
          return false;
        }
      }
    },
  });
  return Decoration.set(decos, true);
}

const blockField = StateField.define<DecorationSet>({
  create: buildBlocks,
  update(decos, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(refreshPreview) || e.is(setFocused) || e.is(revealAt))
    ) {
      return buildBlocks(tr.state);
    }
    return decos;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Line classes for headings, code blocks, quotes and frontmatter, in every mode. */
export const structure = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }

    build(view: EditorView): DecorationSet {
      const { state } = view;
      const decos: Range<Decoration>[] = [];
      const lineClass = (pos: number, cls: string) =>
        decos.push(Decoration.line({ class: cls }).range(state.doc.lineAt(pos).from));
      const eachLine = (from: number, to: number, cls: string) => {
        for (let pos = from; pos <= to;) {
          const line = state.doc.lineAt(pos);
          lineClass(line.from, cls);
          pos = line.to + 1;
        }
      };
      for (const { from, to } of view.visibleRanges) {
        syntaxTree(state).iterate({
          from,
          to,
          enter: (ref) => {
            const m = ref.name.match(/^(?:ATX|Setext)Heading(\d)$/);
            if (m) {
              lineClass(ref.from, `cm-heading-line cm-h${m[1]}`);
              return false;
            }
            if (ref.name === "FencedCode") {
              eachLine(ref.from, ref.to, "cm-codeblock-line");
              return false;
            }
            if (ref.name === "Frontmatter") {
              eachLine(ref.from, ref.to, "cm-frontmatter-line");
              return false;
            }
            if (ref.name === "Blockquote") {
              eachLine(ref.from, ref.to, "cm-quote-line");
            }
          },
        });
      }
      return Decoration.set(decos, true);
    }
  },
  { decorations: (v) => v.decorations },
);

export const blockPreview = [focused, revealed, blockField];
