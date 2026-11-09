import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { QuickAddChoice } from "../api/generated/QuickAddChoice";
import { comboOf, displayCombo, usable } from "../lib/keyCombo";
import { allCommands, bindingOf, type KeyCommand, useKeys } from "../state/keys";
import { useLocks } from "../state/locks";
import { choiceCommand, useQuickAdd } from "../state/quickadd";
import { useUi } from "../state/ui";
import { SearchSettings } from "./SearchSettings";

/**
 * Settings has a section per feature, down its side. A feature's section
 * holds its settings; Keyboard shortcuts lists every feature's commands.
 */
const SECTIONS = ["Quick add", "Search", "Encrypted notes", "Keyboard shortcuts"] as const;
export type Section = (typeof SECTIONS)[number];

/** The section last shown, while the app runs. */
let lastSection: Section = SECTIONS[0];

/** Opens Settings at a section. */
export function showSettings(section: Section) {
  lastSection = section;
  useUi.getState().setSettingsOpen(true);
}

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  return open ? <SettingsDialogBody /> : null;
}

function SettingsDialogBody() {
  const close = () => {
    useKeys.getState().setRecording(null);
    useUi.getState().setSettingsOpen(false);
  };
  const [section, show] = useState<Section>(lastSection);
  useEffect(() => {
    lastSection = section;
  }, [section]);

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
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={s === section ? "current" : undefined}
              aria-current={s === section || undefined}
              onClick={() => show(s)}
            >
              {s}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {section === "Quick add" ? (
            <QuickAddSettings />
          ) : section === "Search" ? (
            <SearchSettings />
          ) : section === "Encrypted notes" ? (
            <EncryptionSettings />
          ) : (
            <ShortcutSettings />
          )}
          <div className="dialog-buttons">
            <button type="button" className="primary" onClick={close}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Encrypted notes -------------------------------------------------------

function EncryptionSettings() {
  const minutes = useLocks((s) => s.lockAfterMinutes);
  const [value, setValue] = useState(String(minutes));
  const commit = () => {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) useLocks.getState().setLockAfterMinutes(n);
    else setValue(String(minutes));
  };
  return (
    <>
      <div className="settings-head">
        <h2>Encrypted notes</h2>
      </div>
      <p className="muted">
        Right-click a note and choose <strong>Encrypt…</strong> to lock it with a password. An
        unlocked note locks again when you close its tab, press the lock in its header, quit, or
        leave it unused for a while.
      </p>
      <label className="dialog-field settings-inline">
        <span>Lock after this many minutes unused (0 for never)</span>
        <input
          type="number"
          min={0}
          step={1}
          aria-label="Lock after minutes unused"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
      </label>
    </>
  );
}

// ---- Keyboard shortcuts ----------------------------------------------------

