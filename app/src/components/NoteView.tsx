import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { trackEditor } from "../editor/active";
import { refreshPreview } from "../editor/context";
import {
  type EditorHost,
  editorExtensions,
  focusTarget,
  modeCompartment,
  modeExtensions,
} from "../editor/setup";
import { displayName } from "../lib/paths";
import { useUi } from "../state/ui";
import { message, onVaultChange } from "../state/vault";
import type { FocusTarget, ViewMode } from "../state/workspace";
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
  const editorParent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  // The note's current path, updated as soon as a rename is announced.
  const pathRef = useRef(path);
  const loadedPath = useRef<string | null>(null);
  const latest = useRef<string>("");
  const saved = useRef<string>("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      await api.writeFile(target, body);
      saved.current = body;
    } catch (err) {
      useUi.getState().notify(`Couldn't save ${titleOf(target)}: ${message(err)}`);
    }
  }, []);

  const host = useRef<EditorHost>({
    path: () => pathRef.current,
    onChange: (doc) => {
      latest.current = doc;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), SAVE_DELAY);
    },
  });

  // Load (or switch to) the file. A rename keeps the loaded text.
  useEffect(() => {
    if (loadedPath.current === path) return;
    let cancelled = false;
    void flush().then(async () => {
      try {
        const file = await api.readFile(path);
        if (cancelled) return;
        const body = file.text ?? "";
        pathRef.current = path;
        loadedPath.current = path;
        latest.current = body;
        saved.current = body;
        setError(null);
        setText(body);
        // A fresh state, so undo history doesn't cross files.
        view.current?.setState(
          EditorState.create({
            doc: body,
            extensions: editorExtensions(
              host.current,
              modeRef.current === "source" ? "source" : "live",
            ),
          }),
        );
      } catch (err) {
        if (!cancelled) setError(message(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [path, flush]);

  // Follow renames and pick up edits made elsewhere.
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
            void api.readFile(c.path).then((file) => {
              const body = file.text ?? "";
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
            });
          }
        }
      }),
    [],
  );

  // Save on unmount.
  useEffect(() => () => void flush(), [flush]);

  const editing = mode !== "reading";

  // Create the editor once text is loaded and we're editing.
  useEffect(() => {
    if (!editing || text === null || !editorParent.current) return;
    if (view.current) return;
    const v = new EditorView({
      parent: editorParent.current,
      state: EditorState.create({
        doc: latest.current,
        extensions: editorExtensions(host.current, mode === "source" ? "source" : "live"),
      }),
    });
    view.current = v;
    const untrack = trackEditor(v);
    return () => {
      // The reading view renders from `text`, so hand it the latest edits.
      setText(v.state.doc.toString());
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

  // Scroll to a heading/block/line on request.
  useEffect(() => {
    if (!focus || text === null) return;
    const v = view.current;
    if (v) {
      requestAnimationFrame(() => focusTarget(v, focus));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, text === null]);

  if (error) {
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }
  if (text === null) return <div className="loading" aria-busy="true" />;

  return (
    <div className="note-view">
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
    ui.notify(`${verb} “${titleOf(from)}”${detail}${skipped}`, {
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
