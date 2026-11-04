import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  keymap,
  placeholder,
  rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { GFM } from "@lezer/markdown";
import { splitWikilink, splitTarget, toggleTaskLine, today } from "../markdown/syntax";
import { useUi } from "../state/ui";
import { message } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { openExternalUrl } from "../lib/fileUrl";
import { wikilinkCompletions } from "./autocomplete";
import { popupTheme } from "./popupTheme";
import { createdStamps, todoCompletions } from "./todoInput";
import { type NoteContext, noteContext, notePath } from "./context";
import { blockPreview, inlinePreview, structure } from "./livePreview";
import { obsidianSyntax } from "./syntax";

export type EditorMode = "live" | "source";

const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "650", color: "var(--text-heading)" },
  { tag: t.strong, fontWeight: "650" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--text-muted)" },
  { tag: t.link, color: "var(--link)" },
  { tag: t.url, color: "var(--text-muted)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.92em" },
  { tag: t.processingInstruction, color: "var(--text-faint)" },
  { tag: t.meta, color: "var(--text-muted)" },
  { tag: t.comment, color: "var(--text-faint)" },
  { tag: t.quote, color: "var(--text-muted)" },
  { tag: t.labelName, color: "var(--accent)" },
  { tag: t.annotation, color: "var(--text-faint)" },
  { tag: t.special(t.emphasis), backgroundColor: "var(--highlight)" },
  { tag: t.special(t.string), fontFamily: "var(--font-mono)", color: "var(--math)" },
  { tag: [t.keyword, t.operatorKeyword], color: "var(--code-keyword)" },
  { tag: [t.string, t.regexp], color: "var(--code-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--code-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--code-function)" },
  { tag: [t.typeName, t.className], color: "var(--code-type)" },
  { tag: t.lineComment, color: "var(--text-faint)", fontStyle: "italic" },
  { tag: t.blockComment, color: "var(--text-faint)", fontStyle: "italic" },
  { tag: t.propertyName, color: "var(--code-property)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-text)", lineHeight: "1.6", overflow: "auto" },
  ".cm-content": {
    // CodeMirror re-measures line heights only when the content's height
    // changes. Its default min-height (100%) hides growth in short notes, so a
    // diagram that renders late would leave clicks landing on the wrong line.
    minHeight: "0",
    maxWidth: "var(--line-width)",
    margin: "0 auto",
    padding: "8px 32px 40vh",
    caretColor: "var(--accent)",
  },
  ".cm-line": { padding: "0" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection) !important",
  },
  ".cm-panels": { backgroundColor: "var(--bg-sidebar)", color: "var(--text)" },
  ".cm-searchMatch": { backgroundColor: "var(--highlight)" },
  ".cm-placeholder": { color: "var(--text-faint)" },
});

/** Shared state between the editor and the React view hosting it. */
export interface EditorHost extends NoteContext {
  onChange: (text: string) => void;
}

function clickTarget(view: EditorView, event: MouseEvent): boolean {
  const el = event.target as HTMLElement;
  const source = notePath(view.state);
  const newTab = event.metaKey || event.ctrlKey;

  const wiki = el.closest<HTMLElement>(".cm-wikilink");
  if (wiki) {
    event.preventDefault();
    void useWorkspace.getState().openLink(source, wiki.dataset.href ?? "", {
      newTab,
      resolved: wiki.dataset.resolved,
    });
    return true;
  }

  const md = el.closest<HTMLElement>(".cm-md-link");
  if (md?.dataset.href) {
    event.preventDefault();
    const href = md.dataset.href;
    if (md.classList.contains("cm-external")) void openExternalUrl(href);
    else void useWorkspace.getState().openLink(source, href, { newTab });
    return true;
  }

  // In source mode (or with the cursor in a link), Cmd-click follows the link.
  if (newTab) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const line = view.state.doc.lineAt(pos);
    const offset = pos - line.from;
    for (const m of line.text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
      if (offset >= m.index && offset <= m.index + m[0].length) {
        event.preventDefault();
        const link = splitWikilink(m[1]!);
        const href = link.subpath ? `${link.target}#${link.subpath}` : link.target;
        void useWorkspace.getState().openLink(source, href, { newTab: true });
        return true;
      }
    }
    for (const m of line.text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      if (offset >= m.index && offset <= m.index + m[0].length) {
        event.preventDefault();
        const href = decodeURIComponent(m[1]!);
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) void openExternalUrl(href);
        else void useWorkspace.getState().openLink(source, href, { newTab: true });
        return true;
      }
    }
  }
  return false;
}

