import { describe, expect, it } from "vitest";
import { usable } from "../lib/keyCombo";
import { KEY_COMMANDS } from "./keys";

describe("default shortcuts", () => {
  it("are distinct and usable", () => {
    const ids = KEY_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = KEY_COMMANDS.flatMap((c) => (c.key ? [c.key] : []));
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(usable(key)).toBe(true);
  });
});
