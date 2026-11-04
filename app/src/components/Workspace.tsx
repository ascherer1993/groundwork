import {
  type DockviewReadyEvent,
  DockviewReact,
  type IDockviewPanelProps,
  themeLight,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { FilePlus, Search } from "lucide-react";
import { useWorkspace } from "../state/workspace";
import { useUi } from "../state/ui";
import { FilePanel } from "./FilePanel";

const components = {
  file: FilePanel as (props: IDockviewPanelProps) => React.ReactNode,
};

function Watermark() {
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

/** Tabs and splits for open files. */
export function Workspace() {
  const attach = useWorkspace((s) => s.attach);
  return (
    <DockviewReact
      className="workspace"
      theme={{ ...themeLight, name: "groundwork", className: "dockview-theme-groundwork" }}
      components={components}
      watermarkComponent={Watermark}
      onReady={(e: DockviewReadyEvent) => attach(e.api)}
    />
  );
}
