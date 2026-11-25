/**
 * Images in the editor: pasting or dropping one saves it to the vault's
 * attachment folder and embeds it (`![[Pasted image ….png]]`); dragging an
 * embedded image's corner sets its width (`![[x.png|400]]`, as Obsidian does),
 * and dragging the image itself moves its embed. Clicking an image shows its
 * source, with the image still below it (see `livePreview.ts`).
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
    if (moving?.view === view) {
      const move = moving;
      moving = null;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos !== null) moveEmbed(view, move.from, move.to, pos);
      return true;
    }
    const files = imageFiles(event.dataTransfer?.files);
    if (!files.length) return false;
    event.preventDefault();
    const pos =
      view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
    const names = files.map((f) => (f.name && f.name !== "image.png" ? f.name : pastedName(f)));
    void insertImages(view, files, names, pos);
    return true;
  },
  dragend() {
    moving = null;
    return false;
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

/** How long the image embed at the start of `text` is; 0 if it doesn't start with one. */
export function embedLength(text: string): number {
  return withWidth(text, 0)?.length ?? 0;
}

/** Where the embed ending at `to` starts, or `null`. */
export function embedStartBefore(line: string, to: number): number | null {
  for (let at = line.lastIndexOf("![", to - 1); at >= 0; at = line.lastIndexOf("![", at - 1)) {
    if (at + embedLength(line.slice(at)) === to) return at;
    if (at === 0) break;
  }
  return null;
}

/**
 * The document range of the embed an image widget shows: a widget replacing
 * the embed starts where it does; a preview below the source sits at its end.
 */
function embedRange(view: EditorView, wrap: HTMLElement): { from: number; to: number } | null {
  const pos = view.posAtDOM(wrap);
  const line = view.state.doc.lineAt(pos);
  if (wrap.classList.contains("cm-embed-preview")) {
    const start = embedStartBefore(line.text, pos - line.from);
    return start === null ? null : { from: line.from + start, to: pos };
  }
  const length = embedLength(view.state.sliceDoc(pos, line.to));
  return length ? { from: pos, to: pos + length } : null;
}

/** An image being dragged to a new place in its note. */
let moving: { view: EditorView; from: number; to: number } | null = null;

/**
 * Moves the embed at `from..to` to `pos`. An embed that had its line to
 * itself takes the line with it, and one dropped at the start of a line
 * gets a line of its own.
 */
export function moveEmbed(view: EditorView, from: number, to: number, pos: number) {
  const { doc } = view.state;
  if (pos >= from && pos <= to) return;
  const text = doc.sliceString(from, to);
  const line = doc.lineAt(from);
  let [cutFrom, cutTo] = [from, to];
  if (line.text.trim() === text) {
    cutFrom = line.from;
    cutTo = line.number < doc.lines ? line.to + 1 : line.to;
    if (cutTo === line.to && line.from > 0) cutFrom = line.from - 1;
  }
  if (pos > cutFrom && pos < cutTo) return;
  const target = doc.lineAt(pos);
  const insert = pos === target.from && target.length > 0 ? `${text}\n` : text;
  const changes = view.state.changes([
    { from: cutFrom, to: cutTo },
    { from: pos, insert },
  ]);
  view.dispatch({
    changes,
    selection: { anchor: changes.mapPos(pos, 1) - (insert.length - text.length) },
    userEvent: "move.drop",
    scrollIntoView: true,
  });
  view.focus();
}

/**
 * An image embed's behaviour in the editor: clicking it shows its source
 * (the image stays, below), dragging it moves it, and its corner resizes it.
 */
export function attachImage(view: EditorView, wrap: HTMLElement) {
  addResizeHandle(view, wrap);
  wrap.addEventListener("click", (e) => {
    if (!(e.target instanceof HTMLImageElement)) return;
    e.preventDefault();
    if (wrap.classList.contains("cm-embed-preview")) {
      view.focus();
      return;
    }
    const range = embedRange(view, wrap);
    if (!range) return;
    view.dispatch({ selection: { anchor: range.to } });
    view.focus();
  });
  wrap.addEventListener("dragstart", (e) => {
    const range = e.target instanceof HTMLImageElement ? embedRange(view, wrap) : null;
    if (!range || !e.dataTransfer) return;
    moving = { view, ...range };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", view.state.sliceDoc(range.from, range.to));
  });
}

/**
 * Adds a corner handle to an image embed's `wrap`. Dragging it scales the
 * image; letting go writes the width into the embed.
 */
function addResizeHandle(view: EditorView, wrap: HTMLElement) {
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
      const range = embedRange(view, wrap);
      const change = range && withWidth(view.state.sliceDoc(range.from, range.to), width);
      if (!range || !change) return;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: change.insert },
        userEvent: "input.resize",
      });
      view.requestMeasure();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}
