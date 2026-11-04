/**
 * Terminal views: xterm.js showing sessions that live in the `groundworkd`
 * daemon (`crates/terminal-daemon`), so they keep running when the app quits.
 * A view attaches for a snapshot of the screen, then follows output events;
 * each event's `seq` says where it goes, so nothing is shown twice or lost.
 */
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ILinkProvider, type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ApiCallError, api, transport } from "../api/client";
import type { Event } from "../api/generated/Event";
import { openExternalUrl } from "./fileUrl";

type Output = Extract<Event, { event: "terminal.output" }>["payload"];

interface Listener {
  output(event: Output): void;
  title(title: string): void;
  exit(): void;
  /** The daemon or the backend went away; attach again. */
  reconnect(): void;
}

const listeners = new Map<string, Set<Listener>>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  const each = (id: string, fn: (l: Listener) => void) => listeners.get(id)?.forEach(fn);
  transport.listen((event) => {
    switch (event.event) {
      case "terminal.output":
        return each(event.payload.id, (l) => l.output(event.payload));
      case "terminal.title":
        return each(event.payload.id, (l) => l.title(event.payload.title));
      case "terminal.exit":
        return each(event.payload.id, (l) => l.exit());
      case "terminal.disconnected":
        return listeners.forEach((set) => set.forEach((l) => l.reconnect()));
    }
  });
  // Browser mode: a restarted dev server isn't attached to anything.
  transport.onReconnect(() => listeners.forEach((set) => set.forEach((l) => l.reconnect())));
}

function subscribe(id: string, listener: Listener): () => void {
  listen();
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(id);
  };
}

function decode(base64: string): Uint8Array {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/** Colours from tokens.css, so terminals follow light and dark mode. */
function theme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim();
  const colours: Record<string, string> = {};
  for (const name of ANSI) {
    colours[name] = v(`--term-${name}`);
    colours[`bright${name[0]!.toUpperCase()}${name.slice(1)}`] = v(`--term-bright-${name}`);
  }
  return {
    ...colours,
    background: v("--bg"),
    foreground: v("--text"),
    cursor: v("--text"),
    cursorAccent: v("--bg"),
    selectionBackground: v("--selection"),
  };
}

export interface TerminalViewOptions {
  /** The session to show. */
  id: string;
  /** Where a replacement shell starts if the session is gone. */
  cwd(): string;
  onTitle(title: string): void;
  /** The program exited. */
  onExit(): void;
  /** The session was gone (the daemon stopped), so a new shell replaced it. */
  onReplaced(id: string): void;
  /** More links in the output (vault paths). */
  links?: (term: Terminal) => ILinkProvider;
}

export interface TerminalView {
  focus(): void;
  dispose(): void;
}

/** For tests and debugging: the xterm.js instance behind a view. */
export type TerminalElement = HTMLElement & { terminal?: Terminal };

export function mountTerminal(el: TerminalElement, opts: TerminalViewOptions): TerminalView {
  let id = opts.id;
  let disposed = false;
  const term = new Terminal({
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 10000,
    theme: theme(),
    // OSC 8 links.
    linkHandler: { activate: (_e, uri) => void openExternalUrl(uri) },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, uri) => void openExternalUrl(uri)));
  term.open(el);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // No WebGL: xterm.js draws with the DOM instead.
  }
  if (opts.links) term.registerLinkProvider(opts.links(term));
  el.terminal = term;

  // A view that isn't on screen (a hidden workspace) follows the session
  // without resizing it, then attaches properly once it has a size.
  let sized = false;
  const refit = () => {
    if (el.clientWidth === 0 || el.clientHeight === 0) return;
    fit.fit();
    if (!sized) {
      sized = true;
      if (started) void attach();
    }
  };
  let started = false;
  refit();

  // Snapshot first, then output from where it left off. Output that arrives
  // before the snapshot waits; output the snapshot already has is skipped.
  let seq = 0;
  let attached = false;
  let early: Output[] = [];
  const output = (event: Output) => {
    if (!attached) {
      early.push(event);
      return;
    }
    if (event.seq < seq) return;
    if (event.seq > seq) {
      // Events were dropped (a slow browser tab): start over from a snapshot.
      void attach();
      return;
    }
    const bytes = decode(event.data);
    seq += bytes.length;
    term.write(bytes);
  };
  let attaching = 0;
  const attach = async () => {
    attached = false;
    early = [];
    const attempt = ++attaching;
    try {
      const snapshot = sized
        ? await api.attachTerminal(id, term.cols, term.rows)
        : await api.attachTerminal(id, 0, 0);
      // A newer attach (the view got a size) replaces this one.
      if (disposed || attempt !== attaching) return;
      term.reset();
      term.write(snapshot.data);
      seq = snapshot.seq;
      attached = true;
      const waiting = early;
      early = [];
      waiting.forEach(output);
    } catch (err) {
      if (disposed || attempt !== attaching) return;
      if (err instanceof ApiCallError && err.code === "not_found") await replace();
      else
        term.write(`\r\n\x1b[2m[${err instanceof Error ? err.message : String(err)}]\x1b[0m\r\n`);
    }
  };
  /** The session is gone (the daemon stopped, or the Mac restarted). */
  const replace = async () => {
    const info = await api.createTerminal({ cols: term.cols, rows: term.rows }, opts.cwd());
    if (disposed) return void api.killTerminal(info.id).catch(() => {});
    unsubscribe();
    id = info.id;
    unsubscribe = subscribe(id, listener);
    opts.onReplaced(id);
    await attach();
  };

  const listener: Listener = {
    output,
    title: (title) => opts.onTitle(title),
    exit: () => opts.onExit(),
    reconnect: () => void attach(),
  };
  let unsubscribe = subscribe(id, listener);
  started = true;
  void attach();

  // Keystrokes go one call at a time, so they arrive in order.
  let queued = "";
  let sending = false;
  const send = async (data: string) => {
    queued += data;
    if (sending) return;
    sending = true;
    while (queued) {
      const chunk = queued;
      queued = "";
      await api.terminalInput(id, chunk).catch(() => {});
    }
    sending = false;
  };
  term.onData((data) => void send(data));

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  term.onResize(({ cols, rows }) => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (attached) void api.resizeTerminal(id, cols, rows).catch(() => {});
    }, 50);
  });
  const observer = new ResizeObserver(refit);
  observer.observe(el);

  term.attachCustomKeyEventHandler((e) => {
    // Claude Code reads ESC CR as a newline in its prompt.
    if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.type === "keydown") void send("\x1b\r");
      return false;
    }
    // ⌘ shortcuts are the app's. Copy and paste still work: they arrive as
    // clipboard events, not keys.
    return !e.metaKey;
  });

  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const retheme = () => (term.options.theme = theme());
  scheme.addEventListener("change", retheme);

  return {
    focus: () => term.focus(),
    dispose() {
      disposed = true;
      unsubscribe();
      observer.disconnect();
      scheme.removeEventListener("change", retheme);
      clearTimeout(resizeTimer);
      term.dispose();
    },
  };
}
