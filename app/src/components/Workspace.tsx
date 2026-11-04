import {
  type DockviewApi,
  type DockviewReadyEvent,
  DockviewReact,
  type IDockviewPanelProps,
  themeLight,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { FilePlus, Plus, Search, SquareTerminal } from "lucide-react";
import { createContext, useEffect, useRef, useState } from "react";
import { NOTES, useWorkspace } from "../state/workspace";
import { useWorkspaces } from "../state/workspaces";
import { useUi } from "../state/ui";
import { FilePanel } from "./FilePanel";
import { TerminalPanel } from "./TerminalPanel";

/** The dock (`NOTES` or a workspace id) a panel belongs to. */
export const AreaContext = createContext<string>(NOTES);

const components = {
  file: FilePanel as (props: IDockviewPanelProps) => React.ReactNode,
  terminal: TerminalPanel as (props: IDockviewPanelProps) => React.ReactNode,
};

function NotesWatermark() {
  const newNote = useWorkspace((s) => s.newNote);
  const setSwitcher = useUi((s) => s.setSwitcher);
  return (
    <div className="watermark">
      <button onClick={() => setSwitcher(true)}>
        <Search size={14} /> Open a file <kbd>⌘O</kbd>
      </button>
      <button onClick={() => void newNote("")}>
        <FilePlus size={14} /> New note <kbd>⌘N</kbd>
      </button>
    </div>
  );
}

function TerminalsWatermark() {
  const openTerminal = useWorkspace((s) => s.openTerminal);
  return (
    <div className="watermark">
      <button onClick={() => void openTerminal()}>
        <SquareTerminal size={14} /> New terminal <kbd>⌘T</kbd>
      </button>
    </div>
  );
}

/** One dock: the notes', or a workspace's terminals. */
function Area({ area, layout, shown }: { area: string; layout?: unknown; shown: boolean }) {
  const attach = useWorkspace((s) => s.attach);
  const [dock, setDock] = useState<DockviewApi | null>(null);
  // The layout it started with: later saves don't reload it.
  const initial = useRef(layout);
  useEffect(() => (dock ? attach(dock, area, initial.current) : undefined), [dock, area, attach]);
  return (
    <AreaContext.Provider value={area}>
      <div className="area" data-area={area} hidden={!shown}>
        <DockviewReact
          className="workspace"
          theme={{ ...themeLight, name: "groundwork", className: "dockview-theme-groundwork" }}
          components={components}
          watermarkComponent={area === NOTES ? NotesWatermark : TerminalsWatermark}
          onReady={(e: DockviewReadyEvent) => setDock(e.api)}
        />
      </div>
    </AreaContext.Provider>
  );
}

/** Shown on the terminal side when there's no workspace yet. */
function NoWorkspace() {
  return (
    <div className="watermark no-workspace">
      <button onClick={() => void useWorkspace.getState().openTerminal()}>
        <SquareTerminal size={14} /> New terminal <kbd>⌘T</kbd>
      </button>
      <button onClick={() => void useWorkspaces.getState().create()}>
        <Plus size={14} /> New workspace
      </button>
    </div>
  );
}

const SPLIT_KEY = "groundwork.notesWidth";

function savedWidth(): number {
  try {
    const n = Number(localStorage.getItem(SPLIT_KEY));
    return n >= 20 && n <= 80 ? n : 50;
  } catch {
    return 50;
  }
}

/** Drags the line between the notes and the terminals. */
function Divider({ onChange }: { onChange: (percent: number) => void }) {
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    const parent = e.currentTarget.parentElement!.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const percent = ((ev.clientX - parent.left) / parent.width) * 100;
      onChange(Math.min(80, Math.max(20, percent)));
    };
    const target = e.currentTarget;
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
  };
  return (
    <div
      className="side-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize notes and terminals"
      onPointerDown={start}
    />
  );
}

/**
 * The main area: the notes dock, and the current workspace's terminals beside
 * it or instead of it. Every workspace's dock stays mounted, so their
 * terminals keep reporting.
 */
export function Workspace() {
  const workspaces = useWorkspaces((s) => s.list);
  const loaded = useWorkspaces((s) => s.loaded);
  const view = useWorkspace((s) => s.view);
  const current = useWorkspace((s) => s.workspace);
  const [width, setWidth] = useState(savedWidth);
  const changeWidth = (percent: number) => {
    setWidth(percent);
    try {
      localStorage.setItem(SPLIT_KEY, String(Math.round(percent)));
    } catch {
      // Not remembered.
    }
  };
  const focus = (side: "notes" | "terminals") => () => useWorkspace.getState().setFocused(side);
  const hasCurrent = workspaces.some((w) => w.id === current);

  return (
    <div
      className={`areas view-${view}`}
      style={{ "--notes-width": `${width}%` } as React.CSSProperties}
    >
      <section
        className="side notes-side"
        aria-label="Notes"
        hidden={view === "terminal"}
        onPointerDownCapture={focus("notes")}
        onFocusCapture={focus("notes")}
      >
        <Area area={NOTES} shown />
      </section>
      {view === "split" && <Divider onChange={changeWidth} />}
      <section
        className="side terminals-side"
        aria-label="Terminals"
        hidden={view === "note"}
        onPointerDownCapture={focus("terminals")}
        onFocusCapture={focus("terminals")}
      >
        {loaded &&
          workspaces.map((w) => (
            <Area key={w.id} area={w.id} layout={w.layout} shown={w.id === current} />
          ))}
        {loaded && !hasCurrent && <NoWorkspace />}
      </section>
    </div>
  );
}
