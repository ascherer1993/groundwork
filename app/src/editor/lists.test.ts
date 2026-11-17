import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { indentListItem, orderedLabel, outdentListItem } from "./lists";

/** Runs `command` on `doc`, where `|` marks the cursor; null when it declines. */
function run(command: StateCommand, doc: string): string | null {
  const cursor = doc.indexOf("|");
  let state = EditorState.create({
    doc: doc.replace("|", ""),
    selection: EditorSelection.cursor(cursor),
  });
  const handled = command({
    state,
    dispatch: (tr) => {
      state = tr.state;
    },
  });
  if (!handled) return null;
  const out = state.doc.toString();
  const head = state.selection.main.head;
  return `${out.slice(0, head)}|${out.slice(head)}`;
}

const tab = (doc: string) => run(indentListItem, doc);
const shiftTab = (doc: string) => run(outdentListItem, doc);

describe("Tab on a list item", () => {
  it("nests a numbered item under the one above, starting again at 1", () => {
    expect(tab("1. One\n2. |")).toBe("1. One\n   1. |");
    expect(tab("1. One\n2. Two|")).toBe("1. One\n   1. Two|");
  });

  it("carries on the numbering of the children already there", () => {
    expect(tab("1. One\n   1. A\n   2. B\n2. |")).toBe("1. One\n   1. A\n   2. B\n   3. |");
    // Lined up with them, even when they're indented further than the text.
    expect(tab("1. One\n    1. A\n2. |")).toBe("1. One\n    1. A\n    2. |");
  });

  it("goes a level deeper again, for i, ii, iii", () => {
    expect(tab("1. One\n   1. A\n   2. |")).toBe("1. One\n   1. A\n      1. |");
  });

  it("closes the gap in the numbers after it", () => {
    expect(tab("1. One\n2. |Two\n3. Three\n4. Four")).toBe("1. One\n   1. |Two\n2. Three\n3. Four");
  });

  it("leaves numbers that weren't in sequence alone", () => {
    expect(tab("1. One\n1. |Two\n1. Three")).toBe("1. One\n   1. |Two\n1. Three");
  });

  it("takes what's under the item with it", () => {
    expect(tab("1. One\n2. |Two\n   1. Under\n3. Three")).toBe(
      "1. One\n   1. |Two\n      1. Under\n2. Three",
    );
  });

  it("nests bullets under the text above, and keeps tabs when the list uses them", () => {
    expect(tab("- One\n- |Two")).toBe("- One\n  - |Two");
    expect(tab("\t1. One\n\t2. |")).toBe("\t1. One\n\t\t1. |");
  });

  it("does nothing to the first item, and leaves other lines to plain Tab", () => {
    expect(tab("1. |One\n2. Two")).toBe("1. |One\n2. Two");
    expect(tab("Just |text")).toBeNull();
  });
});

describe("Shift-Tab on a list item", () => {
  it("brings it out after its parent, carrying on the parent's numbering", () => {
    expect(shiftTab("1. One\n   1. A\n   2. |")).toBe("1. One\n   1. A\n2. |");
  });

  it("goes back from i, ii, iii to the letters", () => {
    expect(shiftTab("1. One\n   1. A\n      1. i\n      2. |")).toBe(
      "1. One\n   1. A\n      1. i\n   2. |",
    );
  });

  it("renumbers what follows at both levels", () => {
    expect(shiftTab("1. One\n   1. A\n   2. |B\n   3. C\n2. Two\n3. Three")).toBe(
      "1. One\n   1. A\n2. |B\n   1. C\n3. Two\n4. Three",
    );
  });

  it("takes what's under the item with it", () => {
    expect(shiftTab("1. One\n   1. |A\n      1. Deep\n2. Two")).toBe(
      "1. One\n2. |A\n   1. Deep\n3. Two",
    );
  });

  it("is plain Shift-Tab for an item that isn't nested", () => {
    expect(shiftTab("1. |One")).toBeNull();
  });

  it("undoes Tab", () => {
    const doc = "1. One\n2. |Two\n3. Three";
    expect(shiftTab(tab(doc)!)).toBe(doc);
  });
});

describe("orderedLabel", () => {
  it("counts 1, 2, 3; a, b, c; i, ii, iii; then over", () => {
    expect([1, 2, 3].map((n) => orderedLabel(n, 1))).toEqual(["1", "2", "3"]);
    expect([1, 2, 26, 27].map((n) => orderedLabel(n, 2))).toEqual(["a", "b", "z", "aa"]);
    expect([1, 4, 9, 14].map((n) => orderedLabel(n, 3))).toEqual(["i", "iv", "ix", "xiv"]);
    expect(orderedLabel(2, 4)).toBe("2");
    expect(orderedLabel(2, 5)).toBe("b");
  });
});
