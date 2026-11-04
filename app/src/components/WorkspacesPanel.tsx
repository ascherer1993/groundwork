import { ArrowRight, Plus, SquareTerminal, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { TerminalInfo } from "../api/generated/TerminalInfo";
import {
  mostUrgent,
  stateOf,
  type TerminalState,
  type TerminalStatus,
  useTerminals,
} from "../state/terminals";
import { confirmDialog, useUi } from "../state/ui";
import { message, useVault } from "../state/vault";
import { NOTES, useWorkspace } from "../state/workspace";
import { useWorkspaces } from "../state/workspaces";

const LABELS: Record<TerminalState, string> = {
  waiting: "Waiting on you",
  finished: "Finished",
  running: "Running",
  idle: "Idle",
};

/** Re-renders every second, for states that depend on time. */
function useTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
}

function Badge({ state }: { state: TerminalState }) {
  return (
    <span
      className={`badge badge-${state}`}
      role="status"
      aria-label={LABELS[state]}
      title={LABELS[state]}
    />
  );
}

/** `~/…` for folders in the home folder. */
function shortPath(path: string, root?: string): string {
  if (root && (path === root || path.startsWith(`${root}/`))) {
    const rest = path.slice(root.length);
    return `vault${rest}`;
  }
  const home = path.match(/^\/Users\/[^/]+/)?.[0];
  return home ? `~${path.slice(home.length)}` : path;
}

