import { AppWindow, ArrowLeft, ArrowRight, BookOpen, Code, PencilLine } from "lucide-react";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { FileContent } from "../api/generated/FileContent";
import { vaultFileUrl } from "../lib/fileUrl";
import { isPagePath, projectOfView } from "../lib/paths";
import { isImage } from "../markdown/syntax";
import { useKeyLabel } from "../state/keys";
import { message, useVault } from "../state/vault";
import { type PanelParams, useWorkspace, type ViewMode } from "../state/workspace";
import { NoteView } from "./NoteView";
import { PageView } from "./PageView";
import { ProjectView } from "./ProjectView";

const MODES: { mode: ViewMode; label: string; Icon: typeof BookOpen }[] = [
  { mode: "live", label: "Live preview", Icon: PencilLine },
  { mode: "source", label: "Source", Icon: Code },
  { mode: "reading", label: "Reading", Icon: BookOpen },
];

/** A page shows as itself in every mode but source. */
const PAGE_MODES: { mode: ViewMode; label: string; Icon: typeof BookOpen }[] = [
  { mode: "reading", label: "Page", Icon: AppWindow },
  { mode: "source", label: "Source", Icon: Code },
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
  const page = isPagePath(path);
  const modes = note ? MODES : page ? PAGE_MODES : null;
  const toggleKey = useKeyLabel("toggle-reading");
  const current = page && mode !== "source" ? "reading" : mode;
  const project = projectOfView(path);
  const [viewTitle, setViewTitle] = useState<string | null>(null);
  const setTitle = useCallback(
    (title: string) => {
      panel.setTitle(title);
      setViewTitle(title);
    },
    [panel],
  );

  return (
    <article className="file-panel" aria-label={path} data-panel-id={panel.id}>
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
          {(project ? ["Project", viewTitle ?? project] : path.split("/")).map((part, i, parts) => (
            <span key={i} className={i === parts.length - 1 ? "crumb current" : "crumb"}>
              {i === parts.length - 1 && note ? part.replace(/\.md$/i, "") : part}
            </span>
          ))}
        </nav>
        {modes && (
          <div className="mode-switch" role="radiogroup" aria-label="View mode">
            {modes.map(({ mode: m, label, Icon }) => (
              <button
                key={m}
                role="radio"
                aria-checked={current === m}
                aria-label={label}
                title={
                  toggleKey
                    ? `${label} (${toggleKey} toggles ${page ? "source" : "reading"})`
                    : label
                }
                className={`icon${current === m ? " active" : ""}`}
                onClick={() => setMode(panel.id, m)}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="file-body">
        {project ? (
          <ProjectView id={project} setTitle={setTitle} />
        ) : note ? (
          <NoteView path={path} mode={mode} focus={focus} editTitle={editTitle} />
        ) : page && mode !== "source" ? (
          <PageView path={path} />
        ) : (
          <OtherFile path={path} />
        )}
      </div>
    </article>
  );
}

/** Images, the source of pages, and other files. */
function OtherFile({ path }: { path: string }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Show edits made elsewhere (Claude rewriting a page, say).
  const revision = useVault((s) => s.revision);

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
  }, [path, revision]);

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
  if (!file || file.path !== path) return <div className="loading" aria-busy="true" />;
  return (
    <div className="source-view">
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
