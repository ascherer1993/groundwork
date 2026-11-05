/**
 * The command bar's own window (`command-bar.html`), which the global
 * shortcut shows over whatever app you're in. The main window tells it what
 * was open, and it hands requests back to the main window to start.
 */
import { hide } from "@tauri-apps/api/app";
import { emitTo, listen } from "@tauri-apps/api/event";
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { CommandBar } from "./components/CommandBar";
import { type BarOpening, OPEN_EVENT, START_EVENT } from "./lib/commandBar";
import "./styles/tokens.css";
import "./styles/app.css";

function CommandBarWindow() {
  const [opening, setOpening] = useState<(BarOpening & { n: number }) | null>(null);
  const form = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stop = listen<BarOpening>(OPEN_EVENT, (e) =>
      setOpening((was) => ({ ...e.payload, n: (was?.n ?? 0) + 1 })),
    );
    return () => void stop.then((s) => s());
  }, []);

  /** Hides the bar; if you came from another app, goes back to it. */
  const close = async (showing = false) => {
    await getCurrentWindow().hide();
    if (!showing && opening && !opening.wasActive) await hide();
  };

  // Clicking elsewhere closes it, as Spotlight does.
  useEffect(() => {
    const stop = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) void getCurrentWindow().hide();
    });
    return () => void stop.then((s) => s());
  }, []);

  // The window is the bar's size.
  useEffect(() => {
    const el = form.current;
    if (!el) return;
    const fit = new ResizeObserver(() => {
      void getCurrentWindow().setSize(new LogicalSize(640, Math.ceil(el.offsetHeight)));
    });
    fit.observe(el);
    return () => fit.disconnect();
  }, [opening?.n]);

  if (!opening) return null;
  return (
    <div ref={form} className="command-bar-window">
      <CommandBar
        key={opening.n}
        chips={opening.chips}
        onClose={() => void close()}
        onStart={async (request) => {
          await emitTo("main", START_EVENT, request);
          await close(request.show);
        }}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CommandBarWindow />
  </React.StrictMode>,
);
