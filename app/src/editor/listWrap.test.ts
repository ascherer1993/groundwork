import { describe, expect, it } from "vitest";
import { listTextStart } from "./listWrap";

describe("listTextStart", () => {
  it("skips a bullet or number and the space after it", () => {
    expect(listTextStart("- text")).toBe(2);
    expect(listTextStart("* text")).toBe(2);
    expect(listTextStart("12. text")).toBe(4);
    expect(listTextStart("3) text")).toBe(3);
  });

  it("skips the indent of a nested item", () => {
    expect(listTextStart("    - text")).toBe(6);
    expect(listTextStart("\t1. text")).toBe(4);
  });

  it("skips a task's box", () => {
    expect(listTextStart("- [ ] task")).toBe(6);
    expect(listTextStart("  - [x] done")).toBe(8);
  });

  it("leaves text that only looks like a box", () => {
    expect(listTextStart("- [link](x)")).toBe(2);
  });

  it("finds where an item's carried-on lines start", () => {
    expect(listTextStart("  more of the item")).toBe(2);
    expect(listTextStart("plain")).toBe(0);
  });

  it("handles an empty item", () => {
    expect(listTextStart("- ")).toBe(2);
    expect(listTextStart("-")).toBe(1);
  });
});
