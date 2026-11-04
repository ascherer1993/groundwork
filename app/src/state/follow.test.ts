import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "../api/generated/ProjectInfo";
import type { Workspace } from "../api/generated/Workspace";
import { workspaceFor } from "./follow";

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
  workFolder: `${folder}/Work`,
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

  it("uses a project overview's workspace", () => {
    expect(find("Projects/Beta/Notes/Idea.md")).toBe("beta");
  });

  it("finds none for notes elsewhere", () => {
    expect(find("Contacts/Jane Doe.md")).toBeUndefined();
    expect(find("Welcome.md")).toBeUndefined();
    expect(find("Projects/Gamma/Gamma.md")).toBeUndefined();
  });
});
