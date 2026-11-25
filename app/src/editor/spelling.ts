/**
 * Spell checking in the note editor (PLAN §5.18): words the dictionary
 * doesn't know get a red wavy underline, and right-clicking one offers
 * suggestions and "Add to dictionary". Only prose is checked: code, links'
 * targets, wikilinks, tags, math, HTML, frontmatter, and anything that looks
 * like a path, URL, address, number or identifier are left alone, as is the
 * word being typed.
 */
import { syntaxTree } from "@codemirror/language";
import { type EditorState, RangeSetBuilder, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { api } from "../api/client";
import {
  addToDictionary,
  checkWords,
  onSpellingChanged,
  useSpelling,
  verdict,
} from "../state/spelling";
import { useUi, type MenuEntry } from "../state/ui";
import { message, useVault } from "../state/vault";

/** Syntax whose text isn't prose, so isn't checked. */
const SKIP = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "URL",
  "Autolink",
  "LinkReference",
  "Image",
  "HTMLBlock",
  "HTMLTag",
  "CommentBlock",
  "ProcessingInstructionBlock",
  "Entity",
  "Escape",
  "Frontmatter",
  "MathBlock",
  "InlineMath",
  "WikiLink",
  "WikiEmbed",
  "Tag",
  "BlockRef",
  "Comment",
]);

/** Runs of text between spaces and brackets: candidates for words. */
const CHUNK = /[^\s()[\]{}<>"“”«»,;!?*~`|]+/gu;
/** A chunk with these in it (once its ends are trimmed) is a path, URL, number, identifier… */
const NOT_PROSE = /[\p{N}_/\\@#$%^&=+:.]/u;
/** Punctuation trimmed off a chunk's ends; not marks that make it something else (`#tag`, `@date`, `$5`). */
const TRIM = /[^\p{L}\p{M}\p{N}#@$/\\&%]/u;
const WORD = /^[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*['’]?$/u;
/** A callout's type, `> [!note]`. */
const CALLOUT = /\[![\w-]+\][+-]?/g;

export interface Word {
  from: number;
  to: number;
  word: string;
}

/**
 * The words in `text` worth checking, with their offsets (plus `offset`).
 * Hyphenated words are checked a part at a time.
 */
export function wordsIn(text: string, offset = 0): Word[] {
  const words: Word[] = [];
  text = text.replace(CALLOUT, (m) => " ".repeat(m.length));
  for (const m of text.matchAll(CHUNK)) {
    let start = m.index;
    let chunk = m[0];
    // Trim punctuation off its ends: `(word).`, `_emphasis_`, `==mark==`.
    while (chunk && TRIM.test(chunk[0]!)) {
      chunk = chunk.slice(1);
      start++;
    }
    while (chunk && TRIM.test(chunk[chunk.length - 1]!)) chunk = chunk.slice(0, -1);
    if (!chunk || NOT_PROSE.test(chunk)) continue;
    let partStart = start;
    for (const part of chunk.split(/[-–—]/)) {
      const from = partStart;
      partStart += part.length + 1;
      if (!isCheckable(part)) continue;
      words.push({ from: offset + from, to: offset + from + part.length, word: part });
    }
  }
  return words;
}

function isCheckable(word: string): boolean {
  if (!WORD.test(word)) return false;
  const letters = word.replace(/['’]/g, "");
  if ([...letters].length < 2) return false;
  // Acronyms (API, NASA) and camelCase or brand casing (iPhone, macOS).
  if (letters === letters.toUpperCase()) return false;
  if (/\p{Ll}\p{Lu}/u.test(letters)) return false;
  return true;
}

/** The words worth checking between `from` and `to`, outside code, links and the like. */
export function proseWords(state: EditorState, from: number, to: number): Word[] {
  const skipped: [number, number][] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (!SKIP.has(node.name)) return;
      skipped.push([node.from, node.to]);
      return false;
    },
  });
  const words: Word[] = [];
  let line = state.doc.lineAt(from);
  for (;;) {
    const start = Math.max(line.from, from);
    const end = Math.min(line.to, to);
    for (const w of wordsIn(state.doc.sliceString(start, end), start))
      if (!skipped.some(([a, b]) => w.from < b && w.to > a)) words.push(w);
    if (line.to >= to || line.number >= state.doc.lines) break;
    line = state.doc.line(line.number + 1);
  }
  return words;
}

const misspelledMark = (word: string) =>
  Decoration.mark({ class: "cm-misspelled", attributes: { "data-word": word }, word });

/** Something said the underlines may need drawing again. */
const redraw = StateEffect.define<null>();

/** How long to wait after typing or scrolling before asking about new words. */
const CHECK_DELAY = 250;

class SpellChecker {
  decorations: DecorationSet = Decoration.none;
  /** Where the user is typing a word, which isn't underlined until they leave it. */
  typing: number | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;
  unsubscribe: () => void;

  constructor(readonly view: EditorView) {
    this.unsubscribe = onSpellingChanged(() => this.refresh());
    this.decorations = this.build();
    this.schedule(0);
  }

  update(u: ViewUpdate) {
    if (u.docChanged) {
      const typed = u.transactions.some((tr) => tr.isUserEvent("input.type"));
      this.typing = typed ? u.state.selection.main.head : null;
    } else if (u.selectionSet) this.typing = null;
    const asked = u.transactions.some((tr) => tr.effects.some((e) => e.is(redraw)));
    if (u.docChanged || u.viewportChanged || u.selectionSet || asked) {
      this.decorations = this.build();
      if (!asked) this.schedule(CHECK_DELAY);
    }
  }

  /** Underlines the words already known to be misspelled. */
  build(): DecorationSet {
    const vault = useVault.getState().vault?.path;
    if (!vault || !useSpelling.getState().enabled) return Decoration.none;
    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to } of this.view.visibleRanges)
      for (const w of proseWords(this.view.state, from, to)) {
        if (this.typing !== null && w.from <= this.typing && this.typing <= w.to) continue;
        if (verdict(vault, w.word) === false) builder.add(w.from, w.to, misspelledMark(w.word));
      }
    return builder.finish();
  }

  /** Asks about the words on screen not asked about yet, then redraws. */
  schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), delay);
  }

  async check() {
    this.timer = null;
    const vault = useVault.getState().vault?.path;
    if (!vault || !useSpelling.getState().enabled) return;
    const words = this.view.visibleRanges.flatMap(({ from, to }) =>
      proseWords(this.view.state, from, to).map((w) => w.word),
    );
    const unasked = words.filter((w) => verdict(vault, w) === undefined);
    if (unasked.length === 0) return;
    try {
      await checkWords(vault, unasked);
    } catch {
      return; // Leave words unmarked rather than nag; the next edit asks again.
    }
    this.refresh();
  }

  /** Redraws, and asks about anything the cache has forgotten. */
  refresh() {
    this.view.dispatch({ effects: redraw.of(null) });
    this.schedule(0);
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribe();
  }
}

