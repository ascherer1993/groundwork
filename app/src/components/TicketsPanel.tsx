import { Plus, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { StrayWorktree } from "../api/generated/StrayWorktree";
import { newTicketFromJira } from "../state/claude";
import { useTickets } from "../state/tickets";
import { onVaultChange } from "../state/vault";
import { type TicketGrouping, TicketList } from "./TicketList";

const GROUP_KEY = "groundwork.ticketsGroup";

function savedGroup(): TicketGrouping {
  try {
    const g = localStorage.getItem(GROUP_KEY);
    return g === "repo" || g === "status" || g === "none" ? g : "project";
  } catch {
    return "project";
  }
}

/** Worktrees with no ticket note, made outside Groundwork. */
function Strays() {
  const [strays, setStrays] = useState<StrayWorktree[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void api
        .strayWorktrees()
        .then((s) => !cancelled && setStrays(s))
        .catch(() => {});
    load();
    const stop = onVaultChange(load);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);
  if (!strays.length) return null;
  return (
    <section className="strays" aria-label="Worktrees without a ticket">
      <div className="section-header">
        Worktrees without a ticket
        <span className="count">{strays.length}</span>
      </div>
      <ul>
        {strays.map((s) => (
          <li key={s.path} className="stray" title={s.path}>
            <span className="stray-name">{s.path.slice(s.path.lastIndexOf("/") + 1)}</span>
            <span className="muted small">{s.repo}</span>
            <button
              type="button"
              className="note-bar-button"
              onClick={() =>
                void useTickets
                  .getState()
                  .newTicket({ adopt: s.path, repo: s.repo, key: s.key ?? undefined })
              }
            >
              Adopt
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every ticket, grouped by project, repo or status, plus stray worktrees. */
export function TicketsPanel() {
  const [text, setText] = useState("");
  const [group, setGroup] = useState<TicketGrouping>(savedGroup);
  const [closed, setClosed] = useState(false);
  const choose = (g: TicketGrouping) => {
    setGroup(g);
    try {
      localStorage.setItem(GROUP_KEY, g);
    } catch {
      // Not remembered.
    }
  };

  return (
    <div className="tickets-panel">
      <div className="section-header workspaces-header">
        Tickets
        <button
          className="icon"
          aria-label="New ticket from Jira"
          title="New ticket from Jira: Claude reads the issue and sets it up"
          onClick={() => void newTicketFromJira()}
        >
          <Sparkles size={13} />
        </button>
        <button
          className="icon"
          aria-label="New ticket"
          title="New ticket"
          onClick={() => void useTickets.getState().newTicket()}
        >
          <Plus size={13} />
        </button>
      </div>
      <input
        className="search-input"
        type="search"
        aria-label="Filter tickets"
        placeholder="Filter…"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="tickets-controls">
        <label>
          Group by{" "}
          <select value={group} onChange={(e) => choose(e.target.value as TicketGrouping)}>
            <option value="project">Project</option>
            <option value="repo">Repo</option>
            <option value="status">Status</option>
            <option value="none">Nothing</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
          Closed
        </label>
      </div>
      <TicketList
        spec={{ group, text: text.trim() || undefined, status: closed ? "all" : "active" }}
        empty={closed ? "No tickets." : "No active tickets."}
      />
      <Strays />
    </div>
  );
}
