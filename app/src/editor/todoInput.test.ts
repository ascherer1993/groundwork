import { describe, expect, it } from "vitest";
import { parseTodoInput } from "../markdown/todos";
import { withCreatedStamp } from "./todoInput";

describe("withCreatedStamp", () => {
  it("adds the stamp before a block id", () => {
    expect(withCreatedStamp("- [ ] Call Bob ^b1", "2026-11-03")).toBe(
      "- [ ] Call Bob ➕ 2026-11-03 ^b1",
    );
    expect(withCreatedStamp("- [ ] Call Bob  ", "2026-11-03")).toBe("- [ ] Call Bob ➕ 2026-11-03");
  });
});

describe("parseTodoInput", () => {
  it("pulls out @dates and !priorities", () => {
    expect(parseTodoInput("Call Bob @2026-11-06 !p1")).toEqual({
      text: "Call Bob",
      due: "2026-11-06",
      priority: 1,
    });
    // What the completions insert.
    expect(parseTodoInput("Call Bob 📅 2026-11-06 ⏫")).toEqual({
      text: "Call Bob",
      due: "2026-11-06",
      priority: 1,
    });
    expect(parseTodoInput("Call Bob @p4")).toEqual({
      text: "Call Bob",
      due: undefined,
      priority: 4,
    });
    expect(parseTodoInput("Email jane@example.com about it")).toEqual({
      text: "Email jane@example.com about it",
      due: undefined,
      priority: undefined,
    });
  });
});
