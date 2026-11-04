/**
 * Markdown → HTML for the reading view and live-preview widgets, with
 * Obsidian's extensions. Output is sanitized; links, embeds, images and
 * diagrams are left as placeholders that `hydrate.ts` fills in.
 */
import katexModule from "@vscode/markdown-it-katex";
import DOMPurify from "dompurify";
import markdownIt, {
  type MarkdownIt,
  type StateBlock,
  type StateCore,
  type StateInline,
  type Token,
} from "markdown-it";
import footnote from "markdown-it-footnote";
import { hasMeta, parseTaskMeta, taskMetaHtml } from "./tasks";
import {
  calloutGroup,
  escapeHtml,
  hasScheme,
  joinTarget,
  splitWikilink,
  type WikiTarget,
  wikiDisplay,
} from "./syntax";

// The package is CommonJS with `exports.default`; bundlers disagree on what a
// default import of it yields.
const katex = ((katexModule as unknown as { default?: typeof katexModule }).default ??
  katexModule) as typeof katexModule;

export interface RenderEnv {
  /** Lines before the rendered text in its file (frontmatter), for task line numbers. */
  lineOffset: number;
}

function wikilinks(md: MarkdownIt) {
  md.inline.ruler.before("link", "wikilink", (state: StateInline, silent: boolean) => {
    const src = state.src;
    let pos = state.pos;
    let embed = false;
    if (src.charCodeAt(pos) === 0x21 /* ! */) {
      embed = true;
      pos++;
    }
    if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
    const end = src.indexOf("]]", pos + 2);
    if (end < 0) return false;
    const inner = src.slice(pos + 2, end);
    if (!inner || /[\n[\]]/.test(inner)) return false;
    if (!silent) {
      const token = state.push(embed ? "wiki_embed" : "wiki_link", "", 0);
      token.meta = { ...splitWikilink(inner) };
      token.content = inner;
    }
    state.pos = end + 2;
    return true;
  });

  md.renderer.rules.wiki_link = (tokens, idx) => {
    const meta = tokens[idx]!.meta as unknown as WikiTarget;
    return `<a class="internal-link" href="#" data-href="${escapeHtml(joinTarget(meta))}">${escapeHtml(wikiDisplay(meta))}</a>`;
  };
  md.renderer.rules.wiki_embed = (tokens, idx) => {
    const meta = tokens[idx]!.meta as unknown as WikiTarget;
    return `<span class="embed" data-embed="${escapeHtml(joinTarget(meta))}" data-alias="${escapeHtml(meta.alias ?? "")}"></span>`;
  };
}

/** Marks Markdown links to vault files as internal and defers relative images. */
function vaultLinks(md: MarkdownIt) {
  md.core.ruler.push("vault_links", (state: StateCore) => {
    for (const block of state.tokens) {
      for (const token of block.children ?? []) {
        if (token.type === "link_open") {
          const href = String(token.attrGet("href") ?? "");
          if (hasScheme(href)) {
            token.attrJoin("class", "external-link");
            token.attrSet("target", "_blank");
            token.attrSet("rel", "noopener noreferrer");
          } else {
            token.attrJoin("class", "internal-link");
            token.attrSet("data-href", safeDecode(href));
            token.attrSet("href", "#");
          }
        } else if (token.type === "image") {
          const src = String(token.attrGet("src") ?? "");
          if (!hasScheme(src)) {
            token.attrSet("data-src-link", safeDecode(src));
            token.attrSet("src", "");
          }
        }
      }
    }
  });
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function tags(md: MarkdownIt) {
  md.inline.ruler.after("wikilink", "tag", (state: StateInline, silent: boolean) => {
    if (state.src.charCodeAt(state.pos) !== 0x23 /* # */) return false;
    const prev = state.pos > 0 ? state.src[state.pos - 1]! : " ";
    if (!/\s/.test(prev)) return false;
    const m = state.src.slice(state.pos).match(/^#([\p{L}\p{N}_/-]+)/u);
    if (!m || /^\d+$/.test(m[1]!)) return false;
    if (!silent) {
      const token = state.push("tag", "", 0);
      token.content = m[1]!;
    }
    state.pos += m[0].length;
    return true;
  });
  md.renderer.rules.tag = (tokens, idx) => {
    const tag = escapeHtml(tokens[idx]!.content);
    return `<a class="tag" href="#" data-tag="${tag}">#${tag}</a>`;
  };
}

/** `==highlight==` */
function highlights(md: MarkdownIt) {
  md.inline.ruler.before("emphasis", "highlight", (state: StateInline, silent: boolean) => {
    const start = state.pos;
    if (state.src.slice(start, start + 2) !== "==") return false;
    const end = state.src.indexOf("==", start + 2);
    if (end < 0 || end === start + 2) return false;
    const inner = state.src.slice(start + 2, end);
    if (/^\s|\s$/.test(inner)) return false;
    if (!silent) {
      const oldMax = state.posMax;
      state.push("mark_open", "mark", 1);
      state.pos = start + 2;
      state.posMax = end;
      state.md.inline.tokenize(state);
      state.posMax = oldMax;
      state.push("mark_close", "mark", -1);
    }
    state.pos = end + 2;
    return true;
  });
}

/** `%% comments %%`, inline or spanning lines, render as nothing. */
function comments(md: MarkdownIt) {
  md.inline.ruler.before("emphasis", "comment", (state: StateInline, silent: boolean) => {
    if (state.src.slice(state.pos, state.pos + 2) !== "%%") return false;
    const end = state.src.indexOf("%%", state.pos + 2);
    state.pos = end < 0 ? state.posMax : end + 2;
    void silent;
    return true;
  });
  md.block.ruler.before(
    "paragraph",
    "comment_block",
    (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
      const lineText = (line: number) =>
        state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]!);
      const first = lineText(startLine);
      if (!first.startsWith("%%")) return false;
      let line = startLine;
      if (!first.slice(2).includes("%%")) {
        line = startLine + 1;
        while (line < endLine && !lineText(line).includes("%%")) line++;
      }
      if (silent) return true;
      state.line = Math.min(line + 1, endLine);
      return true;
    },
  );
}

