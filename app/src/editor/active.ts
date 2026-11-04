import type { EditorView } from "@codemirror/view";
import { notePath } from "./context";

/** Open editors, most recently focused first. */
const views: EditorView[] = [];

/** Registers an editor so commands can find it. Returns an unregister function. */
export function trackEditor(view: EditorView): () => void {
  views.push(view);
  const onFocus = () => {
    views.splice(views.indexOf(view), 1);
    views.unshift(view);
  };
  view.contentDOM.addEventListener("focus", onFocus);
  return () => {
    view.contentDOM.removeEventListener("focus", onFocus);
    const i = views.indexOf(view);
    if (i >= 0) views.splice(i, 1);
  };
}

/** The most recently focused editor showing `path`. */
export function editorFor(path: string): EditorView | null {
  return views.find((v) => notePath(v.state) === path) ?? null;
}
