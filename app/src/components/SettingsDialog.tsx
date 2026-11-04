import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { comboOf, displayCombo, usable } from "../lib/keyCombo";
import { bindingOf, KEY_COMMANDS, type KeyCommand, useKeys } from "../state/keys";
import { useUi } from "../state/ui";

const GROUPS = [...new Set(KEY_COMMANDS.map((c) => c.group))];

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  return open ? <SettingsDialogBody /> : null;
}

function SettingsDialogBody() {
  const close = () => {
    useKeys.getState().setRecording(null);
    useUi.getState().setSettingsOpen(false);
  };
  const changed = useKeys((s) => Object.keys(s.overrides).length > 0);
  const [note, setNote] = useState<string | null>(null);

  // On the window: focus may have left the dialog (a button that disabled itself).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useKeys.getState().recording) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className="dialog settings-dialog"
        role="dialog"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>Keyboard shortcuts</h2>
        <p className="muted">
          Click a shortcut, then press the new keys. They need ⌘, ⌃ or ⌥. Backspace clears one.
        </p>
        <div className="settings-keys">
          {GROUPS.map((group) => (
            <section key={group} aria-label={group}>
              <h3>{group}</h3>
              {KEY_COMMANDS.filter((c) => c.group === group).map((c) => (
                <KeyRow key={c.id} command={c} onNote={setNote} />
              ))}
            </section>
          ))}
        </div>
        {note && (
          <p className="settings-note muted" role="status">
            {note}
          </p>
        )}
        <div className="dialog-buttons">
          <button
            type="button"
            disabled={!changed}
            onClick={() => {
              setNote(null);
              void useKeys.getState().resetAll();
            }}
          >
            Reset all
          </button>
          <button type="button" className="primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyRow({
  command,
  onNote,
}: {
  command: KeyCommand;
  onNote: (note: string | null) => void;
}) {
  const combo = useKeys((s) => bindingOf(command.id, s.overrides));
  const changed = useKeys((s) => command.id in s.overrides);
  const recording = useKeys((s) => s.recording === command.id);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (recording) button.current?.focus();
  }, [recording]);

  const record = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    const keys = useKeys.getState();
    if (e.key === "Escape") return keys.setRecording(null);
    if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      keys.setRecording(null);
      onNote(null);
      void keys.bind(command.id, null);
      return;
    }
    const next = comboOf(e.nativeEvent);
    if (!next) return; // A modifier on its own: keep waiting.
    if (!usable(next)) {
      onNote(`${displayCombo(next)} can’t be a shortcut: add ⌘, ⌃ or ⌥.`);
      return;
    }
    keys.setRecording(null);
    void keys.bind(command.id, next).then((displaced) => {
      onNote(
        displaced ? `${displayCombo(next)} was “${displaced}”’s; that has no shortcut now.` : null,
      );
    });
  };

  return (
    <div className="settings-key">
      <span>{command.label}</span>
      <button
        ref={button}
        type="button"
        className={`settings-combo${recording ? " recording" : ""}`}
        aria-label={`Shortcut for ${command.label}`}
        aria-pressed={recording}
        onClick={() => useKeys.getState().setRecording(recording ? null : command.id)}
        onKeyDown={record}
        onBlur={() => recording && useKeys.getState().setRecording(null)}
      >
        {recording ? "Press keys…" : combo ? <kbd>{displayCombo(combo)}</kbd> : "None"}
      </button>
      <button
        type="button"
        className="icon"
        aria-label={`Reset ${command.label}`}
        title="Reset to the default"
        style={{ visibility: changed ? "visible" : "hidden" }}
        onClick={() => {
          onNote(null);
          void useKeys.getState().reset(command.id);
        }}
      >
        <RotateCcw size={12} />
      </button>
    </div>
  );
}