function ShortcutSettings() {
  const changed = useKeys((s) => Object.keys(s.overrides).length > 0);
  const extra = useKeys((s) => s.extra);
  const [note, setNote] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const commands = allCommands(extra).filter((c) => {
    const text = `${c.group} ${c.label}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const groups = [...new Set(commands.map((c) => c.group))];

  return (
    <>
      <div className="settings-head">
        <h2>Keyboard shortcuts</h2>
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
      </div>
      <p className="muted">
        Click a shortcut, then press the new keys. They need ⌘, ⌃ or ⌥. Backspace clears one.
      </p>
      <input
        type="search"
        className="settings-search"
        aria-label="Search shortcuts"
        placeholder="Search…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="settings-scroll">
        {groups.map((group) => (
          <section key={group} aria-label={group}>
            <h3>{group}</h3>
            {commands
              .filter((c) => c.group === group)
              .map((c) => (
                <div key={c.id} className="settings-key">
                  <span>{c.label}</span>
                  <Shortcut command={c} onNote={setNote} />
                </div>
              ))}
          </section>
        ))}
        {groups.length === 0 && <p className="muted small">No shortcuts match.</p>}
      </div>
      {note && (
        <p className="settings-note muted" role="status">
          {note}
        </p>
      )}
    </>
  );
}

/** A command's keys, which a click records anew, and a reset. */
function Shortcut({
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
    <span className="settings-shortcut">
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
    </span>
  );
}

// ---- Quick add -------------------------------------------------------------

function summary(c: QuickAddChoice): string {
  if (c.kind === "capture") {
    const to = !c.to || c.to === "today" ? "today’s note" : c.to;
    return `Adds a line to ${to}`;
  }
  return `New note in ${c.folder || "the vault"}${c.project ? ", for a project" : ""}`;
}

function QuickAddSettings() {
  const choices = useQuickAdd((s) => s.choices);
  const [editing, setEditing] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [templates, setTemplates] = useState<string[]>([]);

  useEffect(() => {
    void useQuickAdd.getState().load();
    void api.templates().then(setTemplates, () => setTemplates([]));
  }, []);

  const save = async (next: QuickAddChoice[]) => useQuickAdd.getState().save(next);
  const move = (i: number, by: number) => {
    const next = [...choices];
    const [c] = next.splice(i, 1);
    next.splice(i + by, 0, c!);
    void save(next);
  };

  return (
    <>
      <div className="settings-head">
        <h2>Quick add</h2>
        <button
          type="button"
          onClick={() => {
            setEditing(choices.length);
          }}
        >
          <Plus size={13} /> Add a choice
        </button>
      </div>
      <p className="muted">
        ⇧⌘A lists these. A choice makes a note from a template, or adds a line to a note. They’re
        kept in the vault, in <code>.groundwork/quickadd.yml</code>.
      </p>
      <div className="settings-scroll">
        <ul className="quickadd-list" aria-label="Quick add choices">
          {choices.map((c, i) =>
            editing === i ? (
              <ChoiceEditor
                key={i}
                choice={c}
                templates={templates}
                onCancel={() => setEditing(null)}
                onSave={async (changed) => {
                  const next = choices.map((old, j) => (j === i ? changed : old));
                  if (await save(next)) {
                    await keepShortcut(c, changed);
                    setEditing(null);
                  }
                }}
              />
            ) : (
              <li key={c.name} className="quickadd-choice">
                <button
                  type="button"
                  className="quickadd-text"
                  aria-label={`Edit ${c.name}`}
                  onClick={() => setEditing(i)}
                >
                  <span className="quickadd-name">{c.name}</span>
                  <span className="quickadd-summary">{summary(c)}</span>
                </button>
                <Shortcut
                  command={{
                    id: choiceCommand(c),
                    label: `Quick add: ${c.name}`,
                    group: "Quick add",
                    key: null,
                  }}
                  onNote={setNote}
                />
                <span className="quickadd-actions">
                  <button
                    type="button"
                    className="icon"
                    aria-label={`Move ${c.name} up`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    className="icon"
                    aria-label={`Move ${c.name} down`}
                    disabled={i === choices.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    type="button"
                    className="icon"
                    aria-label={`Delete ${c.name}`}
                    onClick={() => void save(choices.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </li>
            ),
          )}
          {editing === choices.length && (
            <ChoiceEditor
              choice={{
                name: "",
                kind: "note",
                folder: "",
                fileName: "{{prompt:Name}}",
                project: false,
              }}
              templates={templates}
              onCancel={() => setEditing(null)}
              onSave={async (made) => {
                if (await save([...choices, made])) setEditing(null);
              }}
            />
          )}
        </ul>
      </div>
      {note && (
        <p className="settings-note muted" role="status">
          {note}
        </p>
      )}
    </>
  );
}

/** A renamed choice keeps the shortcut you gave it. */
async function keepShortcut(before: QuickAddChoice, after: QuickAddChoice) {
  const from = choiceCommand(before);
  const to = choiceCommand(after);
  const combo = useKeys.getState().overrides[from];
  if (from === to || !combo) return;
  await useKeys.getState().reset(from);
  await useKeys.getState().bind(to, combo);
}

function ChoiceEditor({
  choice,
  templates,
  onSave,
  onCancel,
}: {
  choice: QuickAddChoice;
  templates: string[];
  onSave: (choice: QuickAddChoice) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [c, setC] = useState<QuickAddChoice>(choice);
  const set = (patch: Partial<QuickAddChoice>) => setC((old) => ({ ...old, ...patch }));
  const template = c.template ?? "";
  // A template that isn't in the vault (yet) is one of the built-in ones.
  const templateOptions = [
    ...templates,
    ...(template && !templates.includes(template) ? [template] : []),
  ];

  return (
    <li className="quickadd-editor">
      <form
        aria-label={choice.name ? `Edit ${choice.name}` : "New choice"}
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(clean(c));
        }}
      >
        <label className="dialog-field">
          <span>Name</span>
          <input
            autoFocus
            required
            value={c.name}
            placeholder="Meeting"
            onChange={(e) => set({ name: e.target.value })}
          />
        </label>
        <label className="dialog-field">
          <span>Type</span>
          <select
            aria-label="Type"
            value={c.kind}
            onChange={(e) => set({ kind: e.target.value as QuickAddChoice["kind"] })}
          >
            <option value="note">Makes a note</option>
            <option value="capture">Adds a line to a note</option>
          </select>
        </label>
        {c.kind === "note" ? (
          <>
            <label className="dialog-field">
              <span>In the folder</span>
              <input
                value={c.folder ?? ""}
                placeholder="Events"
                onChange={(e) => set({ folder: e.target.value })}
              />
            </label>
            <label className="dialog-field">
              <span>Named</span>
              <input
                value={c.fileName ?? ""}
                placeholder="{{date}} {{prompt:Title}}"
                onChange={(e) => set({ fileName: e.target.value })}
              />
            </label>
            <label className="dialog-field">
              <span>From the template</span>
              <select value={template} onChange={(e) => set({ template: e.target.value })}>
                <option value="">None (an empty note)</option>
                {templateOptions.map((t) => (
                  <option key={t} value={t}>
                    {templates.includes(t) ? t : `${t} (built in)`}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={c.project}
                onChange={(e) => set({ project: e.target.checked })}
              />
              Ask which project it’s for (the one you’re in comes first)
            </label>
          </>
        ) : (
          <>
            <label className="dialog-field">
              <span>Adds to</span>
              <input
                value={c.to ?? "today"}
                placeholder="today, or a note’s path"
                onChange={(e) => set({ to: e.target.value })}
              />
            </label>
            <label className="dialog-field">
              <span>The line</span>
              <input
                value={c.format ?? ""}
                placeholder="- [ ] {{prompt:Todo}}"
                onChange={(e) => set({ format: e.target.value })}
              />
            </label>
          </>
        )}
        <p className="muted small">
          Names and lines can use template tags: <code>{"{{date}}"}</code>,{" "}
          <code>{"{{prompt:Title}}"}</code> (asked for when it runs)…
        </p>
        <div className="dialog-buttons">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
    </li>
  );
}

/** Only the fields its kind uses. */
function clean(c: QuickAddChoice): QuickAddChoice {
  const name = c.name.trim();
  return c.kind === "note"
    ? {
        name,
        kind: "note",
        folder: c.folder?.trim() || undefined,
        template: c.template || undefined,
        fileName: c.fileName?.trim() || undefined,
        project: c.project,
      }
    : {
        name,
        kind: "capture",
        to: c.to?.trim() || "today",
        format: c.format?.trim() || undefined,
        project: false,
      };
}
