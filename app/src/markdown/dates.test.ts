import { describe, expect, it } from "vitest";
import { parseNatural } from "./dates";

// The same cases as `dates.rs`.
describe("parseNatural", () => {
  const today = new Date(2026, 10, 3, 15, 30); // Tuesday
  it.each([
    ["today", "2026-11-03"],
    ["Tomorrow", "2026-11-04"],
    ["tom", "2026-11-04"],
    ["yesterday", "2026-11-02"],
    ["fri", "2026-11-06"],
    ["friday", "2026-11-06"],
    ["tue", "2026-11-10"],
    ["mon", "2026-11-09"],
    ["+3d", "2026-11-06"],
    ["+2w", "2026-11-17"],
    ["+1m", "2026-12-03"],
    ["+1y", "2027-11-03"],
    ["nov 12", "2026-11-12"],
    ["12 November", "2026-11-12"],
    ["jan 5", "2027-01-05"],
    ["nov 1", "2027-11-01"],
    ["2026-12-25", "2026-12-25"],
  ])("%s → %s", (text, want) => expect(parseNatural(text, today)).toBe(want));

  it.each(["", "fr", "someday", "+3x", "feb 30", "nov", "2026-13-01"])("rejects %j", (bad) =>
    expect(parseNatural(bad, today)).toBeNull(),
  );
});
