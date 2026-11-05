/**
 * The command bar's own window (`command-bar.html`): a panel the global
 * shortcut shows over whatever app and Space you're on, without bringing
 * Groundwork forward (`src-tauri/src/command_bar.rs`, which also hides it
 * when you click elsewhere). The main window tells it what was open, and it
 * hands requests back to the main window to start.
 */
import { invoke } from "@tauri-apps/api/core";
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

  const close = () => invoke("hide_command_bar");

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
          await close();
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
