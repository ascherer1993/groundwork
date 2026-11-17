import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { CanvasTheme } from "../api/generated/CanvasTheme";
import type { DailyFields } from "../api/generated/DailyFields";
import type { DailyNoteSettings } from "../api/generated/DailyNoteSettings";
import type { QuickAddChoice } from "../api/generated/QuickAddChoice";
import { comboOf, displayCombo, usable } from "../lib/keyCombo";
import { allCommands, bindingOf, type KeyCommand, useKeys } from "../state/keys";
import { useCanvasSettings } from "../state/canvas";
import { useLocks } from "../state/locks";
import { removeFromDictionary, useSpelling } from "../state/spelling";
import { choiceCommand, useQuickAdd } from "../state/quickadd";
import { useUi } from "../state/ui";
import { message } from "../state/vault";
import { FolderInput } from "./FolderInput";
import { SearchSettings } from "./SearchSettings";

/**
 * Settings has a section per feature, down its side. A feature's section
 * holds its settings; Keyboard shortcuts lists every feature's commands.
 */
const SECTIONS = [
  "Daily notes",
  "Quick add",
  "Search",
  "Spelling",
  "Encrypted notes",
  "Canvases",
  "Keyboard shortcuts",
] as const;
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
          {section === "Daily notes" ? (
            <DailySettings />
          ) : section === "Quick add" ? (
            <QuickAddSettings />
          ) : section === "Search" ? (
            <SearchSettings />
          ) : section === "Spelling" ? (
            <SpellingSettings />
          ) : section === "Encrypted notes" ? (
            <EncryptionSettings />
          ) : section === "Canvases" ? (
            <CanvasSettings />
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

// ---- Daily notes -----------------------------------------------------------

const DAILY_FIELDS = [
  { key: "folder", label: "Folder", fallback: "the vault’s root", hint: "Type / for the root." },
  { key: "format", label: "Date format", fallback: "YYYY-MM-DD", hint: "Moment.js tokens." },
  { key: "template", label: "Template", fallback: "none", hint: "" },
] as const;

/**
 * Settings › Daily notes. Groundwork's own settings, kept in the vault's
 * `.groundwork/config.yml`; a field left empty uses Obsidian's.
 */
function DailySettings() {
  const [settings, setSettings] = useState<DailyNoteSettings | null>(null);
  const empty = { folder: "", format: "", template: "" };
  const [draft, setDraft] = useState<Record<keyof DailyFields, string>>(empty);
  const [saved, setSaved] = useState<Record<keyof DailyFields, string>>(empty);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<string[]>([]);

  const show = (s: DailyNoteSettings) => {
    setSettings(s);
    const gw = s.groundwork;
    const fields = {
      // An empty folder set on purpose is the root; it shows as "/".
      folder: gw.folder === "" ? "/" : (gw.folder ?? ""),
      format: gw.format ?? "",
      template: gw.template ?? "",
    };
    setDraft(fields);
    setSaved(fields);
  };
  useEffect(() => {
    void api.dailySettings().then(show, (e: unknown) => setError(message(e)));
    void api.templates().then(setTemplates, () => setTemplates([]));
  }, []);

  /** Saves the fields, with `pending` over what's typed (a folder just picked). */
  const save = async (pending: Partial<Record<keyof DailyFields, string>> = {}) => {
    if (!settings) return;
    const fields = { ...draft, ...pending };
    const changed = (Object.keys(fields) as (keyof DailyFields)[]).some(
      (k) => fields[k].trim() !== saved[k],
    );
    if (!changed) return;
    const value = (v: string) => (v.trim() === "" ? null : v.trim());
    try {
      show(
        await api.saveDailySettings({
          folder: value(fields.folder),
          format: value(fields.format),
          template: value(fields.template),
        }),
      );
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <>
      <div className="settings-head">
        <h2>Daily notes</h2>
      </div>
      <p className="muted">
        ⇧⌘D opens today’s note. These are kept in the vault, in <code>.groundwork/config.yml</code>,
        and come before Obsidian’s daily notes settings. A field left empty uses Obsidian’s.
      </p>
      <div className="settings-scroll daily-settings">
        {DAILY_FIELDS.map(({ key, label, fallback, hint }) => {
          const obsidian = settings?.obsidian[key];
          const placeholder = obsidian ? `${obsidian} (from Obsidian)` : `Default: ${fallback}`;
          if (key === "folder")
            return (
              <div key={key} className="dialog-field">
                <span>{label}</span>
                <FolderInput
                  scope="vault"
                  label="Daily notes folder"
                  rootValue="/"
                  placeholder={placeholder}
                  value={draft.folder}
                  disabled={!settings}
                  onChange={(folder) => setDraft((d) => ({ ...d, folder }))}
                  onPick={(folder) => void save({ folder })}
                  onBlur={() => void save()}
                  onKeyDown={(e) => e.key === "Enter" && void save()}
                />
                <span className="daily-hint">{hint}</span>
              </div>
            );
          return (
            <label key={key} className="dialog-field">
              <span>{label}</span>
              <input
                aria-label={`Daily notes ${label.toLowerCase()}`}
                list={key === "template" ? "daily-templates" : undefined}
                placeholder={placeholder}
                value={draft[key]}
                disabled={!settings}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                onBlur={() => void save()}
                onKeyDown={(e) => e.key === "Enter" && void save()}
              />
              {hint && <span className="daily-hint">{hint}</span>}
            </label>
          );
        })}
        <datalist id="daily-templates">
          {templates.map((t) => (
            <option key={t} value={t.replace(/\.md$/, "")} />
          ))}
        </datalist>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {settings && (
          <p className="muted" aria-label="Today’s daily note">
            Today’s note: <code>{settings.todayPath}</code>
          </p>
        )}
      </div>
    </>
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

// ---- Spelling --------------------------------------------------------------

/** Settings › Spelling: checking on or off, and the vault's own words (PLAN §5.18). */
function SpellingSettings() {
  const enabled = useSpelling((s) => s.enabled);
  const [words, setWords] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.dictionaryWords().then(setWords, (e: unknown) => setError(message(e)));
  }, []);

  const remove = async (word: string) => {
    try {
      await removeFromDictionary(word);
      setWords(await api.dictionaryWords());
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <>
      <div className="settings-head">
        <h2>Spelling</h2>
      </div>
      <p className="muted">
        Words the dictionary (US English) doesn’t know get a red underline. Right-click one for
        suggestions, or to add it to this vault’s dictionary. Code, links, tags and the like aren’t
        checked.
      </p>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => useSpelling.getState().setEnabled(e.target.checked)}
        />
        Check spelling in notes
      </label>
      <h3 className="settings-subhead">This vault’s words</h3>
      <p className="muted">
        Kept in <code>.groundwork/dictionary.txt</code>, one per line, so they go wherever the vault
        does.
      </p>
      {error && <p className="error">{error}</p>}
      {words && words.length === 0 && <p className="muted">None yet.</p>}
      {words && words.length > 0 && (
        <ul className="dictionary-words" aria-label="This vault’s words">
          {words.map((w) => (
            <li key={w}>
              <span>{w}</span>
              <button
                type="button"
                className="icon"
                aria-label={`Remove ${w}`}
                onClick={() => void remove(w)}
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---- Canvases --------------------------------------------------------------

/** Settings › Canvases: how drawings look (PLAN §5.17). */
function CanvasSettings() {
  const theme = useCanvasSettings((s) => s.theme);
  return (
    <>
      <div className="settings-head">
        <h2>Canvases</h2>
      </div>
      <p className="muted">
        Right-click a folder and choose <strong>New specialty note › Canvas…</strong> to draw on an
        infinite canvas, or a note for a canvas subnote. Copied and exported images are always
        light, on a white background.
      </p>
      <label className="dialog-field">
        <span>Look</span>
        <select
          aria-label="Canvas look"
          value={theme}
          onChange={(e) => useCanvasSettings.getState().setTheme(e.target.value as CanvasTheme)}
        >
          <option value="app">Follow the app (light or dark, like macOS)</option>
          <option value="light">Always light</option>
          <option value="dark">Always dark</option>
        </select>
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
            <div className="dialog-field">
              <span>In the folder</span>
              <FolderInput
                scope="vault"
                label="In the folder"
                rootValue=""
                value={c.folder ?? ""}
                placeholder="Events"
                onChange={(folder) => set({ folder })}
              />
            </div>
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
