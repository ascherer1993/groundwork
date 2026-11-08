import { useState } from "react";

/**
 * The side panels' widths: the sidebar's, and the links panel's (one width
 * for every tab's). Each is a CSS variable from `tokens.css`, overridden on
 * the root element and remembered in localStorage.
 */
const PANELS = {
  sidebar: {
    variable: "--sidebar-width",
    storage: "groundwork.sidebarWidth",
    label: "Resize sidebar",
    min: 180,
    max: 560,
    // Dragging right widens it.
    grows: 1,
  },
  links: {
    variable: "--right-width",
    storage: "groundwork.linksWidth",
    label: "Resize links panel",
    min: 200,
    max: 640,
    grows: -1,
  },
} as const;

export type Panel = keyof typeof PANELS;

function clamp(panel: Panel, px: number) {
  const { min, max } = PANELS[panel];
  return Math.round(Math.min(max, Math.max(min, px)));
}

function apply(panel: Panel, px: number | null) {
  const { variable } = PANELS[panel];
  const root = document.documentElement.style;
  if (px === null) root.removeProperty(variable);
  else root.setProperty(variable, `${px}px`);
}

function save(panel: Panel, px: number | null) {
  try {
    if (px === null) localStorage.removeItem(PANELS[panel].storage);
    else localStorage.setItem(PANELS[panel].storage, String(px));
  } catch {
    // Not remembered.
  }
}

/**
 * The panel's width as laid out (a `max-width` can hold it under its
 * variable): the sidebar holds its handle; the links panel follows its.
 */
function current(panel: Panel, handle: HTMLElement): number {
  const el = panel === "sidebar" ? handle.parentElement : handle.nextElementSibling;
  return el?.getBoundingClientRect().width || PANELS[panel].min;
}

/** Puts back the widths the panels were last given. Call once at startup. */
export function restorePanelWidths() {
  for (const panel of Object.keys(PANELS) as Panel[]) {
    try {
      const px = Number(localStorage.getItem(PANELS[panel].storage));
      if (px > 0) apply(panel, clamp(panel, px));
    } catch {
      // Defaults, then.
    }
  }
}

/**
 * The edge of a side panel: drag it to resize the panel, double-click to
 * put it back to its usual width, or use ← and → when focused.
 */
export function ResizeHandle({ panel, className }: { panel: Panel; className: string }) {
  const { label, min, max, grows } = PANELS[panel];
  const [now, setNow] = useState<number | null>(null);

  const set = (px: number) => {
    const width = clamp(panel, px);
    apply(panel, width);
    setNow(width);
    return width;
  };

  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget;
    const x = e.clientX;
    const from = current(panel, target);
    let width = from;
    target.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      width = set(from + (ev.clientX - x) * grows);
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      document.body.classList.remove("resizing");
      save(panel, width);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };

  return (
    <div
      className={`resize-handle ${className}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={now ?? undefined}
      tabIndex={0}
      title="Drag to resize; double-click to reset"
      onPointerDown={start}
      onDoubleClick={() => {
        apply(panel, null);
        save(panel, null);
        setNow(null);
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const step = (e.key === "ArrowRight" ? 16 : -16) * grows;
        save(panel, set(current(panel, e.currentTarget) + step));
      }}
    />
  );
}
