/**
 * HTML pages in sandboxed frames, and the app's side of their bridge
 * (`crates/backend/src/bridge.js`). Frames have no origin of their own, so
 * pages reach the vault only through the calls handled here. One listener
 * serves every frame: tabs, embeds in notes, and embeds in live preview.
 */
import { api, transport } from "../api/client";
import { CONTENT_RESIZED } from "../markdown/todos";
import { message, onVaultChange } from "../state/vault";
import { NOTES, useWorkspace } from "../state/workspace";
import { openExternalUrl, pageFileUrl } from "./fileUrl";

/** No `allow-same-origin`: that would give pages the app's API. */
const SANDBOX =
  "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
const MIN_EMBED_HEIGHT = 40;
/** Stops pages that grow with their frame from growing forever. */
const MAX_EMBED_HEIGHT = 4000;

let token: Promise<string> | null = null;
let reloads = 0;

function pageToken(): Promise<string> {
  token ??= api
    .appInfo()
    .then((info) => info.pageToken)
    .catch((err: unknown) => {
      token = null;
      throw err;
    });
  return token;
}

function frames(page?: string): HTMLIFrameElement[] {
  return [...document.querySelectorAll<HTMLIFrameElement>("iframe.page-frame")].filter(
    (f) => page === undefined || f.dataset.page === page,
  );
}

async function load(frame: HTMLIFrameElement, reload = false) {
  try {
    const url = pageFileUrl(await pageToken(), frame.dataset.page!);
    // A new query makes the frame load again even if the URL is the same.
    frame.src = reload ? `${url}?reload=${++reloads}` : url;
  } catch {
    // The backend is unreachable; the frame stays blank until it reconnects.
  }
}

/**
 * A frame showing `page` (an `.html` file or `.page` bundle). Embeds size
 * themselves to the page unless given a height (`![[x.page|400]]`).
 */
export function createPageFrame(
  page: string,
  opts: { embed?: boolean; height?: number } = {},
): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.className = "page-frame";
  frame.dataset.page = page;
  frame.title = page.slice(page.lastIndexOf("/") + 1);
  frame.setAttribute("sandbox", SANDBOX);
  if (opts.height) frame.style.height = `${opts.height}px`;
  else if (opts.embed) frame.dataset.autoHeight = "";
  listen();
  void load(frame);
  return frame;
}

/** Makes the tab holding `frame` the active one, so links and shortcuts act on it. */
function activatePanelOf(frame: HTMLIFrameElement) {
  const id = frame.closest<HTMLElement>("[data-panel-id]")?.dataset.panelId;
  const panel = id ? useWorkspace.getState().docks[NOTES]?.getPanel(id) : undefined;
  if (panel && !panel.api.isActive) panel.api.setActive();
}

async function handle(
  frame: HTMLIFrameElement,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const page = frame.dataset.page!;
  switch (method) {
    case "navigate": {
      const target = String(params.target ?? "")
        .trim()
        .replace(/^\[\[(.*)\]\]$/, "$1")
        .split("|")[0]!;
      activatePanelOf(frame);
      await useWorkspace.getState().openLink(page, target, { newTab: params.newTab === true });
      return null;
    }
    case "openExternal": {
      const url = new URL(String(params.url));
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
        throw new Error(`can't open ${url.protocol} links`);
      }
      await openExternalUrl(url.href);
      return null;
    }
    case "readFile": {
      const path = String(params.path);
      const file = await api.readFile(path);
      if (file.text === undefined) throw new Error(`${path} isn't a text file`);
      return file.text;
    }
    case "state.get":
      return api.pageState(page);
    case "state.set":
      await api.setPageState(page, params.state ?? null);
      return null;
    default:
      throw new Error(`unknown bridge call: ${method}`);
  }
}

interface FrameMessage {
  groundwork?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  height?: number;
  key?: string;
  code?: string;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
}

let listening = false;

/** Starts serving frames' bridge calls; done when the first frame is made. */
function listen() {
  if (listening) return;
  listening = true;

  window.addEventListener("message", (event) => {
    const frame = event.source ? frames().find((f) => f.contentWindow === event.source) : undefined;
    const data = event.data as FrameMessage | null;
    if (!frame || !data || typeof data !== "object") return;
    if (data.groundwork === "call") {
      const reply = (body: object) =>
        frame.contentWindow?.postMessage({ groundwork: "reply", id: data.id, ...body }, "*");
      handle(frame, String(data.method), data.params ?? {}).then(
        (result) => reply({ result: result ?? null }),
        (err: unknown) => reply({ error: message(err) }),
      );
    } else if (data.groundwork === "resize") {
      const height = Number(data.height);
      if (!("autoHeight" in frame.dataset) || !(height > 0)) return;
      const clamped = Math.min(Math.max(height, MIN_EMBED_HEIGHT), MAX_EMBED_HEIGHT);
      frame.style.height = `${clamped}px`;
      frame.dispatchEvent(new Event(CONTENT_RESIZED, { bubbles: true }));
    } else if (data.groundwork === "key") {
      activatePanelOf(frame);
      const { key, code, metaKey, shiftKey, altKey, ctrlKey } = data;
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code,
          metaKey,
          shiftKey,
          altKey,
          ctrlKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  });

  // Clicking into a page doesn't reach the app, but focus moving into its
  // frame does: make that tab active, as clicking into a note would.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      const el = document.activeElement;
      if (el instanceof HTMLIFrameElement && el.classList.contains("page-frame"))
        activatePanelOf(el);
    });
  });

  // State saved elsewhere (another frame of the same page, Claude, the CLI).
  transport.listen((event) => {
    if (event.event !== "page.stateChanged") return;
    const { path } = event.payload;
    const targets = frames(path);
    if (!targets.length) return;
    api
      .pageState(path)
      .then((state) => {
        for (const f of targets) f.contentWindow?.postMessage({ groundwork: "state", state }, "*");
      })
      .catch(() => {});
  });

  // Pages reload when their files change (a bundle counts as changed when any
  // file in it does, except its state).
  onVaultChange((changes) => {
    const changed = new Set(
      changes.filter((c) => c.kind === "modified" || c.kind === "created").map((c) => c.path),
    );
    for (const f of frames()) if (changed.has(f.dataset.page!)) void load(f, true);
  });

  // The dev server makes a new token when it restarts.
  transport.onReconnect(() => {
    token = null;
    for (const f of frames()) void load(f, true);
  });
}
