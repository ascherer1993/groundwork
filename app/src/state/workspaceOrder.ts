/**
 * The order workspaces are listed in, which ⌘1–9, "Switch workspace…" and
 * stepping through them follow too: pinned ones first, then each group
 * (by project or repo, as the Workspaces view groups them), each in the
 * order you've put them.
 */
import { create } from "zustand";
import type { ProjectInfo } from "../api/generated/ProjectInfo";
import type { RepoInfo } from "../api/generated/RepoInfo";
import type { Ticket } from "../api/generated/Ticket";
import type { Workspace } from "../api/generated/Workspace";
import { useTickets } from "./tickets";
import { useWorkspaces } from "./workspaces";

export type Grouping = "project" | "repo" | "none";
const GROUP_KEY = "groundwork.workspacesGroup";

function savedGrouping(): Grouping {
  try {
    const g = localStorage.getItem(GROUP_KEY);
    return g === "repo" || g === "none" ? g : "project";
  } catch {
    return "project";
  }
}

export const useGrouping = create<{ grouping: Grouping; setGrouping(g: Grouping): void }>(
  (set) => ({
    grouping: savedGrouping(),
    setGrouping(grouping) {
      set({ grouping });
      try {
        localStorage.setItem(GROUP_KEY, grouping);
      } catch {
        // Not remembered.
      }
    },
  }),
);

export interface Section {
  /** "Pinned", a project's or repo's name, "Other", or "" when not grouped. */
  name: string;
  pinned: boolean;
  workspaces: Workspace[];
}

/**
 * A workspace belongs to its note's ticket's home project (or repo), or to
 * the project folder its note is in.
 */
function groupOf(
  w: Workspace,
  grouping: Grouping,
  tickets: Ticket[],
  projects: ProjectInfo[],
  repos: RepoInfo[],
): string {
  if (grouping === "none") return "";
  const ticket = w.note ? tickets.find((t) => t.path === w.note) : undefined;
  if (grouping === "repo") {
    const repo = ticket?.repo;
    return repo ? (repos.find((r) => r.id === repo)?.name ?? repo) : "Other";
  }
  const id =
    ticket?.projects[0] ??
    projects
      .filter((p) => w.note?.startsWith(`${p.folder}/`))
      .sort((a, b) => b.folder.length - a.folder.length)[0]?.id;
  return id ? (projects.find((p) => p.id === id)?.name ?? id) : "Other";
}

export function sections(
  list: Workspace[],
  grouping: Grouping,
  tickets: Ticket[],
  projects: ProjectInfo[],
  repos: RepoInfo[],
): Section[] {
  const pinned = list.filter((w) => w.pinned);
  const groups = new Map<string, Workspace[]>();
  for (const w of list) {
    if (w.pinned) continue;
    const g = groupOf(w, grouping, tickets, projects, repos);
    groups.set(g, [...(groups.get(g) ?? []), w]);
  }
  const names = [...groups.keys()].sort((a, b) =>
    a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b),
  );
  // "Other" alone isn't a grouping worth showing.
  const plain = names.length === 1 && names[0] === "Other";
  return [
    ...(pinned.length ? [{ name: "Pinned", pinned: true, workspaces: pinned }] : []),
    ...names.map((name) => ({
      name: plain ? "" : name,
      pinned: false,
      workspaces: groups.get(name)!,
    })),
  ];
}

/** The sections as they are now. */
export function currentSections(): Section[] {
  const { tickets, projects, repos } = useTickets.getState();
  return sections(
    useWorkspaces.getState().list,
    useGrouping.getState().grouping,
    tickets,
    projects,
    repos,
  );
}

/** Every workspace, in the order they're listed. */
export function orderedWorkspaces(): Workspace[] {
  return currentSections().flatMap((s) => s.workspaces);
}

/** The sections, kept up to date. */
export function useSections(): Section[] {
  const list = useWorkspaces((s) => s.list);
  const grouping = useGrouping((s) => s.grouping);
  const { tickets, projects, repos } = useTickets();
  return sections(list, grouping, tickets, projects, repos);
}
