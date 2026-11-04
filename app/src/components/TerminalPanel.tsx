import type { IDockviewPanelProps } from "dockview-react";
import { useContext, useEffect, useRef } from "react";
import { mountTerminal } from "../lib/terminals";
import { vaultLinkProvider } from "../lib/terminalLinks";
import { useTerminals } from "../state/terminals";
import { useVault } from "../state/vault";
import { type TerminalParams, terminalTitle, useWorkspace } from "../state/workspace";
import { AreaContext } from "./Workspace";

/** A terminal tab. Closing the tab ends its session (see `workspace.ts`). */
export function TerminalPanel({ api: panel, params }: IDockviewPanelProps<TerminalParams>) {
  const ref = useRef<HTMLDivElement>(null);
  const area = useContext(AreaContext);
  // The view keeps its own session id once mounted (it changes only when a
  // replacement shell starts), so it mounts once per panel.
  const initial = useRef(params);
  const session = useRef(params.terminal);
  // Kept up to date, so after a reboot the shell restarts where it was.
  const cwd = useRef(params.cwd);
  const title = useRef("");

  useEffect(() => {
    const view = mountTerminal(ref.current!, {
      id: initial.current.terminal,
      cwd: () => cwd.current,
      onTitle: (t) => {
        title.current = t;
        panel.setTitle(terminalTitle(t, cwd.current));
      },
      onExit: () => panel.close(),
      onReplaced: (id) => {
        session.current = id;
        panel.updateParameters({ terminal: id, cwd: cwd.current });
      },
      links: (term) =>
        vaultLinkProvider(
          term,
          () => {
            const { vault, files } = useVault.getState();
            if (!vault) return null;
            const now = useTerminals.getState().byId[session.current]?.cwd;
            return { files: files.map((f) => f.path), root: vault.path, cwd: now ?? cwd.current };
          },
          (path, line) => useWorkspace.getState().open(path, { line }),
        ),
    });
    if (panel.isActive) view.focus();
    const active = panel.onDidActiveChange(({ isActive }) => isActive && view.focus());
    return () => {
      active.dispose();
      view.dispose();
    };
  }, [panel]);

  useEffect(
    () =>
      useTerminals.subscribe((s) => {
        const now = s.byId[session.current]?.cwd;
        if (!now || now === cwd.current) return;
        cwd.current = now;
        panel.updateParameters({ terminal: session.current, cwd: now });
        panel.setTitle(terminalTitle(title.current, now));
      }),
    [panel],
  );

  // Whether it's on screen, for its badge: seen output isn't news.
  useEffect(() => {
    const report = () =>
      useTerminals
        .getState()
        .setVisible(session.current, panel.isVisible && useWorkspace.getState().area === area);
    report();
    const visibility = panel.onDidVisibilityChange(report);
    const unsubscribe = useWorkspace.subscribe((s, before) => s.area !== before.area && report());
    return () => {
      visibility.dispose();
      unsubscribe();
      useTerminals.getState().setVisible(session.current, false);
    };
  }, [panel, area]);

  return (
    <div className="terminal-panel" data-panel-id={panel.id} aria-label="Terminal">
      <div className="terminal-view" ref={ref} />
    </div>
  );
}
