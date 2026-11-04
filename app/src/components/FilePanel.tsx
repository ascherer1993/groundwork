import { ArrowLeft, ArrowRight, BookOpen, Code, PencilLine } from "lucide-react";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { FileContent } from "../api/generated/FileContent";
import { vaultFileUrl } from "../lib/fileUrl";
import { isImage } from "../markdown/syntax";
import { message } from "../state/vault";
import { type PanelParams, useWorkspace, type ViewMode } from "../state/workspace";
import { NoteView } from "./NoteView";

const MODES: { mode: ViewMode; label: string; Icon: typeof BookOpen }[] = [
  { mode: "live", label: "Live preview", Icon: PencilLine },
  { mode: "source", label: "Source", Icon: Code },
  { mode: "reading", label: "Reading", Icon: BookOpen },
];

function isNote(path: string) {
  return path.toLowerCase().endsWith(".md");
}

/** One tab: header (history, breadcrumbs, mode) and the file's view. */
export function FilePanel({ api: panel, params }: IDockviewPanelProps<PanelParams>) {
  const { path, mode, back, forward, focus, editTitle } = params;
  const goBack = useWorkspace((s) => s.back);
  const goForward = useWorkspace((s) => s.forward);
  const setMode = useWorkspace((s) => s.setMode);
  const note = isNote(path);

  return (
    <article className="file-panel" aria-label={path}>
      <header className="file-header">
        <button
          className="icon"
          aria-label="Back"
          disabled={!back.length}
          onClick={() => goBack(panel.id)}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          className="icon"
          aria-label="Forward"
          disabled={!forward.length}
          onClick={() => goForward(panel.id)}
        >
          <ArrowRight size={14} />
        </button>
        <nav className="crumbs" aria-label="Path">
          {path.split("/").map((part, i, parts) => (
            <span key={i} className={i === parts.length - 1 ? "crumb current" : "crumb"}>
              {i === parts.length - 1 && note ? part.replace(/\.md$/i, "") : part}
            </span>
          ))}
        </nav>
        {note && (
          <div className="mode-switch" role="radiogroup" aria-label="View mode">
            {MODES.map(({ mode: m, label, Icon }) => (
              <button
                key={m}
                role="radio"
                aria-checked={mode === m}
                aria-label={label}
                title={`${label} (⌘E toggles reading)`}
                className={`icon${mode === m ? " active" : ""}`}
                onClick={() => setMode(panel.id, m)}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="file-body">
        {note ? (
          <NoteView path={path} mode={mode} focus={focus} editTitle={editTitle} />
        ) : (
          <OtherFile path={path} />
        )}
      </div>
    </article>
  );
}

/** Images, pages (as source for now) and other files. */
function OtherFile({ path }: { path: string }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isImage(path)) return;
    let cancelled = false;
    api
      .readFile(path)
      .then((f) => !cancelled && (setFile(f), setError(null)))
      .catch((err) => !cancelled && setError(message(err)));
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (isImage(path)) {
    return (
      <div className="asset-view">
        <img src={vaultFileUrl(path)} alt={path} />
      </div>
    );
  }
  if (error) {
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }
  if (!file) return <div className="loading" aria-busy="true" />;
  const isPage = file.kind === "page" || file.kind === "pageBundle";
  return (
    <div className="source-view">
      {isPage && (
        <p className="notice">Interactive pages arrive in Phase 3. Showing the source for now.</p>
      )}
      {file.text !== undefined ? (
        <pre className="file-text" data-testid="file-text">
          {file.text}
        </pre>
      ) : (
        <div className="empty muted">
          <p>No preview for this file type.</p>
          <button onClick={() => void api.openExternally(path)}>Open in default app</button>
        </div>
      )}
    </div>
  );
}
