import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { proseWords, wordsIn } from "./spelling";
import { obsidianSyntax } from "./syntax";

const words = (text: string) => wordsIn(text).map((w) => w.word);

describe("wordsIn", () => {
  it("finds words with their offsets", () => {
    expect(wordsIn("Helo, wrld!", 10)).toEqual([
      { from: 10, to: 14, word: "Helo" },
      { from: 16, to: 20, word: "wrld" },
    ]);
  });

  it("trims punctuation and Markdown marks off words", () => {
    expect(words("(this) _that_ ==marked== **bold** “quoted” end.")).toEqual([
      "this",
      "that",
      "marked",
      "bold",
      "quoted",
      "end",
    ]);
  });

  it("keeps apostrophes and splits hyphens", () => {
    expect(words("don’t isn't dogs' well-known self—aware")).toEqual([
      "don’t",
      "isn't",
      "dogs",
      "well",
      "known",
      "self",
      "aware",
    ]);
    const [, known] = wordsIn("well-known");
    expect(known).toEqual({ from: 5, to: 10, word: "known" });
  });

  it("leaves paths, URLs, numbers, identifiers, acronyms and brands alone", () => {
    expect(
      words(
        "src/app.ts https://x.io a@b.co v2 snake_case e.g. 3rd key=val API NASA iPhone macOS I a #tag",
      ),
    ).toEqual([]);
  });

  it("leaves a callout's type alone but checks its title", () => {
    expect(words("> [!tldr]- Sumary here")).toEqual(["Sumary", "here"]);
  });
});

describe("proseWords", () => {
  const state = (doc: string) => {
    const s = EditorState.create({
      doc,
      extensions: markdown({ extensions: [GFM, obsidianSyntax] }),
    });
    ensureSyntaxTree(s, s.doc.length, 5000);
    return s;
  };
  const prose = (doc: string) => {
    const s = state(doc);
    return proseWords(s, 0, s.doc.length).map((w) => w.word);
  };

  it("checks only prose", () => {
    const doc = [
      "---",
      "tags: [wrds]",
      "---",
      "Some txt with `inlne` code, a [linkk](https://exmple.com/pth) and [[Wikii Note]].",
      "",
      "```js",
      "const vlaue = 1;",
      "```",
      "",
      'A #tagg, $mathh$, %%commnt%% and <span class="clss">htmll</span>.',
    ].join("\n");
    expect(prose(doc)).toEqual(["Some", "txt", "with", "code", "linkk", "and", "and", "htmll"]);
  });

  it("finds words across lines at the right offsets", () => {
    const s = state("one\ntwo tre");
    expect(proseWords(s, 0, s.doc.length)).toEqual([
      { from: 0, to: 3, word: "one" },
      { from: 4, to: 7, word: "two" },
      { from: 8, to: 11, word: "tre" },
    ]);
    // Part of the document only.
    expect(proseWords(s, 4, 7).map((w) => w.word)).toEqual(["two"]);
  });
});
