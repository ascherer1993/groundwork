// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./render";
import { extractSubpath, splitFrontmatter, splitWikilink, toggleTaskLine } from "./syntax";

function dom(markdown: string, lineOffset = 0) {
  const div = document.createElement("div");
  div.innerHTML = renderMarkdown(markdown, { lineOffset });
  return div;
}

describe("renderMarkdown", () => {
  it("renders wikilinks with aliases and subpaths", () => {
    const d = dom("[[Note]] [[Note|Alias]] [[Note#Part]] [[#Local]]");
    const links = [...d.querySelectorAll("a.internal-link")].map((a) => [
      a.getAttribute("data-href"),
      a.textContent,
    ]);
    expect(links).toEqual([
      ["Note", "Note"],
      ["Note", "Alias"],
      ["Note#Part", "Note > Part"],
      ["#Local", "Local"],
    ]);
  });

  it("leaves embeds as placeholders", () => {
    const d = dom("![[pic.png|300]] and ![[Other#^blk]]");
    const embeds = [...d.querySelectorAll(".embed")].map((e) => [
      e.getAttribute("data-embed"),
      e.getAttribute("data-alias"),
    ]);
    expect(embeds).toEqual([
      ["pic.png", "300"],
      ["Other#^blk", ""],
    ]);
  });

  it("marks markdown links and defers relative images", () => {
    const d = dom("[n](My%20Note.md#Sec) [w](https://example.com) ![i](img/a.png)");
    const internal = d.querySelector("a.internal-link")!;
    expect(internal.getAttribute("data-href")).toBe("My Note.md#Sec");
    expect(d.querySelector("a.external-link")!.getAttribute("target")).toBe("_blank");
    expect(d.querySelector("img")!.getAttribute("data-src-link")).toBe("img/a.png");
  });

  it("does not treat code as links or tags", () => {
    const d = dom("`[[Code]] #tag`\n\n```\n[[Fenced]]\n```");
    expect(d.querySelectorAll("a").length).toBe(0);
  });

  it("renders tags, highlights and hides comments", () => {
    const d = dom("A #tag/nested and ==bright== %%secret%% end\n\n%%\nhidden block\n%%\n\nafter");
    expect(d.querySelector("a.tag")!.textContent).toBe("#tag/nested");
    expect(d.querySelector("mark")!.textContent).toBe("bright");
    expect(d.textContent).not.toContain("secret");
    expect(d.textContent).not.toContain("hidden block");
    expect(d.textContent).toContain("after");
  });

  it("renders tasks with file line numbers, metadata on a line below", () => {
    const d = dom("- [ ] open ⏫ 📅 2026-11-05 ➕ 2026-11-03\n- [x] done ✅ 2026-11-03", 4);
    const boxes = [...d.querySelectorAll<HTMLInputElement>("input.task-checkbox")];
    expect(boxes.map((b) => [b.dataset.line, b.checked])).toEqual([
      ["4", false],
      ["5", true],
    ]);
    // No emoji left in the text; the metadata is in its own element.
    expect(d.textContent).not.toMatch(/[📅➕✅⏫]/u);
    const metas = [...d.querySelectorAll(".task-meta")].map((m) => m.textContent);
    expect(metas).toHaveLength(2);
    expect(metas[0]).toMatch(/^P1 · Due .+ · Created /);
    expect(metas[1]).toMatch(/^Done /);
  });

  it("renders callouts, including foldable ones", () => {
    const d = dom("> [!warning] Careful\n> Body text\n\n> [!tip]- Folded\n> Inside");
    const callouts = d.querySelectorAll(".callout");
    expect(callouts[0]!.getAttribute("data-callout-group")).toBe("warning");
    expect(callouts[0]!.querySelector(".callout-title")!.textContent).toBe("Careful");
    expect(callouts[0]!.querySelector(".callout-content")!.textContent).toContain("Body text");
    expect(callouts[1]!.tagName).toBe("DETAILS");
    expect(callouts[1]!.hasAttribute("open")).toBe(false);
  });

  it("strips block ids and tags the block", () => {
    const d = dom("Para text ^p1");
    expect(d.textContent!.trim()).toBe("Para text");
    expect(d.querySelector("[data-block-id='p1']")).not.toBeNull();
  });

  it("defers mermaid and renders math", () => {
    const d = dom("```mermaid\ngraph LR\nA-->B\n```\n\nInline $x^2$");
    const source = d.querySelector(".mermaid-block")!.getAttribute("data-source")!;
    expect(decodeURIComponent(source)).toContain("A-->B");
    expect(d.querySelector(".katex")).not.toBeNull();
  });

  it("sanitizes scripts in raw HTML", () => {
    const d = dom('<img src=x onerror="alert(1)"><script>alert(2)</script>');
    expect(d.innerHTML).not.toContain("onerror");
    expect(d.innerHTML).not.toContain("<script");
  });
});

describe("syntax helpers", () => {
  it("splits wikilinks", () => {
    expect(splitWikilink("A#B|C")).toEqual({ target: "A", subpath: "B", alias: "C" });
    expect(splitWikilink("A\\|C")).toEqual({ target: "A", subpath: undefined, alias: "C" });
  });

  it("splits frontmatter", () => {
    const fm = splitFrontmatter("---\na: 1\n---\nbody");
    expect(fm).toEqual({ yaml: "a: 1\n", body: "body", lineOffset: 3, length: 13 });
    expect(splitFrontmatter("no fm").yaml).toBeNull();
  });

  it("extracts heading sections and blocks", () => {
    const body = "# A\n\none\n\n## B\n\ntwo\n\n# C\n\nthree\n\n- item ^i1\n\npara\nline two ^p2";
    expect(extractSubpath(body, "B")).toBe("## B\n\ntwo");
    expect(extractSubpath(body, "A")).toBe("# A\n\none\n\n## B\n\ntwo");
    expect(extractSubpath(body, "^i1")).toBe("- item ^i1");
    expect(extractSubpath(body, "^p2")).toBe("para\nline two ^p2");
    expect(extractSubpath(body, "Missing")).toBeNull();
  });
});

describe("toggleTaskLine", () => {
  it("matches the Rust implementation", () => {
    expect(toggleTaskLine("- [ ] one ^b1", "2026-11-04")).toBe("- [x] one ✅ 2026-11-04 ^b1");
    expect(toggleTaskLine("  - [x] two ✅ 2026-01-01", "2026-11-04")).toBe("  - [ ] two");
    expect(toggleTaskLine("- not a task", "2026-11-04")).toBeNull();
  });
});
