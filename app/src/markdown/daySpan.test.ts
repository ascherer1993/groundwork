import { describe, expect, it } from "vitest";
import { findDaySpan, isDayBlock } from "./daySpan";

const block = "```todos\nday\n```";

describe("findDaySpan", () => {
  it("takes the todos above and below the block", () => {
    const text = [
      "# Day", // 0
      "## Todos", // 1
      "", // 2
      "- [ ] One", // 3
      "  - [ ] Nested", // 4
      "    A note under it", // 5
      "- [x] Two", // 6
      "", // 7
      block, // 8–10
      "", // 11
      "1. [ ] Three", // 12
      "", // 13
      "## Notes", // 14
      "- [ ] Elsewhere", // 15
    ].join("\n");
    expect(findDaySpan(text)).toEqual([3, 12]);
  });

  it("is just the block when nothing is beside it", () => {
    expect(findDaySpan(`## Todos\n\n${block}\n`)).toEqual([2, 4]);
    expect(findDaySpan(`Some text\n\n${block}\n\nMore text\n- [ ] Later on`)).toEqual([2, 4]);
  });

  it("leaves lists of other things on the page", () => {
    expect(findDaySpan(`- Groceries\n- [ ] Milk\n\n${block}`)).toEqual([3, 5]);
    expect(findDaySpan(`${block}\n- [ ] Milk\n- Groceries`)).toEqual([0, 2]);
  });

  it("finds only day blocks", () => {
    expect(findDaySpan("```todos\nagenda\n```\n- [ ] A")).toBeNull();
    expect(findDaySpan("- [ ] A")).toBeNull();
    expect(findDaySpan("```todos\ndue: today\n```\n\n~~~todos\nday\n~~~\n- [ ] A")).toEqual([4, 7]);
  });

  it("reads the block's text", () => {
    expect(isDayBlock("```todos\nday\n```")).toBe(true);
    expect(isDayBlock("\n Day \n")).toBe(true);
    expect(isDayBlock("```todos\nagenda\n```")).toBe(false);
  });
});
