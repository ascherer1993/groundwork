/**
 * The terminals follow the notes: when a note opens, its workspace becomes
 * the current one, unless the current one is pinned. A note's workspace is
 * its own, else the nearest one above it (a folder note's, like
 * `Acme/Acme.md`, or a project overview's); with neither, nothing changes.
 */
import type { ProjectInfo } from "../api/generated/ProjectInfo";
import type { Workspace } from "../api/generated/Workspace";
import { projectOfView } from "../lib/paths";
import { useTickets } from "./tickets";
import { useWorkspace } from "./workspace";
import { useWorkspaces } from "./workspaces";

const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The workspace a note belongs to, if any. */
export function workspaceFor(
  path: string,
  workspaces: Workspace[],
  projects: ProjectInfo[],
): Workspace | undefined {
  const own = workspaces.find((w) => w.note === path);
  if (own) return own;
  for (let folder = parent(path); folder; folder = parent(folder)) {
    const notes = new Set([`${folder}/${base(folder)}.md`]);
    for (const p of projects) if (p.folder === folder && p.overview) notes.add(p.overview);
    const above = workspaces.find((w) => w.note && notes.has(w.note));
    if (above) return above;
  }
  return undefined;
}

/** Makes the open note's workspace the current one, unless it's pinned. */
export function follow() {
  const ws = useWorkspace.getState();
  if (ws.pinned || !ws.activePath) return;
  // A project's view follows like its overview note.
  const project = projectOfView(ws.activePath);
  const projects = useTickets.getState().projects;
  const path = project ? projects.find((p) => p.id === project)?.overview : ws.activePath;
  if (!path) return;
  const target = workspaceFor(path, useWorkspaces.getState().list, projects);
  // The view stays as it is: following never brings terminals on screen.
  if (target && target.id !== ws.workspace) ws.showWorkspace(target.id, ws.view);
}

let watching = false;

/** Starts following (once per app). */
export function watchFollow() {
  if (watching) return;
  watching = true;
  useWorkspace.subscribe((s, before) => {
    if (s.activePath !== before.activePath || (before.pinned && !s.pinned)) follow();
  });
  // Workspaces and projects load after the notes do. (Only then: later
  // changes to the lists shouldn't undo a workspace you picked.)
  useWorkspaces.subscribe((s, before) => s.loaded && !before.loaded && follow());
  useTickets.subscribe((s, before) => s.projects.length > 0 && !before.projects.length && follow());
}