/** Checkbox widgets toggle the task in the document, so undo works. */
function toggleCheckbox(view: EditorView, event: MouseEvent): boolean {
  const el = event.target as HTMLElement;
  if (!(el instanceof HTMLInputElement) || !el.dataset.editorTask) return false;
  event.preventDefault();
  const line = view.state.doc.lineAt(view.posAtDOM(el));
  const next = toggleTaskLine(line.text, today());
  if (next !== null) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: next },
      userEvent: "input.toggle",
    });
  }
  return true;
}

let hoverTimer: ReturnType<typeof setTimeout> | null = null;

const hoverPreview = EditorView.domEventHandlers({
  mouseover(event) {
    const el = (event.target as HTMLElement).closest<HTMLElement>(".cm-wikilink");
    if (!el?.dataset.resolved || !(event.metaKey || event.ctrlKey)) return false;
    const { subpath } = splitTarget(el.dataset.href ?? "");
    const path = el.dataset.resolved;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const rect = el.getBoundingClientRect();
      useUi.getState().showHover({ path, subpath, x: rect.left, y: rect.bottom + 6 });
    }, 200);
    return false;
  },
  mouseout() {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = null;
    return false;
  },
});

const handlers = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return false;
    return toggleCheckbox(view, event) || clickTarget(view, event);
  },
});

/** Live preview vs. source, switchable without recreating the editor. */
export const modeCompartment = new Compartment();

export function modeExtensions(mode: EditorMode): Extension {
  return mode === "live"
    ? [blockPreview, inlinePreview, EditorView.contentAttributes.of({ "data-mode": "live" })]
    : [EditorView.contentAttributes.of({ "data-mode": "source" })];
}

export function editorExtensions(host: EditorHost, mode: EditorMode): Extension[] {
  return [
    noteContext.of(host),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorView.lineWrapping,
    placeholder("Start writing…"),
    markdown({
      codeLanguages: languages,
      extensions: [GFM, obsidianSyntax],
      // Added below, after the completion keymap, so Enter accepts a completion.
      addKeymap: false,
    }),
    syntaxHighlighting(highlight),
    autocompletion({
      override: [wikilinkCompletions, todoCompletions],
      icons: false,
      activateOnTyping: true,
    }),
    createdStamps,
    keymap.of([
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...markdownKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
      indentWithTab,
    ]),
    structure,
    modeCompartment.of(modeExtensions(mode)),
    handlers,
    hoverPreview,
    theme,
    popupTheme,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) host.onChange(u.state.doc.toString());
    }),
  ];
}

/** Scrolls to a heading, block id, line or offset, and places the cursor there. */
export function focusTarget(
  view: EditorView,
  target: { subpath?: string; line?: number; offset?: number },
) {
  const doc = view.state.doc;
  if (target.offset !== undefined) {
    const pos = Math.min(target.offset, doc.length);
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
    return;
  }
  let lineNo: number | null = null;
  if (target.line !== undefined) lineNo = Math.min(doc.lines, target.line + 1);
  else if (target.subpath) {
    const sub = target.subpath;
    for (let i = 1; i <= doc.lines; i++) {
      const text = doc.line(i).text;
      if (sub.startsWith("^")) {
        if (text.trimEnd().endsWith(` ${sub}`) || text.trim() === sub) {
          lineNo = i;
          break;
        }
      } else {
        const m = text.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
        const last = sub.split("#").pop()!.trim().toLowerCase();
        if (m && m[1]!.toLowerCase() === last) {
          lineNo = i;
          break;
        }
      }
    }
  }
  if (lineNo === null) return;
  const line = doc.line(lineNo);
  view.dispatch({
    selection: EditorSelection.cursor(line.to),
    effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 40 }),
  });
}

/** Reports failures from editor-side API calls. */
export function reportError(err: unknown) {
  useUi.getState().notify(message(err));
}
