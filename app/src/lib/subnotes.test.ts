import { describe, expect, it } from "vitest";
import type { TreeNode } from "../api/generated/TreeNode";
import { allSubnotes, groupSubnotes, subkey, subnoteFamily, subnoteLabel } from "./subnotes";

function note(path: string): TreeNode {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, kind: "note" };
}

describe("subkey", () => {
  it("is what follows the note's name and a dot, starting with a letter", () => {
    expect(subkey("Standup", "Standup.transcript")).toBe("transcript");
    expect(subkey("Standup", "Standup.a.b")).toBe("a.b");
    expect(subkey("Standup", "Standup.été")).toBe("été");
    expect(subkey("Release 1", "Release 1.2")).toBeNull();
    expect(subkey("Standup", "Standup. notes")).toBeNull();
    expect(subkey("Standup", "Standups.x")).toBeNull();
    expect(subkey("Standup", "Standup")).toBeNull();
  });
});

describe("groupSubnotes", () => {
  const children: TreeNode[] = [
    { name: "Archive", path: "M/Archive", kind: "folder", children: [] },
    note("M/Release 1.md"),
    note("M/Release 1.2.md"),
    note("M/Standup.md"),
    note("M/Standup.summary.draft.md"),
    note("M/Standup.transcript.md"),
    note("M/Standup.transcript.raw.md"),
    { name: "Standup.sketch.html", path: "M/Standup.sketch.html", kind: "page" },
    note("M/Orphan.key.md"),
  ];

  it("puts subnotes under their nearest note, keeping order", () => {
    const top = groupSubnotes(children);
    expect(top.map((g) => g.node.name)).toEqual([
      "Archive",
      "Release 1.md",
      "Release 1.2.md",
      "Standup.md",
      "Standup.sketch.html",
      "Orphan.key.md",
    ]);
    const standup = top[3]!;
    expect(standup.subnotes.map((g) => [g.key, g.node.name])).toEqual([
      ["summary.draft", "Standup.summary.draft.md"],
      ["transcript", "Standup.transcript.md"],
    ]);
    expect(standup.subnotes[1]!.subnotes.map((g) => g.key)).toEqual(["raw"]);
    expect(allSubnotes(standup).map((n) => n.name)).toEqual([
      "Standup.summary.draft.md",
      "Standup.transcript.md",
      "Standup.transcript.raw.md",
    ]);
  });

  it("finds a note's family in the tree", () => {
    const root: TreeNode = {
      name: "",
      path: "",
      kind: "folder",
      children: [{ name: "M", path: "M", kind: "folder", children }],
    };
    const raw = subnoteFamily(root, "M/Standup.transcript.raw.md");
    expect(raw.parent?.node.path).toBe("M/Standup.transcript.md");
    expect(raw.subnotes).toEqual([]);
    const standup = subnoteFamily(root, "M/Standup.md");
    expect(standup.parent).toBeNull();
    expect(standup.subnotes.map((g) => g.key)).toEqual(["summary.draft", "transcript"]);
    expect(subnoteFamily(root, "Nowhere/x.md")).toEqual({ parent: null, subnotes: [] });
  });
});

describe("subnoteLabel", () => {
  const root: TreeNode = {
    name: "",
    path: "",
    kind: "folder",
    children: [
      {
        name: "M",
        path: "M",
        kind: "folder",
        children: [
          note("M/Standup.md"),
          note("M/Standup.transcript.md"),
          note("M/Standup.transcript.raw.md"),
          note("M/Release 1.md"),
          note("M/Release 1.2.md"),
        ],
      },
    ],
  };

  it("is the key, under the notes it belongs to", () => {
    expect(subnoteLabel(root, "M/Standup.transcript.md")).toEqual({
      key: "transcript",
      under: "Standup",
    });
    expect(subnoteLabel(root, "M/Standup.transcript.raw.md")).toEqual({
      key: "raw",
      under: "Standup › transcript",
    });
  });

  it("is null for notes that aren't subnotes", () => {
    expect(subnoteLabel(root, "M/Standup.md")).toBeNull();
    expect(subnoteLabel(root, "M/Release 1.2.md")).toBeNull();
    expect(subnoteLabel(null, "M/Standup.transcript.md")).toBeNull();
  });
});
