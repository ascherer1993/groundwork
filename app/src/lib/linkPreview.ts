/**
 * Link previews, shared by the editor and rendered Markdown. A preview opens
 * only while ⌘ is held: hovering a link with ⌘ down, or pressing ⌘ while over
 * one. It closes once the pointer is on neither that link nor the preview,
 * after a moment to cross the gap between them.
 */
import { useUi } from "../state/ui";

export interface PreviewLink {
  el: HTMLElement;
  path: string;
  subpath?: string;
}

const OPEN_DELAY = 150;
/** Time to move from the link onto the preview. */
const CLOSE_GRACE = 250;

/** The link under the pointer. */
let over: PreviewLink | null = null;
/** The link whose preview is showing. */
let shownFor: HTMLElement | null = null;
let onPreview = false;
let openTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function open(link: PreviewLink) {
  const rect = link.el.getBoundingClientRect();
  shownFor = link.el;
  useUi.getState().showHover({
    path: link.path,
    subpath: link.subpath,
    x: rect.left,
    y: rect.bottom + 6,
  });
}

function cancelOpen() {
  if (openTimer) clearTimeout(openTimer);
  openTimer = null;
}

function scheduleClose() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (onPreview || (over && over.el === shownFor)) return;
    closePreview();
  }, CLOSE_GRACE);
}

export function closePreview() {
  cancelOpen();
  shownFor = null;
  onPreview = false;
  useUi.getState().showHover(null);
}

function listen() {
  if (listening) return;
  listening = true;
  // ⌘ pressed while already over a link.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Meta" && over && over.el !== shownFor) {
      cancelOpen();
      open(over);
    }
  });
}

/** The pointer moved onto a link. `withModifier`: ⌘ was held. */
export function enterLink(link: PreviewLink, withModifier: boolean) {
  listen();
  if (over?.el === link.el) return;
  over = link;
  cancelOpen();
  if (withModifier && link.el !== shownFor) {
    openTimer = setTimeout(() => {
      openTimer = null;
      if (over?.el === link.el) open(link);
    }, OPEN_DELAY);
  }
  if (shownFor) scheduleClose();
}

/** The pointer left a link (not just moved between its children). */
export function leaveLink(el: HTMLElement) {
  if (over?.el !== el) return;
  over = null;
  cancelOpen();
  if (shownFor) scheduleClose();
}

export function enterPreview() {
  onPreview = true;
}

export function leavePreview() {
  onPreview = false;
  scheduleClose();
}
