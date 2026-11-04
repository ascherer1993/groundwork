// The page bridge, injected at the top of every HTML document served to a
// page frame (see page_server.rs). It defines `window.groundwork` and talks to the
// app with postMessage; the frame is sandboxed with no origin of its own, so
// this is its only way in. `__CONFIG__` is replaced with `{ page, prefix }`:
// the page's vault path and the URL path vault files are served under.
(() => {
  const config = __CONFIG__;
  const app = window.parent;
  if (app === window) return;

  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  // The state as this frame last saw it, so echoes of its own saves are quiet.
  let known;

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      app.postMessage({ groundwork: "call", id, method, params }, "*");
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== app) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.groundwork === "reply") {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if ("error" in message) call.reject(new Error(message.error));
      else call.resolve(message.result);
    } else if (message.groundwork === "state") {
      const json = JSON.stringify(message.state ?? null);
      if (json === known) return;
      known = json;
      for (const listener of listeners) {
        try {
          listener(message.state ?? null);
        } catch (err) {
          console.error(err);
        }
      }
    }
  });

  const root = new URL(config.prefix, location.href).href;

  /** A vault path for a URL, or null if it isn't a vault file. */
  function vaultPath(url) {
    if (!url.href.startsWith(root)) return null;
    return url.pathname
      .slice(config.prefix.length)
      .split("/")
      .map(decodeURIComponent)
      .join("/")
      .replace(/\/$/, "");
  }

  /** `/x` is from the vault root; anything else is relative to this document. */
  function resolve(path) {
    path = String(path);
    if (path.startsWith("/")) return path.replace(/^\/+/, "");
    const resolved = vaultPath(new URL(path, location.href));
    if (resolved === null) throw new Error(`${path} is outside the vault`);
    return resolved;
  }

  const groundwork = {
    /** This page's vault path. */
    path: config.page,
    /** Opens a note or file in Groundwork: `"[[Note]]"`, a link target, or a path. */
    navigate(target, options = {}) {
      return call("navigate", { target: String(target), newTab: !!options.newTab });
    },
    /** A vault file's text. Paths work like links in the page; `/` is the vault root. */
    readFile(path) {
      return call("readFile", { path: resolve(path) });
    },
    state: {
      /** The saved state, or null. */
      async get() {
        const state = await call("state.get");
        known = JSON.stringify(state ?? null);
        return state ?? null;
      },
      /** Saves `state` (anything JSON can hold), replacing what was there. */
      async set(state) {
        const json = JSON.stringify(state ?? null);
        known = json;
        await call("state.set", { state: JSON.parse(json) });
      },
    },
    /** Calls `listener(state)` when the state changes elsewhere. Returns an unsubscribe function. */
    onStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  Object.defineProperty(window, "groundwork", { value: Object.freeze(groundwork) });

  // Sandboxed frames can't use web storage; give pages that expect it a
  // stand-in that lasts until reload. `groundwork.state` is the lasting kind.
  for (const name of ["localStorage", "sessionStorage"]) {
    try {
      void window[name];
    } catch {
      const items = new Map();
      const storage = {
        get length() {
          return items.size;
        },
        key: (i) => [...items.keys()][i] ?? null,
        getItem: (k) => (items.has(String(k)) ? items.get(String(k)) : null),
        setItem: (k, v) => void items.set(String(k), String(v)),
        removeItem: (k) => void items.delete(String(k)),
        clear: () => items.clear(),
      };
      Object.defineProperty(window, name, { value: storage, configurable: true });
    }
  }

  // Links: vault files open in Groundwork (in-bundle pages navigate here),
  // web links open in the browser. Runs last, so pages can handle their own.
  window.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    const newTab = event.metaKey || event.ctrlKey;
    const wiki = /^\s*\[\[(.+)\]\]\s*$/.exec(link.getAttribute("href"));
    if (wiki) {
      event.preventDefault();
      void call("navigate", { target: wiki[1], newTab });
      return;
    }
    const url = new URL(link.href, location.href);
    const path = vaultPath(url);
    if (path !== null) {
      const here = new URL(location.href);
      if (url.pathname === here.pathname && url.hash) return;
      if (path === config.page || path.startsWith(`${config.page}/`)) return;
      event.preventDefault();
      const hash = url.hash ? decodeURIComponent(url.hash) : "";
      void call("navigate", { target: path + hash, newTab });
    } else if (/^(https?|mailto):$/.test(url.protocol)) {
      event.preventDefault();
      void call("openExternal", { url: url.href });
    }
  });

  // App shortcuts (⌘P, ⌘O, ⌘W…) still work while the page has focus.
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || !event.metaKey) return;
    if ("acvxz".includes(event.key.toLowerCase())) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    const { key, code, metaKey, shiftKey, altKey, ctrlKey } = event;
    app.postMessage({ groundwork: "key", key, code, metaKey, shiftKey, altKey, ctrlKey }, "*");
  });

  // Embeds size themselves to the content.
  let height = 0;
  const report = () => {
    const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (h === height) return;
    height = h;
    app.postMessage({ groundwork: "resize", height: h }, "*");
  };
  new ResizeObserver(report).observe(document.documentElement);
  window.addEventListener("load", report);
})();
