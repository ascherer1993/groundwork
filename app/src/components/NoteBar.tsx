import { ChevronDown, ExternalLink, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Action } from "../api/generated/Action";
import type { GitState } from "../api/generated/GitState";
import {
  closeTicket,
  type NoteMode,
  noteMode,
  restoreTicket,
  runAction,
  showNote,
  showSplit,
  showWorkspace,
  useTickets,
} from "../state/tickets";
import { useUi } from "../state/ui";
import { onVaultChange } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { useWorkspaces } from "../state/workspaces";

/** The `workspace:` property of a note, following edits. */
function useLinkedWorkspace(path: string): string | undefined {
  const [id, setId] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .note(path)
        .then((note) => {
          const value = note?.frontmatter?.workspace;
          if (!cancelled) setId(typeof value === "string" ? value : undefined);
        })
        .catch(() => {});
    void load();
    const stop = onVaultChange((changes) => {
      if (changes.some((c) => c.path === path)) void load();
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [path]);
  return id;
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
 * Above a ticket's note, or any note with a workspace: the ticket's key,
 * status and git state, Note · Split · Workspace, actions, and close or
 * restore.
 */
export function NoteBar({ path }: { path: string }) {
  const ticket = useTickets((s) => s.tickets.find((t) => t.path === path));
  const linked = useLinkedWorkspace(path);
  const workspaceId = ticket?.workspace ?? linked;
  const workspace = useWorkspaces((s) => s.list.find((w) => w.id === workspaceId));
  useWorkspace((s) => s.area);
  useWorkspace((s) => s.tabsVersion);
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

  if (!ticket && !workspace) return null;
  const mode: NoteMode | null = workspace ? noteMode(path, workspace.id) : null;
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
    <div className="note-bar" role="toolbar" aria-label={ticket ? "Ticket" : "Workspace"}>
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
      {workspace && mode && (
        <div className="segmented" role="group" aria-label="View">
          {(["note", "split", "workspace"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() =>
                void (m === "note"
                  ? showNote(path)
                  : m === "split"
                    ? showSplit(path, workspace.id)
                    : showWorkspace(workspace.id))
              }
            >
              {m === "note" ? "Note" : m === "split" ? "Split" : "Workspace"}
            </button>
          ))}
        </div>
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
