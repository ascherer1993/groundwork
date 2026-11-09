import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { trackEditor } from "../editor/active";
import { refreshPreview } from "../editor/context";
import {
  createEditorState,
  type EditorHost,
  focusTarget,
  modeCompartment,
  modeExtensions,
} from "../editor/setup";
import { displayName } from "../lib/paths";
import {
  isUnlocked,
  registerFlush,
  retainNote,
  touchNote,
  trackSave,
  useLocks,
} from "../state/locks";
import { useUi } from "../state/ui";
import { message, onVaultChange } from "../state/vault";
import type { FocusTarget, ViewMode } from "../state/workspace";
import { LockedNote } from "./LockedNote";
import { NoteBar } from "./NoteBar";
import { ReadingView } from "./ReadingView";

const SAVE_DELAY = 300;

interface Props {
  path: string;
  mode: ViewMode;
  focus?: FocusTarget;
  editTitle?: boolean;
}

function folderOf(path: string) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function titleOf(path: string) {
  return displayName(path.slice(path.lastIndexOf("/") + 1), "note").base;
}

/** A Markdown note: live preview or source editing, or the reading view. */
export function NoteView({ path, mode, focus, editTitle }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // An encrypted note that's locked: its hint, shown instead of its text.
  const [locked, setLocked] = useState<{ hint: string } | null>(null);
  const unlocked = useLocks((s) => !!s.unlocked[path]);
  const editorParent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  // The note's current path, updated as soon as a rename is announced.
  const pathRef = useRef(path);
  const loadedPath = useRef<string | null>(null);
  const latest = useRef<string>("");
  // The last place asked for, until the note it's in has loaded.
  const pendingFocus = useRef<FocusTarget | undefined>(undefined);
  useEffect(() => {
    pendingFocus.current = focus;
  }, [focus]);
  const saved = useRef<string>("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The loaded note is encrypted: it's read and saved through its key.
  const encrypted = useRef(false);
  const loadedUnlocked = useRef(false);
  const lockedRef = useRef(false);
  const hint = useRef("");
  const modeRef = useRef(mode);
  useLayoutEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const target = loadedPath.current;
    const body = latest.current;
    if (!target || body === saved.current) return;
    try {
      await trackSave(
        target,
        encrypted.current ? api.writeUnlocked(target, body) : api.writeFile(target, body),
      );
      saved.current = body;
    } catch (err) {
      useUi.getState().notify(`Couldn't save ${titleOf(target)}: ${message(err)}`);
    }
  }, []);

  const host = useRef<EditorHost>({
    path: () => pathRef.current,
    onChange: (doc) => {
      latest.current = doc;
      touchNote(pathRef.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), SAVE_DELAY);
    },
  });

  /** Forgets a locked note's text at once (and its undo history, with the editor). */
  const forget = useCallback((noteHint: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    lockedRef.current = true;
    encrypted.current = true;
    loadedUnlocked.current = false;
    hint.current = noteHint;
    latest.current = "";
    saved.current = "";
    setText(null);
    setLocked({ hint: noteHint });
  }, []);

  /** Shows a note's text, fresh: a new editor state, so undo doesn't cross files. */
  const show = useCallback((body: string) => {
    lockedRef.current = false;
    latest.current = body;
    saved.current = body;
    setError(null);
    setLocked(null);
    setText(body);
    const v = view.current;
    v?.setState(
      createEditorState(body, host.current, modeRef.current === "source" ? "source" : "live"),
    );
    if (v && pendingFocus.current) focusTarget(v, pendingFocus.current);
  }, []);

  // Load (or switch to) the file, and again as it's locked or unlocked. A
  // rename keeps the loaded text.
  useEffect(() => {
    if (loadedPath.current === path && loadedUnlocked.current === unlocked) return;
    if (loadedPath.current === path && encrypted.current && !unlocked) {
      forget(hint.current);
      return;
    }
    let cancelled = false;
    void flush().then(async () => {
      try {
        const file = await api.readFile(path);
        if (cancelled) return;
        pathRef.current = path;
        loadedPath.current = path;
        if (file.encrypted) {
          const body = isUnlocked(path) ? await api.readUnlocked(path).catch(() => null) : null;
          if (cancelled) return;
          if (body === null) {
            forget(file.encrypted.hint);
            return;
          }
          hint.current = file.encrypted.hint;
          encrypted.current = true;
          loadedUnlocked.current = true;
          show(body);
          return;
        }
        encrypted.current = false;
        loadedUnlocked.current = unlocked;
        show(file.text ?? "");
      } catch (err) {
        if (!cancelled) setError(message(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [path, unlocked, flush, forget, show]);

  /** Shows the note as it is on disk now, after a change made elsewhere. */
  const reload = useCallback(
    async (target: string) => {
      const file = await api.readFile(target);
      if (loadedPath.current !== target || latest.current !== saved.current) return;
      let body: string;
      if (file.encrypted) {
        const open = isUnlocked(target) ? await api.readUnlocked(target).catch(() => null) : null;
        if (open === null) {
          if (!lockedRef.current) forget(file.encrypted.hint);
          return;
        }
        hint.current = file.encrypted.hint;
        body = open;
      } else {
        body = file.text ?? "";
        if (encrypted.current) {
          // Its encryption came off.
          encrypted.current = false;
          loadedUnlocked.current = false;
          show(body);
          return;
        }
      }
      if (latest.current !== saved.current || body === latest.current) return;
      latest.current = body;
      saved.current = body;
      setText(body);
      const v = view.current;
      if (v) {
        const sel = v.state.selection.main.head;
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: body },
          selection: { anchor: Math.min(sel, body.length) },
          userEvent: "external",
        });
      }
    },
    [forget, show],
  );

  // Follow renames and pick up edits made elsewhere (including being
  // encrypted, or having its encryption taken off).
  useEffect(
    () =>
      onVaultChange((changes) => {
        for (const c of changes) {
          if (c.kind === "moved" && c.from === pathRef.current) {
            pathRef.current = c.path;
            if (loadedPath.current === c.from) loadedPath.current = c.path;
            view.current?.dispatch({ effects: refreshPreview.of(null) });
          }
          if (c.kind === "modified" && c.path === loadedPath.current) {
            if (latest.current !== saved.current) continue;
            void reload(c.path);
          }
        }
      }),
    [reload],
  );

  // Locking (or encrypting) the note saves this view's edits first; the
  // note locks when no view shows it.
  useEffect(() => registerFlush(path, flush), [path, flush]);
  useEffect(() => retainNote(path), [path]);

  // Save on unmount.
  useEffect(() => () => void flush(), [flush]);

  const editing = mode !== "reading";

  // Create the editor once text is loaded and we're editing.
  useEffect(() => {
    if (!editing || text === null || !editorParent.current) return;
    if (view.current) return;
    const v = new EditorView({
      parent: editorParent.current,
      state: createEditorState(latest.current, host.current, mode === "source" ? "source" : "live"),
    });
    view.current = v;
    const untrack = trackEditor(v);
    return () => {
      // The reading view renders from `text`, so hand it the latest edits
      // (unless the note just locked).
      if (!lockedRef.current) setText(v.state.doc.toString());
      untrack();
      v.destroy();
      view.current = null;
    };
    // The editor is recreated only when leaving and re-entering edit mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, text === null]);

  // Switch live/source in place.
  useEffect(() => {
    const v = view.current;
    if (!v || mode === "reading") return;
    v.dispatch({ effects: modeCompartment.reconfigure(modeExtensions(mode)) });
  }, [mode]);

  // Scroll to a heading/block/line on request, once the note asked about is
  // in the editor: a tab opening another note still holds the old one, and
  // loading the new one would put the cursor back at the top. (At once, not
  // on the next frame, or keys typed in between land at the top too.)
  useEffect(() => {
    if (!focus || text === null || loadedPath.current !== path) return;
    const v = view.current;
    if (v) focusTarget(v, focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, text === null]);

  if (error) {
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }
  if (locked) {
    return (
      <div className="note-view">
        <InlineTitle key={path} path={path} autoFocus={false} onDone={() => {}} />
        <LockedNote path={path} hint={locked.hint} />
      </div>
    );
  }
  if (text === null) return <div className="loading" aria-busy="true" />;

  const used = () => touchNote(pathRef.current);
  return (
    <div
      className="note-view"
      onKeyDownCapture={used}
      onPointerDownCapture={used}
      onWheelCapture={used}
    >
      <NoteBar path={path} />
      <InlineTitle
        key={path}
        path={path}
        autoFocus={!!editTitle}
        onDone={() => view.current?.focus()}
      />
      {editing ? (
        <div className="editor" ref={editorParent} data-testid="editor" />
      ) : (
        <ReadingView path={path} text={text} focus={focus} />
      )}
    </div>
  );
}

/** The note's name above its content; editing it renames the file. */
function InlineTitle({
  path,
  autoFocus,
  onDone,
}: {
  path: string;
  autoFocus: boolean;
  onDone: () => void;
}) {
  const title = titleOf(path);
  const [value, setValue] = useState(title);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [autoFocus, path]);

  async function commit() {
    const name = value.trim();
    if (!name || name === title) {
      setValue(title);
      return;
    }
    const folder = folderOf(path);
    await renameWithUndo(path, `${folder ? `${folder}/` : ""}${name}.md`);
  }

  return (
    <input
      ref={ref}
      className="inline-title"
      aria-label="Note title"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit().then(onDone);
        } else if (e.key === "Escape") {
          setValue(title);
          onDone();
        }
      }}
    />
  );
}

/** Renames or moves a file, then offers to undo it. */
export async function renameWithUndo(from: string, to: string): Promise<boolean> {
  const ui = useUi.getState();
  try {
    const outcome = await api.rename(from, to);
    const notes = outcome.updatedNotes.length;
    const detail = notes
      ? ` and updated ${outcome.updatedLinks} link${outcome.updatedLinks === 1 ? "" : "s"} in ${notes} note${notes === 1 ? "" : "s"}`
      : "";
    const skipped = outcome.skippedNotes.length
      ? ` (${outcome.skippedNotes.length} skipped: changed during rename)`
      : "";
    const verb = folderOf(from) === folderOf(to) ? "Renamed" : "Moved";
    const subs = outcome.subnotes.length;
    const withSubs = subs ? ` with its ${subs === 1 ? "subnote" : `${subs} subnotes`}` : "";
    ui.notify(`${verb} “${titleOf(from)}”${withSubs}${detail}${skipped}`, {
      label: "Undo",
      run: () => void undoLast(),
    });
    return true;
  } catch (err) {
    ui.notify(message(err));
    return false;
  }
}

/** Undoes the last rename/move/delete recorded by the backend. */
export async function undoLast() {
  const ui = useUi.getState();
  try {
    const label = await api.undo();
    ui.notify(`Undid ${label}`);
  } catch (err) {
    ui.notify(message(err));
  }
}
