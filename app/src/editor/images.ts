/**
 * Images in the editor: pasting or dropping one saves it to the vault's
 * attachment folder and embeds it (`![[Pasted image ….png]]`); dragging an
 * embedded image's corner sets its width (`![[x.png|400]]`, as Obsidian does).
 */
import { EditorView } from "@codemirror/view";
import { api } from "../api/client";
import { isImage } from "../markdown/syntax";
import { useUi } from "../state/ui";
import { message } from "../state/vault";
import { notePath } from "./context";

/** Larger files are refused before they're sent. */
const MAX_BYTES = 25 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

function imageFiles(list: FileList | undefined | null): File[] {
  return [...(list ?? [])].filter((f) => f.type in EXTENSIONS || isImage(f.name));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Obsidian's name for a pasted image: `Pasted image 20261110143012.png`. */
export function pastedName(file: File, now = new Date()): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ext = EXTENSIONS[file.type] ?? file.name.split(".").pop() ?? "png";
  return `Pasted image ${stamp}.${ext}`;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("couldn't read the image"));
    reader.readAsDataURL(file);
  });
}

/** Saves each file and inserts their embeds at `pos` (clamped to the document). */
async function insertImages(view: EditorView, files: File[], names: string[], pos: number) {
  const source = notePath(view.state);
  const links: string[] = [];
  try {
    for (const [i, file] of files.entries()) {
      if (file.size > MAX_BYTES) throw new Error(`${file.name} is over 25 MB`);
      const path = await api.saveAttachment(source, names[i]!, await toBase64(file));
      links.push(await api.formatLink(source, path, { embed: true }));
    }
  } catch (err) {
    useUi.getState().notify(message(err));
  }
  if (!links.length) return;
  const at = Math.min(pos, view.state.doc.length);
  const insert = links.join("\n");
  view.dispatch({
    changes: { from: at, insert },
    selection: { anchor: at + insert.length },
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  view.focus();
}

export const imageInput = EditorView.domEventHandlers({
  paste(event, view) {
    const data = event.clipboardData;
    // Text copied with a picture of itself (spreadsheets, Word) pastes as text.
    if (!data || data.getData("text/plain").trim()) return false;
    const files = imageFiles(data.files);
    if (!files.length) return false;
    event.preventDefault();
    const now = new Date();
    const names = files.map((f, i) => pastedName(f, new Date(now.getTime() + i * 1000)));
    void insertImages(view, files, names, view.state.selection.main.from);
    return true;
  },
  drop(event, view) {
    const files = imageFiles(event.dataTransfer?.files);
    if (!files.length) return false;
    event.preventDefault();
    const pos =
      view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
    const names = files.map((f) => (f.name && f.name !== "image.png" ? f.name : pastedName(f)));
    void insertImages(view, files, names, pos);
    return true;
  },
});

const SIZE = /(?:^|\|)\s*\d+(?:x\d+)?\s*$/;

/** An alias or alt text with its `300` / `300x200` size replaced by `width`. */
function sized(alias: string, width: number): string {
  const text = alias.replace(SIZE, "");
  return text ? `${text}|${width}` : String(width);
}

/**
 * The image embed at the start of `text` (`![[...]]` or `![alt](url)`) with
 * its width set, and how much of `text` it replaces; `null` if `text` doesn't
 * start with one.
 */
export function withWidth(text: string, width: number): { length: number; insert: string } | null {
  const wiki = text.match(/^!\[\[([^\]\n]+)\]\]/);
  if (wiki) {
    const inner = wiki[1]!;
    const pipe = inner.indexOf("|");
    const target = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const alias = pipe >= 0 ? inner.slice(pipe + 1) : "";
    return { length: wiki[0].length, insert: `![[${target}|${sized(alias, width)}]]` };
  }
  const md = text.match(/^!\[([^\]\n]*)\](\([^)\n]*\))/);
  if (md) return { length: md[0].length, insert: `![${sized(md[1]!, width)}]${md[2]}` };
  return null;
}

/**
 * Adds a corner handle to an image embed's `wrap`. Dragging it scales the
 * image; letting go writes the width into the embed.
 */
export function addResizeHandle(view: EditorView, wrap: HTMLElement) {
  wrap.classList.add("cm-embed-image");
  const handle = document.createElement("span");
  handle.className = "cm-image-resize";
  handle.title = "Drag to resize";
  handle.setAttribute("aria-hidden", "true");
  wrap.append(handle);

  handle.addEventListener("mousedown", (down) => {
    const img = wrap.querySelector("img");
    if (!img || down.button !== 0) return;
    down.preventDefault();
    down.stopPropagation();
    const startX = down.clientX;
    const startWidth = img.getBoundingClientRect().width;
    const max = view.contentDOM.getBoundingClientRect().width;
    let width = Math.round(startWidth);
    wrap.classList.add("is-resizing");
    const move = (e: MouseEvent) => {
      width = Math.round(Math.max(32, Math.min(max, startWidth + e.clientX - startX)));
      img.removeAttribute("height");
      img.style.width = `${width}px`;
      img.style.height = "auto";
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      wrap.classList.remove("is-resizing");
      if (width === Math.round(startWidth)) return;
      const from = view.posAtDOM(wrap);
      const line = view.state.doc.lineAt(from);
      const change = withWidth(view.state.sliceDoc(from, line.to), width);
      if (!change) return;
      view.dispatch({
        changes: { from, to: from + change.length, insert: change.insert },
        userEvent: "input.resize",
      });
      view.requestMeasure();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}
