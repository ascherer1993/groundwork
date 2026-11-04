import {
  type DockviewApi,
  type DockviewReadyEvent,
  DockviewReact,
  type IDockviewPanelProps,
  themeLight,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { FilePlus, Search, SquareTerminal } from "lucide-react";
import { createContext, useEffect, useRef, useState } from "react";
import { useWorkspace, NOTES } from "../state/workspace";
import { useWorkspaces } from "../state/workspaces";
import { useUi } from "../state/ui";
import { FilePanel } from "./FilePanel";
import { TerminalPanel } from "./TerminalPanel";

/** The area (`NOTES` or a workspace id) a panel belongs to. */
export const AreaContext = createContext<string>(NOTES);

const components = {
  file: FilePanel as (props: IDockviewPanelProps) => React.ReactNode,
  terminal: TerminalPanel as (props: IDockviewPanelProps) => React.ReactNode,
};

function Watermark() {
  const newNote = useWorkspace((s) => s.newNote);
  const openTerminal = useWorkspace((s) => s.openTerminal);
  const setSwitcher = useUi((s) => s.setSwitcher);
  const inWorkspace = useWorkspace((s) => s.area !== NOTES);
  const terminal = (
    <button key="terminal" onClick={() => void openTerminal()}>
      <SquareTerminal size={14} /> New terminal <kbd>⌘T</kbd>
    </button>
  );
  return (
    <div className="watermark">
      {inWorkspace && terminal}
      <button onClick={() => setSwitcher(true)}>
        <Search size={14} /> Open a file <kbd>⌘O</kbd>
      </button>
      <button onClick={() => void newNote("")}>
        <FilePlus size={14} /> New note <kbd>⌘N</kbd>
      </button>
      {!inWorkspace && terminal}
    </div>
  );
}

/** One area's tabs and splits. */
function Area({ area, layout }: { area: string; layout?: unknown }) {
  const attach = useWorkspace((s) => s.attach);
  const shown = useWorkspace((s) => s.area === area);
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
          watermarkComponent={Watermark}
          onReady={(e: DockviewReadyEvent) => setDock(e.api)}
        />
      </div>
    </AreaContext.Provider>
  );
}

/**
 * The main area: the notes layout and each workspace's, one on screen at a
 * time. The others stay mounted, so their terminals keep reporting.
 */
export function Workspace() {
  const workspaces = useWorkspaces((s) => s.list);
  const loaded = useWorkspaces((s) => s.loaded);
  return (
    <div className="areas">
      <Area area={NOTES} />
      {loaded && workspaces.map((w) => <Area key={w.id} area={w.id} layout={w.layout} />)}
    </div>
  );
}
