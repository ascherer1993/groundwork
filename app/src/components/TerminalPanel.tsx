import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef } from "react";
import { mountTerminal } from "../lib/terminals";
import { type TerminalParams, terminalTitle } from "../state/workspace";

/** A terminal tab. Closing the tab ends its session (see `workspace.ts`). */
export function TerminalPanel({ api: panel, params }: IDockviewPanelProps<TerminalParams>) {
  const ref = useRef<HTMLDivElement>(null);
  // The view keeps its own session id once mounted (it changes only when a
  // replacement shell starts), so it mounts once per panel.
  const initial = useRef(params);

  useEffect(() => {
    const { terminal, cwd } = initial.current;
    const view = mountTerminal(ref.current!, {
      id: terminal,
      cwd,
      onTitle: (title) => panel.setTitle(terminalTitle(title, cwd)),
      onExit: () => panel.close(),
      onReplaced: (id) => panel.updateParameters({ terminal: id, cwd }),
    });
    if (panel.isActive) view.focus();
    const active = panel.onDidActiveChange(({ isActive }) => isActive && view.focus());
    return () => {
      active.dispose();
      view.dispose();
    };
  }, [panel]);

  return (
    <div className="terminal-panel" data-panel-id={panel.id} aria-label="Terminal">
      <div className="terminal-view" ref={ref} />
    </div>
  );
}
