import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { insertIcon } from "../lib/canvas";
import { iconComponent, iconLabel, searchIcons } from "../lib/canvasIcons";

/**
 * Icons to put on a canvas (PLAN §5.17): common ones first, and a search over
 * all of Lucide's. Clicking one puts it in the middle of the view, selected,
 * and the picker stays open for the next.
 */
export function IconPicker({
  excalidraw,
  onClose,
}: {
  excalidraw: ExcalidrawImperativeAPI;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const names = useMemo(() => searchIcons(query), [query]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  return (
    <div
      className="icon-picker"
      role="dialog"
      aria-label="Icons"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="icon-picker-head">
        <input
          ref={input}
          type="search"
          placeholder="Search icons"
          aria-label="Search icons"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && names[0]) insertIcon(excalidraw, names[0]);
          }}
        />
        <button type="button" className="canvas-tool" aria-label="Close icons" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {names.length ? (
        <div className="icon-grid">
          {names.map((name) => {
            const Icon = iconComponent(name);
            if (!Icon) return null;
            const label = iconLabel(name);
            return (
              <button
                key={name}
                type="button"
                className="icon-choice"
                title={label}
                aria-label={label}
                onClick={() => insertIcon(excalidraw, name)}
              >
                <Icon size={20} strokeWidth={1.75} />
              </button>
            );
          })}
        </div>
      ) : (
        <p className="icon-picker-empty">No icons match “{query}”.</p>
      )}
    </div>
  );
}
