import { commandFor, useKeys } from "../state/keys";
import { loadLockSettings } from "../state/locks";
import { useVault } from "../state/vault";
import { runKey } from "./commands";
import { comboOf, usable } from "./keyCombo";

/**
 * App-wide keyboard shortcuts: whatever `state/keys.ts` binds. Returns a
 * cleanup function.
 */
export function installShortcuts(): () => void {
  void useKeys.getState().load();
  void loadLockSettings();
  const onKey = (e: KeyboardEvent) => {
    if (useVault.getState().status !== "vault") return;
    // The settings are recording new keys for a command.
    if (useKeys.getState().recording) return;
    const combo = comboOf(e);
    if (!combo || !usable(combo)) return;
    const id = commandFor(combo);
    if (id && runKey(id, e.target)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
