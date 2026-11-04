import { describe, expect, it } from "vitest";
import { missingProperties } from "./templates";

describe("missingProperties", () => {
  it("adds only the keys the note lacks, with their nested lines", () => {
    const note = "created: 2026-11-01\ntags:\n  - work\n";
    const template = "type: meeting\ntags:\n  - meeting\nattendees:\n  - Jane\n  - Bob\n";
    expect(missingProperties(note, template)).toBe(
      "type: meeting\nattendees:\n  - Jane\n  - Bob\n",
    );
  });

  it("adds everything to a note without properties", () => {
    expect(missingProperties("", "type: meeting\n")).toBe("type: meeting\n");
  });
});