const checker = ViewPlugin.fromClass(SpellChecker, { decorations: (c) => c.decorations });

/** The misspelled word at `pos`, if there's one there. */
function misspelledAt(view: EditorView, pos: number): Word | null {
  const plugin = view.plugin(checker);
  let found: Word | null = null;
  plugin?.decorations.between(pos, pos, (from, to, deco) => {
    if (from <= pos && pos <= to) {
      found = { from, to, word: deco.spec.word as string };
      return false;
    }
  });
  return found;
}

/** Puts `replacement` where `word` was, if it's still there. */
function replaceWord(view: EditorView, word: Word, replacement: string) {
  if (view.state.sliceDoc(word.from, word.to) !== word.word) return;
  view.dispatch({
    changes: { from: word.from, to: word.to, insert: replacement },
    selection: { anchor: word.from + replacement.length },
    userEvent: "input.spelling",
  });
  view.focus();
}

/** Right-clicking a misspelled word: its suggestions, and "Add to dictionary". */
const contextMenu = EditorView.domEventHandlers({
  contextmenu(event, view) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const word = misspelledAt(view, pos);
    if (!word) return false;
    event.preventDefault();
    const { clientX: x, clientY: y } = event;
    void api
      .spellingSuggestions(word.word)
      .catch(() => [] as string[])
      .then((suggestions) => {
        const items: MenuEntry[] = suggestions.length
          ? suggestions.map((s) => ({ label: s, action: () => replaceWord(view, word, s) }))
          : [{ label: "No suggestions", disabled: true }];
        items.push("separator", {
          label: `Add “${word.word}” to dictionary`,
          action: () =>
            void addToDictionary(word.word).catch((e: unknown) =>
              useUi.getState().notify(message(e)),
            ),
        });
        useUi.getState().showMenu(x, y, items);
      });
    return true;
  },
});

const theme = EditorView.baseTheme({
  ".cm-misspelled": {
    textDecorationLine: "underline",
    textDecorationStyle: "wavy",
    textDecorationColor: "var(--danger)",
    textDecorationThickness: "1px",
    textUnderlineOffset: "3px",
    textDecorationSkipInk: "none",
  },
});

export const spellcheck = [checker, contextMenu, theme];