function age(started: number): string {
  const s = Math.max(0, Date.now() / 1000 - started);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function isClaude(process: string | null | undefined, title?: string): boolean {
  return process === "claude" || /\bclaude\b/i.test(title ?? "");
}

/** One workspace (or the notes area): its terminal tabs and their states. */
function AreaRow({ area, name, folder }: { area: string; name: string; folder?: string }) {
  useWorkspace((s) => s.tabsVersion);
  const current = useWorkspace((s) => s.area === area);
  const byId = useTerminals((s) => s.byId);
  const root = useVault((s) => s.vault?.path);
  const tabs = useWorkspace
    .getState()
    .terminalTabs()
    .filter((t) => t.area === area);
  const states = tabs.map((t) => stateOf(byId[t.terminal]));
  const workspace = area !== NOTES;

  const menu = (e: React.MouseEvent) => {
    if (!workspace) return;
    e.preventDefault();
    useUi.getState().showMenu(e.clientX, e.clientY, [
      {
        label: "New terminal",
        action: () => switchAnd(area, () => useWorkspace.getState().openTerminal()),
      },
      { label: "Rename…", action: () => void useWorkspaces.getState().rename(area) },
      "separator",
      {
        label: "Delete…",
        danger: true,
        action: () => void useWorkspaces.getState().remove(area),
      },
    ]);
  };

  return (
    <li className="area-item">
      <button
        className={`area-row${current ? " current" : ""}`}
        aria-current={current || undefined}
        title={folder}
        onClick={() => useWorkspace.getState().setArea(area)}
        onContextMenu={menu}
      >
        <span className="area-name">{name}</span>
        {folder && <span className="area-folder">{shortPath(folder, root)}</span>}
        {tabs.length > 0 && <Badge state={mostUrgent(states)} />}
      </button>
      {tabs.length > 0 && (
        <ul className="area-tabs" aria-label={`${name} terminals`}>
          {tabs.map((t, i) => (
            <li key={t.panel.id}>
              <button
                className="area-tab"
                onClick={() => useWorkspace.getState().showTerminal(t.terminal)}
              >
                <SquareTerminal size={12} />
                <span className="area-tab-title">{t.panel.title}</span>
                <Badge state={states[i]!} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function switchAnd(area: string, then: () => unknown) {
  useWorkspace.getState().setArea(area);
  void then();
}

/** Every terminal the daemon runs, in a tab or not, from any vault. */
function Sessions() {
  const tabsVersion = useWorkspace((s) => s.tabsVersion);
  const byId = useTerminals((s) => s.byId);
  const root = useVault((s) => s.vault?.path);
  const [sessions, setSessions] = useState<TerminalInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .terminals()
        .then((all) => {
          if (cancelled) return;
          all.forEach(useTerminals.getState().known);
          setSessions(all);
          setSelected((s) => new Set([...s].filter((id) => all.some((t) => t.id === id))));
        })
        .catch(() => !cancelled && setSessions([]));
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tabsVersion, refresh]);

  if (!sessions) return null;
  const tabs = useWorkspace.getState().terminalTabs();
  const names = Object.fromEntries(useWorkspaces.getState().list.map((w) => [w.id, w.name]));

  const end = async (ids: string[]) => {
    const ok = await confirmDialog({
      title: ids.length === 1 ? "End this terminal?" : `End ${ids.length} terminals?`,
      message: "What’s running in them is stopped.",
      confirmLabel: "End",
      danger: true,
    });
    if (!ok) return;
    try {
      // Tabs showing them close when they exit.
      await Promise.all(ids.map((id) => api.killTerminal(id)));
    } catch (err) {
      useUi.getState().notify(message(err));
    }
    setSelected(new Set());
    setTimeout(() => setRefresh((n) => n + 1), 500);
  };

  return (
    <section className="sessions" aria-label="Running terminals">
      <div className="section-header sessions-header">
        Running terminals
        <span className="count">{sessions.length}</span>
      </div>
      {sessions.length === 0 && <p className="panel-empty muted small">None.</p>}
      <ul className="session-list">
        {sessions.map((t) => {
          const live: TerminalStatus | undefined = byId[t.id];
          const process = live?.process ?? t.process ?? t.program;
          const cwd = live?.cwd ?? t.cwd;
          const tab = tabs.find((x) => x.terminal === t.id);
          const where = tab
            ? tab.area === NOTES
              ? "in Notes"
              : `in ${names[tab.area] ?? "a workspace"}`
            : "not in a tab";
          return (
            <li key={t.id} className="session">
              <input
                type="checkbox"
                aria-label={`Select ${process}`}
                checked={selected.has(t.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(t.id);
                  else next.delete(t.id);
                  setSelected(next);
                }}
              />
              <div className="session-text">
                <div className="session-name">
                  {process}
                  {isClaude(process, t.title) && <span className="session-tag">Claude</span>}
                  {tab && <Badge state={stateOf(live)} />}
                </div>
                <div className="session-meta" title={cwd}>
                  {where} · {shortPath(cwd, root)} · {age(t.started)}
                </div>
              </div>
              {tab ? (
                <button
                  className="icon"
                  aria-label="Go to its tab"
                  title="Go to its tab"
                  onClick={() => useWorkspace.getState().showTerminal(t.id)}
                >
                  <ArrowRight size={13} />
                </button>
              ) : (
                <button
                  className="icon"
                  aria-label="Open in a tab"
                  title="Open in a tab"
                  onClick={() => useWorkspace.getState().addTerminal(t)}
                >
                  <SquareTerminal size={13} />
                </button>
              )}
              <button
                className="icon"
                aria-label="End"
                title="End"
                onClick={() => void end([t.id])}
              >
                <X size={13} />
              </button>
            </li>
          );
        })}
      </ul>
      {selected.size > 0 && (
        <button className="danger-button sessions-end" onClick={() => void end([...selected])}>
          End {selected.size} selected
        </button>
      )}
    </section>
  );
}

/** Workspaces and their terminals, with what each is doing, then every running terminal. */
export function WorkspacesPanel() {
  useTick();
  const workspaces = useWorkspaces((s) => s.list);
  return (
    <div className="workspaces-panel">
      <div className="section-header workspaces-header">
        Workspaces
        <button
          className="icon"
          aria-label="New workspace"
          title="New workspace"
          onClick={() => void useWorkspaces.getState().create()}
        >
          <Plus size={13} />
        </button>
      </div>
      <ul className="area-list" aria-label="Workspaces">
        <AreaRow area={NOTES} name="Notes" />
        {workspaces.map((w) => (
          <AreaRow key={w.id} area={w.id} name={w.name} folder={w.cwd} />
        ))}
      </ul>
      <Sessions />
    </div>
  );
}
