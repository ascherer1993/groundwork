/**
 * The command log (PLAN §5.10): what was asked from the command bar, when,
 * and how it went, by Claude's account (`groundwork done`). For looking
 * back on: a session that closed can be resumed, to see what it did.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import { api } from "../api/client";
import type { CommandEntry } from "../api/generated/CommandEntry";
import { resumeSession } from "../state/commandBar";
import { message } from "../state/vault";
import { useWorkspace } from "../state/workspace";

export const useCommandLog = create<{ open: boolean }>(() => ({ open: false }));

export function showCommandLog() {
  useCommandLog.setState({ open: true });
}

const OUTCOMES = {
  done: "Done",
  needsYou: "Needs you",
  failed: "Failed",
} as const;

function when(asked: string): string {
  const date = new Date(asked);
  if (Number.isNaN(date.getTime())) return asked;
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function pointedAt(e: CommandEntry): string | null {
  const c = e.context;
  const parts = [
    c.note && c.note.replace(/^.*\//, "").replace(/\.md$/, ""),
    c.project,
    c.workspace,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export function CommandLog() {
  const open = useCommandLog((s) => s.open);
  return open ? <CommandLogBody /> : null;
}

function CommandLogBody() {
  const close = () => useCommandLog.setState({ open: false });
  const [entries, setEntries] = useState<CommandEntry[] | { error: string } | null>(null);
  useEffect(() => {
    api.commandLog().then(setEntries, (err) => setEntries({ error: message(err) }));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const tabs = new Set(
    useWorkspace
      .getState()
      .terminalTabs()
      .map((t) => t.terminal),
  );

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className="dialog command-log"
        role="dialog"
        aria-label="Command log"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>Command log</h2>
        <p className="muted">What you asked from the command bar, and what Claude says it did.</p>
        {entries === null ? (
          <p className="muted">Loading…</p>
        ) : "error" in entries ? (
          <p className="error" role="alert">
            {entries.error}
          </p>
        ) : entries.length === 0 ? (
          <p className="muted">Nothing asked from the command bar yet.</p>
        ) : (
          <ul className="command-log-list" aria-label="Requests">
            {entries.map((e) => {
              const about = pointedAt(e);
              const tabOpen = !!e.tab && tabs.has(e.tab);
              return (
                <li key={e.id} className="command-log-entry">
                  <div className="command-log-meta">
                    <span
                      className={`command-log-outcome outcome-${e.outcome ?? "none"}`}
                      title={e.finished ? `Finished ${new Date(e.finished).toLocaleString()}` : ""}
                    >
                      {e.outcome ? OUTCOMES[e.outcome] : "No outcome yet"}
                    </span>
                    <span>{e.shown ? "Shown" : "In the background"}</span>
                    {e.outcome && <span>{e.closed ? "Tab closed" : "Tab left open"}</span>}
                    <span className="command-log-when" title={new Date(e.asked).toLocaleString()}>
                      {when(e.asked)}
                    </span>
                  </div>
                  <p className="command-log-prompt">{e.prompt}</p>
                  {e.summary && <p className="command-log-summary">{e.summary}</p>}
                  {about && <p className="command-log-about">Pointed at {about}</p>}
                  {(tabOpen || e.session) && (
                    <div className="command-log-actions">
                      {tabOpen ? (
                        <button
                          className="link-button"
                          onClick={() => {
                            close();
                            useWorkspace.getState().showTerminal(e.tab!);
                          }}
                        >
                          Show its tab
                        </button>
                      ) : (
                        <button
                          className="link-button"
                          title={`claude --resume ${e.session}`}
                          onClick={() => {
                            close();
                            void resumeSession(e.session!);
                          }}
                        >
                          Resume the session
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="dialog-buttons">
          <button onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