/** Strips trailing `^block-id`s from text and tags the block for scrolling. */
function blockIds(md: MarkdownIt) {
  md.core.ruler.push("block_ids", (state: StateCore) => {
    state.tokens.forEach((token, i) => {
      if (token.type !== "inline" || !token.children?.length) return;
      const last = token.children[token.children.length - 1]!;
      if (last.type !== "text") return;
      const m = last.content.match(/(^|\s)\^([A-Za-z0-9-]+)\s*$/);
      if (!m) return;
      last.content = last.content.slice(0, m.index).trimEnd();
      state.tokens[i - 1]?.attrSet("data-block-id", m[2]!);
    });
  });
}

/** `- [ ] task` → checkbox with its file line number. Hides ➕/✅/❌ stamps. */
function tasks(md: MarkdownIt) {
  md.core.ruler.push("tasks", (state: StateCore) => {
    const env = state.env as Partial<RenderEnv>;
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i]!;
      const item = tokens[i - 2]!;
      if (inline.type !== "inline" || item.type !== "list_item_open") continue;
      const first = inline.children?.[0];
      const m = first?.type === "text" ? first.content.match(/^\[(.)\]\s?/) : null;
      if (!first || !m || !item.map) continue;
      const status = m[1]!;
      first.content = first.content.slice(m[0].length);
      const line = item.map[0] + (env.lineOffset ?? 0);
      const checkbox = new state.Token("html_inline", "", 0);
      const checked = status === "x" || status === "X";
      checkbox.content = `<input type="checkbox" class="task-checkbox" data-line="${line}"${checked ? " checked" : ""}>`;
      inline.children!.unshift(checkbox);
      // Priority and dates move from the line itself to a line underneath.
      const { meta } = parseTaskMeta(inline.content);
      for (const child of inline.children!) {
        if (child.type === "text") {
          const { ranges } = parseTaskMeta(child.content);
          for (const r of ranges.reverse()) {
            child.content = child.content.slice(0, r.from) + child.content.slice(r.to);
          }
        }
      }
      if (hasMeta(meta)) {
        const line = new state.Token("html_inline", "", 0);
        line.content = taskMetaHtml(meta, status === " " || status === "/");
        inline.children!.push(line);
      }
      item.attrJoin("class", "task-list-item");
      item.attrSet("data-task", status);
    }
  });
}

