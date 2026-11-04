/**
 * Obsidian syntax for CodeMirror's Markdown parser: frontmatter, wikilinks
 * and embeds, ==highlights==, %%comments%%, #tags, $math$ and ^block-ids.
 */
import { tags as t } from "@lezer/highlight";
import type {
  BlockContext,
  InlineContext,
  LeafBlock,
  LeafBlockParser,
  Line,
  MarkdownConfig,
} from "@lezer/markdown";

const BANG = 33;
const HASH = 35;
const DOLLAR = 36;
const PERCENT = 37;
const OPEN_BRACKET = 91;
const CARET = 94;

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code < 0;
}

/** `---` YAML at the very start of the document. */
function frontmatter(cx: BlockContext, line: Line): boolean {
  if (cx.lineStart !== 0 || line.text.trimEnd() !== "---") return false;
  const start = cx.lineStart;
  while (cx.nextLine()) {
    if (/^(---|\.\.\.)\s*$/.test(line.text)) {
      const end = cx.lineStart + line.text.length;
      cx.nextLine();
      cx.addElement(cx.elt("Frontmatter", start, end));
      return true;
    }
  }
  cx.addElement(cx.elt("Frontmatter", start, cx.prevLineEnd()));
  return true;
}

/** `$$ … $$` display math spanning lines. */
function mathBlock(cx: BlockContext, line: Line): boolean {
  if (!line.text.slice(line.pos).startsWith("$$")) return false;
  const start = cx.lineStart + line.pos;
  const rest = line.text.slice(line.pos + 2);
  if (rest.trimEnd().endsWith("$$") && rest.trim().length > 2) {
    const end = cx.lineStart + line.text.length;
    cx.nextLine();
    cx.addElement(cx.elt("MathBlock", start, end));
    return true;
  }
  while (cx.nextLine()) {
    if (line.text.trimEnd().endsWith("$$")) {
      const end = cx.lineStart + line.text.length;
      cx.nextLine();
      cx.addElement(cx.elt("MathBlock", start, end));
      return true;
    }
  }
  cx.addElement(cx.elt("MathBlock", start, cx.prevLineEnd()));
  return true;
}

/**
 * Tasks with any status character (`[-]`, `[/]`, `[>]`…), as Obsidian allows.
 * GFM's parser only knows `[ ]` and `[x]`. Produces GFM's `Task` and
 * `TaskMarker` nodes, so everything downstream treats them alike.
 */
class TaskParser implements LeafBlockParser {
  nextLine() {
    return false;
  }

  finish(cx: BlockContext, leaf: LeafBlock) {
    cx.addLeafElement(
      leaf,
      cx.elt("Task", leaf.start, leaf.start + leaf.content.length, [
        cx.elt("TaskMarker", leaf.start, leaf.start + 3),
        ...cx.parser.parseInline(leaf.content.slice(3), leaf.start + 3),
      ]),
    );
    return true;
  }
}

function wikilink(cx: InlineContext, next: number, pos: number): number {
  let start = pos;
  if (next === BANG) {
    if (cx.char(pos + 1) !== OPEN_BRACKET || cx.char(pos + 2) !== OPEN_BRACKET) return -1;
    start = pos + 1;
  } else if (next !== OPEN_BRACKET || cx.char(pos + 1) !== OPEN_BRACKET) {
    return -1;
  }
  const text = cx.slice(start + 2, cx.end);
  const close = text.indexOf("]]");
  if (close <= 0) return -1;
  const inner = text.slice(0, close);
  if (/[\n[\]]/.test(inner)) return -1;
  const end = start + 2 + close + 2;
  const type = next === BANG ? "WikiEmbed" : "WikiLink";
  cx.addElement(
    cx.elt(type, pos, end, [
      cx.elt("WikiMark", pos, start + 2),
      cx.elt("WikiTarget", start + 2, end - 2),
      cx.elt("WikiMark", end - 2, end),
    ]),
  );
  return end;
}

