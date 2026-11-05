import { EditorSelection, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { bulletLine, checkboxLine, EDITOR_COMMANDS, numberedLine } from "./commands";

/** Runs a command on `doc`, where `|` marks the cursor and `[…]` a selection. */
function run(id: string, doc: string): string {
  const anchor = doc.indexOf("[");
  const cursor = doc.indexOf("|");
  const text = doc.replace(/[|[\]]/g, "");
  const selection =
    anchor >= 0
      ? EditorSelection.single(anchor, doc.indexOf("]") - 1)
      : EditorSelection.cursor(cursor);
  let state = EditorState.create({ doc: text, selection });
  const view = {
    get state() {
      return state;
    },
    dispatch(...specs: (Transaction | TransactionSpec)[]) {
      const first = specs[0];
      state = first instanceof Transaction ? first.state : state.update(...specs).state;
    },
  } as unknown as EditorView;
  EDITOR_COMMANDS[id]!(view);
  const r = state.selection.main;
  const out = state.doc.toString();
  return r.empty
    ? `${out.slice(0, r.head)}|${out.slice(r.head)}`
    : `${out.slice(0, r.from)}[${out.slice(r.from, r.to)}]${out.slice(r.to)}`;
}

describe("checkboxes", () => {
  it("make a task of text or a list item, and check and uncheck tasks", () => {
    expect(checkboxLine("Call Jane")).toBe("- [ ] Call Jane");
    expect(checkboxLine("  - Call Jane")).toBe("  - [ ] Call Jane");
    expect(checkboxLine("1. Call Jane")).toBe("1. [ ] Call Jane");
    expect(checkboxLine("- [ ] Call Jane", "2026-11-05")).toBe("- [x] Call Jane ✅ 2026-11-05");
    expect(checkboxLine("- [x] Call Jane ✅ 2026-11-05")).toBe("- [ ] Call Jane");
  });

  it("keep the cursor with its text, on every selected line", () => {
    expect(run("editor-checkbox", "Call |Jane")).toBe("- [ ] Call |Jane");
    expect(run("editor-checkbox", "|")).toBe("- [ ] |");
    expect(run("editor-checkbox", "[one\ntwo]\nthree")).toBe("[- [ ] one\n- [ ] two]\nthree");
  });
});

describe("lists", () => {
  it("bullets on and off", () => {
    expect(bulletLine("one")).toBe("- one");
    expect(bulletLine("- one")).toBe("one");
    expect(bulletLine("2. one")).toBe("- one");
  });

  it("numbers lines in order, and off", () => {
    expect(run("editor-numbered", "[a\nb\nc]")).toBe("[1. a\n2. b\n3. c]");
    expect(numberedLine("3. c", 0)).toBe("c");
    expect(numberedLine("- c", 1)).toBe("2. c");
  });
});

describe("wrapping", () => {
  it("wraps a selection, and unwraps it", () => {
    expect(run("editor-bold", "a [word] here")).toBe("a **[word]** here");
    expect(run("editor-bold", "a **[word]** here")).toBe("a [word] here");
    expect(run("editor-bold", "a [**word**] here")).toBe("a [word] here");
  });

  it("puts the cursor between new marks", () => {
    expect(run("editor-highlight", "a |")).toBe("a ==|==");
    expect(run("editor-highlight", "a ==|==")).toBe("a |");
  });
});

describe("links", () => {
  it("wrap text or a URL", () => {
    expect(run("editor-link", "see [docs]")).toBe("see [docs](|)");
    expect(run("editor-link", "see [https://x.dev/a]")).toBe("see [|](https://x.dev/a)");
    expect(run("editor-link", "see |")).toBe("see [|]()");
  });
});
