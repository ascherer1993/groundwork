import { describe, expect, it } from "vitest";
import { pastedName, withWidth } from "./images";
import { imageSize } from "../markdown/syntax";

describe("withWidth", () => {
  it("sets the width of a wiki embed", () => {
    expect(withWidth("![[a.png]] after", 300)).toEqual({ length: 10, insert: "![[a.png|300]]" });
    expect(withWidth("![[a.png|120]]", 300)?.insert).toBe("![[a.png|300]]");
    expect(withWidth("![[a.png|120x80]]", 300)?.insert).toBe("![[a.png|300]]");
    expect(withWidth("![[a.png|Diagram]]", 300)?.insert).toBe("![[a.png|Diagram|300]]");
    expect(withWidth("![[a.png|Diagram|120]]", 300)?.insert).toBe("![[a.png|Diagram|300]]");
  });

  it("sets the width of a Markdown image", () => {
    expect(withWidth("![](img/a.png)", 250)).toEqual({ length: 14, insert: "![250](img/a.png)" });
    expect(withWidth("![Chart|90](a%20b.png) x", 250)?.insert).toBe("![Chart|250](a%20b.png)");
  });

  it("ignores anything else", () => {
    expect(withWidth("[[a.png]]", 300)).toBeNull();
    expect(withWidth("text ![[a.png]]", 300)).toBeNull();
  });
});

describe("imageSize", () => {
  it("reads a size alone or after alt text", () => {
    expect(imageSize("300")).toEqual({ width: 300, height: undefined });
    expect(imageSize("300x200")).toEqual({ width: 300, height: 200 });
    expect(imageSize("Diagram|300")).toEqual({ width: 300, height: undefined });
    expect(imageSize("Diagram")).toEqual({});
    expect(imageSize("2026 plan")).toEqual({});
  });
});

describe("pastedName", () => {
  it("follows Obsidian's naming", () => {
    const file = new File(["x"], "image.png", { type: "image/png" });
    expect(pastedName(file, new Date(2026, 10, 10, 9, 5, 7))).toBe(
      "Pasted image 20261110090507.png",
    );
    const jpeg = new File(["x"], "image", { type: "image/jpeg" });
    expect(pastedName(jpeg, new Date(2026, 0, 2, 3, 4, 5))).toBe("Pasted image 20260102030405.jpg");
  });
});