function delimited(name: string, mark: string, open: string, close = open) {
  return (cx: InlineContext, next: number, pos: number): number => {
    if (String.fromCharCode(next) !== open[0] || cx.slice(pos, pos + open.length) !== open)
      return -1;
    const rest = cx.slice(pos + open.length, cx.end);
    const at = rest.indexOf(close);
    if (at <= 0) return -1;
    const end = pos + open.length + at + close.length;
    cx.addElement(
      cx.elt(name, pos, end, [
        cx.elt(mark, pos, pos + open.length),
        cx.elt(mark, end - close.length, end),
      ]),
    );
    return end;
  };
}

const highlight = delimited("Highlight", "HighlightMark", "==");

function comment(cx: InlineContext, next: number, pos: number): number {
  if (next !== PERCENT || cx.char(pos + 1) !== PERCENT) return -1;
  const rest = cx.slice(pos + 2, cx.end);
  const at = rest.indexOf("%%");
  const end = at < 0 ? cx.end : pos + 2 + at + 2;
  cx.addElement(cx.elt("Comment", pos, end));
  return end;
}

function inlineMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== DOLLAR || cx.char(pos + 1) === DOLLAR) return -1;
  const rest = cx.slice(pos + 1, cx.end);
  const m = rest.match(/^([^$\s](?:[^$\n]*[^$\s])?)\$(?!\d)/);
  if (!m) return -1;
  const end = pos + 1 + m[1]!.length + 1;
  cx.addElement(
    cx.elt("InlineMath", pos, end, [
      cx.elt("MathMark", pos, pos + 1),
      cx.elt("MathMark", end - 1, end),
    ]),
  );
  return end;
}

function tag(cx: InlineContext, next: number, pos: number): number {
  if (next !== HASH || (pos > cx.offset && !isSpace(cx.char(pos - 1)))) return -1;
  const m = cx.slice(pos + 1, cx.end).match(/^[\p{L}\p{N}_/-]+/u);
  if (!m || /^\d+$/.test(m[0])) return -1;
  const end = pos + 1 + m[0].length;
  cx.addElement(cx.elt("Tag", pos, end));
  return end;
}

function blockRef(cx: InlineContext, next: number, pos: number): number {
  if (next !== CARET || !isSpace(cx.char(pos - 1))) return -1;
  const m = cx.slice(pos + 1, cx.end).match(/^[A-Za-z0-9-]+(?=\s*$)/);
  if (!m) return -1;
  const end = pos + 1 + m[0].length;
  cx.addElement(cx.elt("BlockRef", pos, end));
  return end;
}

export const obsidianSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "Frontmatter", block: true, style: t.meta },
    { name: "MathBlock", block: true, style: t.special(t.string) },
    { name: "WikiLink", style: t.link },
    { name: "WikiEmbed", style: t.link },
    { name: "WikiMark", style: t.processingInstruction },
    { name: "WikiTarget" },
    { name: "Highlight", style: t.special(t.emphasis) },
    { name: "HighlightMark", style: t.processingInstruction },
    { name: "Comment", style: t.comment },
    { name: "InlineMath", style: t.special(t.string) },
    { name: "MathMark", style: t.processingInstruction },
    { name: "Tag", style: t.labelName },
    { name: "BlockRef", style: t.annotation },
  ],
  parseBlock: [
    {
      name: "ObsidianTask",
      leaf: (cx, leaf) =>
        /^\[[^\]\n]\][ \t]/.test(leaf.content) && cx.parentType().name === "ListItem"
          ? new TaskParser()
          : null,
      before: "TaskList",
    },
    { name: "Frontmatter", parse: frontmatter, before: "HorizontalRule" },
    { name: "MathBlock", parse: mathBlock, before: "FencedCode" },
  ],
  parseInline: [
    { name: "WikiLink", parse: wikilink, before: "Link" },
    { name: "Highlight", parse: highlight, before: "Emphasis" },
    { name: "Comment", parse: comment, before: "Emphasis" },
    { name: "InlineMath", parse: inlineMath, before: "Escape" },
    { name: "Tag", parse: tag },
    { name: "BlockRef", parse: blockRef },
  ],
};
