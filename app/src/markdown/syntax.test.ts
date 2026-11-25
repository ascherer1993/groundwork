import { describe, expect, it } from "vitest";
import { urlAt, urlHref } from "./syntax";

describe("urlHref", () => {
  it("links URLs, www. names and email addresses", () => {
    expect(urlHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(urlHref("www.example.com")).toBe("https://www.example.com");
    expect(urlHref("jane@example.com")).toBe("mailto:jane@example.com");
    expect(urlHref("mailto:jane@example.com")).toBe("mailto:jane@example.com");
    expect(urlHref("not a link")).toBeNull();
  });
});

describe("urlAt", () => {
  const line = "See https://example.com/x, then (www.foo.org/a_(b)).";
  it("finds the URL under the cursor, without trailing punctuation", () => {
    expect(urlAt(line, 10)).toBe("https://example.com/x");
    expect(urlAt(line, 25)).toBe("https://example.com/x");
    expect(urlAt(line, 26)).toBeNull();
    expect(urlAt(line, 40)).toBe("https://www.foo.org/a_(b)");
    expect(urlAt(line, 2)).toBeNull();
  });
});
