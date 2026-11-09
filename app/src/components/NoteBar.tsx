import {
  ChevronDown,
  CornerLeftUp,
  ExternalLink,
  FileText,
  FolderGit2,
  GitBranch,
  LayoutList,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { Action } from "../api/generated/Action";
import type { GitState } from "../api/generated/GitState";
import type { Ticket } from "../api/generated/Ticket";
import {
  addTicketRepo,
  closeTicket,
  openProjectView,
  repoMenuItems,
  repoName,
  restoreTicket,
  runAction,
  useTickets,
} from "../state/tickets";
import { subnoteFamily } from "../lib/subnotes";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";

/**
 * A ticket's repos: its default's name (and how many more), opening a menu
 * with a terminal in each worktree (the default starred), making another the
 * default, and adding one. "Add repo…" for a ticket with none.
 */
function RepoButton({ ticket }: { ticket: Ticket }) {
  const repos = ticket.worktree ? ticket.repos : [];
  // Re-render once repo names load.
  useTickets((s) => s.repos);
  if (!repos.length)
    return (
      <button
        type="button"
        className="note-bar-button"
        title="Make a worktree for this ticket in a repo"
        onClick={() => void addTicketRepo(ticket.path)}
      >
        <FolderGit2 size={12} /> Add repo…
      </button>
    );
  const menu = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const terminalIn = (cwd: string) => {
      const ws = useWorkspace.getState();
      if (ticket.workspace && ws.docks[ticket.workspace])
        ws.showWorkspace(ticket.workspace, ws.view === "note" ? "split" : ws.view);
      void ws.openTerminal(cwd);
    };
    useUi.getState().showMenu(rect.left, rect.bottom + 4, [
      ...repos.map((r, i) => ({
        label: `New terminal in ${repoName(r.id)}`,
        starred: i === 0 && repos.length > 1,
        disabled: !r.worktreePath,
        action: () => r.worktreePath && terminalIn(r.worktreePath),
      })),
      "separator" as const,
      ...repoMenuItems(ticket),
    ]);
  };
  const others = repos.length - 1;
  return (
    <button
      type="button"
      className="note-bar-button"
      title={repos.map((r) => repoName(r.id)).join(", ")}
      aria-label="Repos"
      onClick={menu}
    >
      <FolderGit2 size={12} /> {repoName(repos[0]!.id)}
      {others > 0 && <span className="muted"> +{others}</span>}
      <ChevronDown size={12} />
    </button>
  );
}

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
 * or restore. Above a project's overview note: its project view. Above a
 * subnote, the note it's under; above a note with subnotes, its subnotes.
 */
export function NoteBar({ path }: { path: string }) {
  const ticket = useTickets((s) => s.tickets.find((t) => t.path === path));
  const project = useTickets((s) => s.projects.find((p) => p.overview === path));
  const [git, setGit] = useState<GitState | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const active = !!ticket && ticket.status !== "closed";
  const tree = useVault((s) => s.tree);
  const family = useMemo(() => subnoteFamily(tree, path), [tree, path]);
  const openNote = (target: string, e: React.MouseEvent) =>
    useWorkspace.getState().open(target, { newTab: e.metaKey || e.ctrlKey });

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

  if (!ticket && !project && !family.parent && !family.subnotes.length) return null;
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
    <div
      className="note-bar"
      role="toolbar"
      aria-label={ticket ? "Ticket" : project ? "Project" : "Subnotes"}
    >
      {family.parent && (
        <button
          type="button"
          className="note-bar-button subnote-parent"
          title="The note this is a subnote of"
          onClick={(e) => openNote(family.parent!.node.path, e)}
        >
          <CornerLeftUp size={12} /> {family.parent.node.name.replace(/\.md$/i, "")}
        </button>
      )}
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
          {active && <RepoButton ticket={ticket} />}
        </>
      )}
      <span className="note-bar-spacer" />
      {family.subnotes.map((sub) => (
        <button
          key={sub.node.path}
          type="button"
          className="note-bar-button"
          title={`Subnote: ${sub.node.name.replace(/\.md$/i, "")}`}
          onClick={(e) => openNote(sub.node.path, e)}
        >
          <FileText size={12} /> {sub.key}
        </button>
      ))}
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