/** `> [!type]± Title` blockquotes become callouts. */
function callouts(md: MarkdownIt) {
  md.core.ruler.push("callouts", (state: StateCore) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]!.type !== "blockquote_open") continue;
      const inline = tokens[i + 2];
      if (tokens[i + 1]?.type !== "paragraph_open" || inline?.type !== "inline") continue;
      const m = inline.content.match(/^\[!([\w-]+)\]([+-]?)[ \t]*(.*)/);
      if (!m) continue;

      const [, type, fold, rawTitle] = m as unknown as [string, string, string, string];
      const title = rawTitle.trim() || type.charAt(0).toUpperCase() + type.slice(1);
      const open = tokens[i]!;
      const close = matchingClose(tokens, i);
      open.type = "callout_open";
      open.meta = { type: type.toLowerCase(), fold, title };
      if (close) close.type = "callout_close";
      if (close) close.meta = open.meta;

      // Drop the `[!type] Title` line from the first paragraph.
      const children = inline.children ?? [];
      const brk = children.findIndex((t) => t.type === "softbreak" || t.type === "hardbreak");
      if (brk < 0) {
        inline.children = [];
        tokens[i + 1]!.hidden = true;
        tokens[i + 3]!.hidden = true;
      } else {
        inline.children = children.slice(brk + 1);
      }
    }
  });

  md.renderer.rules.callout_open = (tokens, idx) => {
    const { type, fold, title } = tokens[idx]!.meta as unknown as {
      type: string;
      fold: string;
      title: string;
    };
    const attrs = `class="callout" data-callout="${escapeHtml(type)}" data-callout-group="${calloutGroup(type)}"`;
    const titleHtml = md.renderInline(title);
    if (fold) {
      return `<details ${attrs}${fold === "-" ? "" : " open"}><summary class="callout-title">${titleHtml}</summary><div class="callout-content">`;
    }
    return `<div ${attrs}><div class="callout-title">${titleHtml}</div><div class="callout-content">`;
  };
  md.renderer.rules.callout_close = (tokens, idx) => {
    const { fold } = tokens[idx]!.meta as unknown as { fold: string };
    return fold ? "</div></details>" : "</div></div>";
  };
}

function matchingClose(tokens: Token[], openIndex: number): Token | undefined {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "blockquote_open" || t.type === "callout_open") depth++;
    if (t.type === "blockquote_close" || t.type === "callout_close") {
      depth--;
      if (depth === 0) return t;
    }
  }
  return undefined;
}

/** Headings carry their text for `#Heading` scrolling; mermaid and todos fences become placeholders. */
function headingsAndFences(md: MarkdownIt) {
  md.core.ruler.push("heading_ids", (state: StateCore) => {
    state.tokens.forEach((token, i) => {
      if (token.type === "heading_open") {
        token.attrSet("data-heading", state.tokens[i + 1]?.content ?? "");
      }
    });
  });
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    if (token.info.trim() === "mermaid") {
      // Encoded: DOMPurify drops attributes containing `-->`, which every diagram has.
      return `<div class="mermaid-block" data-source="${encodeURIComponent(token.content)}"></div>`;
    }
    if (token.info.trim() === "todos") {
      return `<div class="todos-block" data-source="${encodeURIComponent(token.content)}"></div>`;
    }
    return fence(tokens, idx, options, env, self);
  };
}

let renderer: MarkdownIt | null = null;

export function markdown(): MarkdownIt {
  if (renderer) return renderer;
  renderer = new markdownIt({ html: true, linkify: true, breaks: false })
    .use(wikilinks)
    .use(tags)
    .use(highlights)
    .use(comments)
    .use(blockIds)
    .use(tasks)
    .use(callouts)
    .use(headingsAndFences)
    .use(vaultLinks)
    .use(footnote)
    .use(katex, { enableFencedBlocks: true });
  return renderer;
}

const PURIFY_CONFIG = {
  ADD_TAGS: ["details", "summary"],
  ADD_ATTR: ["target", "checked"],
};

/** Renders one line of inline Markdown (e.g. a property value) to sanitized HTML. */
export function renderInline(text: string): string {
  if (!DOMPurify.isSupported) return escapeHtml(text);
  return DOMPurify.sanitize(markdown().renderInline(text), PURIFY_CONFIG);
}

/** Renders a note body (frontmatter already removed) to sanitized HTML. */
export function renderMarkdown(body: string, env: RenderEnv = { lineOffset: 0 }): string {
  const html = markdown().render(body, { ...env });
  // Never hand unsanitized HTML to the DOM.
  if (!DOMPurify.isSupported) return `<pre>${escapeHtml(body)}</pre>`;
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}
