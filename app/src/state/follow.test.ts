import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "../api/generated/ProjectInfo";
import type { Workspace } from "../api/generated/Workspace";
import { subnoteParents, workspaceFor } from "./follow";

const ws = (id: string, note?: string): Workspace => ({
  id,
  name: id,
  cwd: "/",
  note,
  layout: null,
});
const project = (folder: string, overview: string | null): ProjectInfo => ({
  id: folder,
  name: folder,
  folder,
  overview,
  code: [],
});

describe("workspaceFor", () => {
  const workspaces = [
    ws("ticket", "Projects/Acme/Work/TEAM-1 Fix.md"),
    ws("acme", "Projects/Acme/Acme.md"),
    ws("beta", "Projects/Beta/Overview.md"),
    ws("plain"),
  ];
  const projects = [project("Projects/Beta", "Projects/Beta/Overview.md")];
  const find = (path: string) => workspaceFor(path, workspaces, projects)?.id;

  it("prefers the note's own workspace", () => {
    expect(find("Projects/Acme/Work/TEAM-1 Fix.md")).toBe("ticket");
    expect(find("Projects/Acme/Acme.md")).toBe("acme");
  });

  it("uses the nearest folder note's workspace above it", () => {
    expect(find("Projects/Acme/Work/TEAM-2 Other.md")).toBe("acme");
    expect(find("Projects/Acme/Meetings/2026-11-02 Kickoff.md")).toBe("acme");
  });

  it("uses a subnote's note's workspace before the folder's", () => {
    expect(find("Projects/Acme/Work/TEAM-1 Fix.web.md")).toBe("ticket");
    expect(find("Projects/Acme/Work/TEAM-1 Fix.web.notes.md")).toBe("ticket");
    // A version number isn't a subnote key.
    expect(find("Projects/Acme/Work/TEAM-1 Fix.2.md")).toBe("acme");
  });

  it("uses a project overview's workspace", () => {
    expect(find("Projects/Beta/Notes/Idea.md")).toBe("beta");
  });

  it("finds none for notes elsewhere", () => {
    expect(find("Contacts/Jane Doe.md")).toBeUndefined();
    expect(find("Welcome.md")).toBeUndefined();
    expect(find("Projects/Gamma/Gamma.md")).toBeUndefined();
  });
});

describe("subnoteParents", () => {
  it("lists the notes a subnote could be under, nearest first", () => {
    expect(subnoteParents("F/Name.a.b.md")).toEqual(["F/Name.a.md", "F/Name.md"]);
    expect(subnoteParents("Name.transcript.md")).toEqual(["Name.md"]);
    expect(subnoteParents("F/Release 1.2.md")).toEqual([]);
    expect(subnoteParents("F/Plain.md")).toEqual([]);
    expect(subnoteParents("F/page.key.html")).toEqual([]);
  });
});
