import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { GitState } from "../api/generated/GitState";
import type { Ticket } from "../api/generated/Ticket";
import { openExternalUrl } from "../lib/fileUrl";
import { closeTicket, noteWorkspace, restoreTicket, showSplit, useTickets } from "../state/tickets";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";

export type TicketGrouping = "project" | "repo" | "status" | "none";

export interface TicketListSpec {
  project?: string;
  repo?: string;
  component?: string;
  /** `active` (default), `closed` or `all`. */
  status?: string;
  group?: TicketGrouping;
  /** Words the key or title must contain. */
  text?: string;
}

function matches(t: Ticket, spec: TicketListSpec, projectId?: string): boolean {
  const status = spec.status ?? "active";
  if (status === "active" && t.status === "closed") return false;
  if (status === "closed" && t.status !== "closed") return false;
  if (projectId && !t.projects.includes(projectId)) return false;
  if (spec.repo && t.repo !== spec.repo) return false;
  if (spec.component && !t.code.includes(spec.component)) return false;
  if (spec.text) {
    const hay = `${t.key ?? ""} ${t.title}`.toLowerCase();
    if (
      !spec.text
        .toLowerCase()
        .split(/\s+/)
        .every((w) => hay.includes(w))
    )
      return false;
  }
  return true;
}

/** Git state, looked up for active tickets with a worktree. */
function useGit(ticket: Ticket): GitState | null {
  const [git, setGit] = useState<GitState | null>(null);
  const active = ticket.status !== "closed" && !!ticket.worktreePath;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void api
      .ticketGit(ticket.path)
      .then((g) => !cancelled && setGit(g))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ticket.path, active]);
  return active ? git : null;
}

function TicketRow({ ticket }: { ticket: Ticket }) {
  const git = useGit(ticket);
  const closed = ticket.status === "closed";
  const title =
    ticket.key && !ticket.title.startsWith(ticket.key)
      ? `${ticket.key} ${ticket.title}`
      : ticket.title;
  const state: string[] = [];
  if (git?.exists) {
    if (git.dirty) state.push("changes");
    if (git.unpushed > 0) state.push(`${git.unpushed} unpushed`);
    if (git.behind > 0) state.push(`${git.behind} behind`);
  } else if (!closed && ticket.worktree && !ticket.worktreePath) {
    state.push("repo not located");
  }

  const openWorkspace = async () => {
    const id = ticket.workspace ?? (await noteWorkspace(ticket.path));
    if (id) await showSplit(ticket.path, id);
  };

  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    useUi
      .getState()
      .showMenu(e.clientX, e.clientY, [
        { label: "Open note", action: () => useWorkspace.getState().open(ticket.path) },
        ...(closed ? [] : [{ label: "Open workspace", action: () => void openWorkspace() }]),
        ...(ticket.url
          ? [{ label: "Open Jira ticket", action: () => void openExternalUrl(ticket.url!) }]
          : []),
        "separator" as const,
        closed
          ? { label: "Restore", action: () => void restoreTicket(ticket.path) }
          : { label: "Close ticket…", action: () => void closeTicket(ticket.path) },
      ]);
  };

  return (
    <li className={`ticket-row${closed ? " is-closed" : ""}`}>
      <button
        type="button"
        className="ticket-open"
        title={ticket.path}
        onClick={() => useWorkspace.getState().open(ticket.path)}
        onContextMenu={menu}
      >
        <span className="ticket-title">{title}</span>
        <span className="ticket-meta">
          {closed ? (
            <span>closed{ticket.closed ? ` ${ticket.closed}` : ""}</span>
          ) : ticket.branch ? (
            <span className="ticket-branch">
              <GitBranch size={11} /> {ticket.branch}
            </span>
          ) : (
            <span>no worktree</span>
          )}
          {state.length > 0 && <span className="ticket-git warn">{state.join(" · ")}</span>}
        </span>
      </button>
    </li>
  );
}

/** Tickets from the index, filtered and grouped. */
export function TicketList({
  spec,
  empty = "No tickets.",
}: {
  spec: TicketListSpec;
  empty?: string;
}) {
  const { tickets, projects, repos, error } = useTickets();
  if (error) return <p className="error">{error}</p>;
  const project = spec.project
    ? projects.find((p) => p.id === spec.project || p.name === spec.project)
    : undefined;
  if (spec.project && !project) return <p className="muted small">No project {spec.project}.</p>;
  const shown = tickets.filter((t) => matches(t, spec, project?.id));
  if (!shown.length) return <p className="muted small">{empty}</p>;

  const group = spec.group ?? "none";
  const groups = new Map<string, Ticket[]>();
  const keyOf = (t: Ticket): string => {
    switch (group) {
      case "project": {
        const id = t.projects[0];
        return id ? (projects.find((p) => p.id === id)?.name ?? id) : "No project";
      }
      case "repo": {
        return t.repo ? (repos.find((r) => r.id === t.repo)?.name ?? t.repo) : "No repo";
      }
      case "status":
        return t.status === "closed" ? "Closed" : "Active";
      default:
        return "";
    }
  };
  for (const t of shown) {
    const k = keyOf(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const names = [...groups.keys()].sort((a, b) =>
    a.startsWith("No ") === b.startsWith("No ") ? a.localeCompare(b) : a.startsWith("No ") ? 1 : -1,
  );

  return (
    <div className="ticket-list">
      {names.map((name) => (
        <section key={name} aria-label={name || "Tickets"}>
          {name && (
            <div className="section-header">
              {name}
              <span className="count">{groups.get(name)!.length}</span>
            </div>
          )}
          <ul>
            {groups.get(name)!.map((t) => (
              <TicketRow key={t.path} ticket={t} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
