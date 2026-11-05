import { ChevronDown, ExternalLink, GitBranch, LayoutList } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Action } from "../api/generated/Action";
import type { GitState } from "../api/generated/GitState";
import {
  closeTicket,
  openProjectView,
  restoreTicket,
  runAction,
  useTickets,
} from "../state/tickets";
import { useUi } from "../state/ui";

function gitSummary(git: GitState): { text: string; warn: boolean } {
  const parts: string[] = [];
  if (git.dirty) parts.push("uncommitted changes");
  if (git.unpushed > 0) parts.push(`${git.unpushed} unpushed`);
  else if (!git.onRemote) parts.push("not pushed");
  if (git.behind > 0) parts.push(`${git.behind} behind`);
  return { text: parts.join(" · ") || "clean", warn: git.dirty || git.unpushed > 0 };
}

/**
 * Above a ticket's note: its key, status and git state, actions, and close
 * or restore. Above a project's overview note: its project view.
 */
export function NoteBar({ path }: { path: string }) {
  const ticket = useTickets((s) => s.tickets.find((t) => t.path === path));
  const project = useTickets((s) => s.projects.find((p) => p.overview === path));
  const [git, setGit] = useState<GitState | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const active = !!ticket && ticket.status !== "closed";

  const isTicket = !!ticket;
  const worktreePath = ticket?.worktreePath;
  useEffect(() => {
    if (!isTicket) return;
    let cancelled = false;
    const load = () => {
      if (worktreePath && active)
        void api
          .ticketGit(path)
          .then((g) => !cancelled && setGit(g))
          .catch(() => {});
      else setGit(null);
      void api
        .context({ note: path })
        .then((c) => !cancelled && setActions(c.actions))
        .catch(() => {});
    };
    load();
    // Git changes outside the vault (commits, pushes), so check now and then.
    const timer = setInterval(load, 15_000);
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [path, isTicket, worktreePath, active]);

  if (!ticket && !project) return null;
  const quick = actions.filter((a) => a.id === "open-ticket" || a.id === "open-vscode");
  const summary = git?.exists ? gitSummary(git) : null;

  const actionsMenu = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    useUi.getState().showMenu(
      rect.left,
      rect.bottom + 4,
      actions.map((a) => ({ label: a.label, action: () => void runAction(a, path) })),
    );
  };

  return (
    <div className="note-bar" role="toolbar" aria-label={ticket ? "Ticket" : "Project"}>
      {ticket && (
        <>
          {ticket.key && <span className="ticket-key">{ticket.key}</span>}
          <span className={`ticket-status status-${active ? "active" : "closed"}`}>
            {active ? "Active" : "Closed"}
          </span>
          {ticket.branch && active && (
            <span className="ticket-branch" title={ticket.worktreePath ?? undefined}>
              <GitBranch size={12} /> {ticket.branch}
            </span>
          )}
          {summary && (
            <span className={`ticket-git${summary.warn ? " warn" : ""}`} aria-label="Git state">
              {summary.text}
            </span>
          )}
          {active && ticket.repo && ticket.worktree && !ticket.worktreePath && (
            <span className="ticket-git warn">repo not located here</span>
          )}
        </>
      )}
      <span className="note-bar-spacer" />
      {project && (
        <button
          type="button"
          className="note-bar-button"
          title="This project’s events, people and tickets"
          onClick={(e) => openProjectView(project.id, { newTab: e.metaKey })}
        >
          <LayoutList size={12} /> Project view
        </button>
      )}
      {quick.map((a) => (
        <button
          key={a.id}
          type="button"
          className="note-bar-button"
          onClick={() => void runAction(a, path)}
        >
          {a.id === "open-ticket" && <ExternalLink size={12} />} {a.label}
        </button>
      ))}
      {actions.length > quick.length && (
        <button type="button" className="note-bar-button" onClick={actionsMenu}>
          Actions <ChevronDown size={12} />
        </button>
      )}
      {ticket &&
        (active ? (
          <button type="button" className="note-bar-button" onClick={() => void closeTicket(path)}>
            Close ticket…
          </button>
        ) : (
          <button
            type="button"
            className="note-bar-button"
            onClick={() => void restoreTicket(path)}
          >
            Restore
          </button>
        ))}
    </div>
  );
}
