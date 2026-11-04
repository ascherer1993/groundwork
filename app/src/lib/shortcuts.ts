import { undoLast } from "../components/NoteView";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { useWorkspaces } from "../state/workspaces";
import { openCommandPalette, openToday } from "./commands";

function inEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    !!target.closest(".cm-editor")
  );
}

/** App-wide keyboard shortcuts. Returns a cleanup function. */
export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (useVault.getState().status !== "vault") return;
    // ⌘ only: Ctrl+N/P move through lists, as elsewhere on macOS.
    if (!e.metaKey || e.altKey) return;
    const ws = useWorkspace.getState();
    const ui = useUi.getState();
    const key = e.key.toLowerCase();

    const handled = (() => {
      if (key === "o" && !e.shiftKey) return (ui.setSwitcher(true), true);
      if (key === "p" && !e.shiftKey) return (openCommandPalette(), true);
      if (key === "d" && e.shiftKey) return (void openToday(), true);
      if (key === "f" && e.shiftKey) return (ui.searchFor(), true);
      if (key === "n" && !e.shiftKey) return (void ws.newNote(), true);
      if (key === "t" && !e.shiftKey) return (void ws.openTerminal(), true);
      if (key === "e" && !e.shiftKey) return (ws.toggleReading(), true);
      if (key === "w" && !e.shiftKey) return (ws.closeActive(), true);
      if (key === "b" && e.shiftKey) return (ui.toggleRightPanel(), true);
      // ⌃⌘1–3: notes, notes and terminals, terminals.
      if (e.ctrlKey && /^Digit[1-3]$/.test(e.code)) {
        const views = ["note", "split", "terminal"] as const;
        ws.setView(views[Number(e.code.slice(5)) - 1]!);
        return true;
      }
      // ⌘1… the workspaces in order.
      if (/^[1-9]$/.test(key) && !e.shiftKey && !e.ctrlKey) {
        const id = useWorkspaces.getState().list[Number(key) - 1]?.id;
        if (id) useWorkspaces.getState().pick(id);
        return true;
      }
      if (key === "[") return (ws.back(), true);
      if (key === "]") return (ws.forward(), true);
      if (key === "\\") {
        const path = ws.activePath;
        if (path) ws.open(path, { split: "right" });
        return true;
      }
      // Outside editors, ⌘Z undoes the last file operation (rename, move…).
      if (key === "z" && !e.shiftKey && !inEditable(e.target)) return (void undoLast(), true);
      return false;
    })();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
