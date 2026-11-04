import { describe, expect, it } from "vitest";
import { findVaultPaths } from "./terminalLinks";

const files = ["Projects/Acme/Kickoff notes.md", "a.md", "Notes/a.md", "Pages/demo.html"];
const root = "/Users/me/Vault";

function found(text: string, cwd = root) {
  return findVaultPaths(text, files, root, cwd).map((m) => [
    text.slice(m.start, m.end),
    m.path,
    m.line,
  ]);
}

describe("findVaultPaths", () => {
  it("finds vault paths, with spaces", () => {
    expect(found("Created Projects/Acme/Kickoff notes.md and Pages/demo.html.")).toEqual([
      ["Projects/Acme/Kickoff notes.md", "Projects/Acme/Kickoff notes.md", undefined],
      ["Pages/demo.html", "Pages/demo.html", undefined],
    ]);
  });

  it("finds absolute paths into the vault, and line numbers", () => {
    expect(found("⏺ Update(/Users/me/Vault/Notes/a.md:12)")).toEqual([
      ["/Users/me/Vault/Notes/a.md:12", "Notes/a.md", 12],
    ]);
  });

  it("finds paths relative to the shell's folder", () => {
    expect(found("Kickoff notes.md", `${root}/Projects/Acme`)).toEqual([
      ["Kickoff notes.md", "Projects/Acme/Kickoff notes.md", undefined],
    ]);
  });

  it("prefers the longest match and ignores parts of other names", () => {
    expect(found("Notes/a.md")).toEqual([["Notes/a.md", "Notes/a.md", undefined]]);
    expect(found("data.md a.mdx /tmp/a.md")).toEqual([]);
    expect(found("(a.md)")).toEqual([["a.md", "a.md", undefined]]);
  });
});
