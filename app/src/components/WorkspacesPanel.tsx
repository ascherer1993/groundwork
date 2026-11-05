import { ChevronRight, Plus, SquareTerminal, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { TerminalInfo } from "../api/generated/TerminalInfo";
import type { Workspace } from "../api/generated/Workspace";
import { showTerminalMenu } from "../state/claude";
import { useKeyLabel } from "../state/keys";
import { showSplit, useTickets } from "../state/tickets";
import {
  mostUrgent,
  stateOf,
  type TerminalState,
  type TerminalStatus,
  useTerminals,
} from "../state/terminals";
import { confirmDialog, useUi } from "../state/ui";
import { message, useVault } from "../state/vault";
import { shownTerminal, useWorkspace } from "../state/workspace";
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

const EXPANDED_KEY = "groundwork.workspacesExpanded";

/** The workspaces whose terminals you've listed; the rest are folded. */
function expandedAreas(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function setExpanded(area: string, open: boolean) {
  const areas = expandedAreas();
  if (open) areas.add(area);
  else areas.delete(area);
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...areas]));
  } catch {
    // Not remembered.
  }
}

/** One workspace: its shortcut, its terminal tabs (folded unless you open them) and their states. */
function AreaRow({
  area,
  name,
  folder,
  index,
}: {
  area: string;
  name: string;
  folder?: string;
  index: number;
}) {
  useWorkspace((s) => s.tabsVersion);
  const [open, setOpen] = useState(() => expandedAreas().has(area));
  const shortcut = useKeyLabel(`workspace-${index + 1}`);
  const current = useWorkspace((s) => s.workspace === area && s.view !== "note");
  const shown = useWorkspace(shownTerminal);
  const byId = useTerminals((s) => s.byId);
  const root = useVault((s) => s.vault?.path);
  const tabs = useWorkspace
    .getState()
    .terminalTabs()
    .filter((t) => t.area === area);
  const states = tabs.map((t) => stateOf(byId[t.terminal]));

  const menu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const { clientX: x, clientY: y } = e;
    // A ticket's workspace offers a terminal in each component it touches.
    const note = useWorkspaces.getState().list.find((w) => w.id === area)?.note;
    const context = note ? await api.context({ note }).catch(() => null) : null;
    const components = (context?.components ?? []).filter((c) => c.absPath);
    useUi.getState().showMenu(x, y, [
      {
        label: "New terminal",
        action: () => switchAnd(area, () => useWorkspace.getState().openTerminal()),
      },
      ...components.map((c) => ({
        label: `New terminal in ${c.id.slice(c.id.indexOf(":") + 1)}`,
        action: () => switchAnd(area, () => useWorkspace.getState().openTerminal(c.absPath!)),
      })),
      ...(note ? [{ label: "Open note", action: () => void showSplit(note, area) }] : []),
      { label: "Rename…", action: () => void useWorkspaces.getState().rename(area) },
      {
        label: "Change folder…",
        action: () => void useWorkspaces.getState().changeFolder(area),
      },
      "separator",
      {
        label: "Delete…",
        danger: true,
        action: () => void useWorkspaces.getState().remove(area),
      },
    ]);
  };

  const toggle = () => {
    setExpanded(area, !open);
    setOpen(!open);
  };

  return (
    <li className="area-item">
      <div className="area-head">
        <button
          className={`area-row${current ? " current" : ""}`}
          aria-current={current || undefined}
          title={folder}
          onClick={() => useWorkspaces.getState().pick(area)}
          onContextMenu={(e) => void menu(e)}
        >
          <span className="area-name">{name}</span>
          {folder && <span className="area-folder">{shortPath(folder, root)}</span>}
          {tabs.length > 0 && <Badge state={mostUrgent(states)} />}
          {shortcut && (
            <kbd className="area-key" title={`Switch to ${name} (${shortcut})`}>
              {shortcut}
            </kbd>
          )}
        </button>
        {tabs.length > 0 && (
          <button
            className={`area-toggle${open ? " open" : ""}`}
            aria-expanded={open}
            aria-label={open ? `Hide ${name}’s terminals` : `Show ${name}’s terminals`}
            title={
              open
                ? "Hide terminals"
                : `Show ${tabs.length === 1 ? "1 terminal" : `${tabs.length} terminals`}`
            }
            onClick={toggle}
          >
            <ChevronRight size={12} />
          </button>
        )}
      </div>
      {open && tabs.length > 0 && (
        <ul className="area-tabs" aria-label={`${name} terminals`}>
          {tabs.map((t, i) => (
            <li key={t.panel.id}>
              <button
                className={`area-tab${t.terminal === shown ? " current" : ""}`}
                aria-current={t.terminal === shown || undefined}
                onClick={() => useWorkspace.getState().showTerminal(t.terminal)}
                onContextMenu={(e) => showTerminalMenu(e, t.terminal)}
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
  useWorkspace.getState().showWorkspace(area);
  void then();
}

/** Every terminal the daemon runs, in a tab or not, from any vault. */
function Sessions() {
  const tabsVersion = useWorkspace((s) => s.tabsVersion);
  const byId = useTerminals((s) => s.byId);
  const root = useVault((s) => s.vault?.path);
  const shown = useWorkspace(shownTerminal);
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
          const where = tab ? `in ${names[tab.area] ?? "a workspace"}` : "not in a tab";
          const go = () =>
            tab
              ? useWorkspace.getState().showTerminal(t.id)
              : void useWorkspace.getState().addTerminal(t);
          return (
            <li
              key={t.id}
              className={`session${t.id === shown ? " current" : ""}`}
              aria-current={t.id === shown || undefined}
              // The row's edges count too; its checkbox and End button don't.
              onClick={(e) => e.target === e.currentTarget && go()}
            >
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
              {/* The row goes to its tab, or opens one for it. */}
              <button
                type="button"
                className="session-text"
                title={tab ? `Go to its tab · ${cwd}` : `Open in a tab · ${cwd}`}
                onClick={go}
              >
                <span className="session-name">
                  {process}
                  {isClaude(process, t.title) && <span className="session-tag">Claude</span>}
                  {tab && <Badge state={stateOf(live)} />}
                </span>
                <span className="session-meta">
                  {where} · {shortPath(cwd, root)} · {age(t.started)}
                </span>
              </button>
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

type Grouping = "project" | "repo" | "none";
const GROUP_KEY = "groundwork.workspacesGroup";

function savedGrouping(): Grouping {
  try {
    const g = localStorage.getItem(GROUP_KEY);
    return g === "repo" || g === "none" ? g : "project";
  } catch {
    return "project";
  }
}

/** Workspaces and their terminals, with what each is doing, then every running terminal. */
export function WorkspacesPanel() {
  useTick();
  const workspaces = useWorkspaces((s) => s.list);
  const { tickets, projects, repos } = useTickets();
  const [grouping, setGrouping] = useState<Grouping>(savedGrouping);

  // A workspace belongs to its note's ticket's home project (or repo), or
  // to the project folder its note is in.
  const groupOf = (w: Workspace): string => {
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
  };
  const groups = new Map<string, Workspace[]>();
  for (const w of workspaces) {
    const g = groupOf(w);
    groups.set(g, [...(groups.get(g) ?? []), w]);
  }
  const names = [...groups.keys()].sort((a, b) =>
    a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b),
  );
  const grouped = names.length > 1 || (names[0] ?? "") !== "Other";

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
      {workspaces.length > 1 && (
        <div className="tickets-controls">
          <label>
            Group by{" "}
            <select
              value={grouping}
              onChange={(e) => {
                const g = e.target.value as Grouping;
                setGrouping(g);
                try {
                  localStorage.setItem(GROUP_KEY, g);
                } catch {
                  // Not remembered.
                }
              }}
            >
              <option value="project">Project</option>
              <option value="repo">Repo</option>
              <option value="none">Nothing</option>
            </select>
          </label>
        </div>
      )}
      <ul className="area-list" aria-label="Workspaces">
        {names.map((name) => (
          <li key={name || "all"} className="area-group">
            {grouped && name && <div className="area-group-name">{name}</div>}
            <ul className="area-list">
              {groups.get(name)!.map((w) => (
                <AreaRow
                  key={w.id}
                  area={w.id}
                  name={w.name}
                  folder={w.cwd}
                  index={workspaces.indexOf(w)}
                />
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <Sessions />
    </div>
  );
}
