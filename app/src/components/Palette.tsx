import fuzzysort from "fuzzysort";
import { useMemo, useState } from "react";
import { type PaletteItem, useUi } from "../state/ui";
import { message } from "../state/vault";

const RECENT_LIMIT = 20;

function loadRecent(key: string | undefined): string[] {
  if (!key) return [];
  try {
    return JSON.parse(localStorage.getItem(`groundwork.recent:${key}`) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function saveRecent(key: string | undefined, id: string) {
  if (!key) return;
  const ids = [id, ...loadRecent(key).filter((r) => r !== id)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(`groundwork.recent:${key}`, JSON.stringify(ids));
  } catch {
    // Storage can be unavailable; recents just won't be remembered.
  }
}

/** A filterable list of things to run: the command palette, template pickers… */
export function Palette() {
  const palette = useUi((s) => s.palette);
  return palette ? <PaletteList key={palette.id} palette={palette} /> : null;
}

function PaletteList({
  palette,
}: {
  palette: NonNullable<ReturnType<typeof useUi.getState>["palette"]>;
}) {
  const close = useUi((s) => s.closePalette);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const items: PaletteItem[] = useMemo(() => {
    const q = query.trim();
    if (!q) {
      const recent = loadRecent(palette.recentKey);
      const rank = (item: PaletteItem) => {
        const i = recent.indexOf(item.id);
        return i < 0 ? RECENT_LIMIT : i;
      };
      return [...palette.items].sort((a, b) => rank(a) - rank(b));
    }
    return fuzzysort
      .go(q, palette.items, { keys: ["label", "detail"], threshold: 0.2 })
      .map((r) => r.obj);
  }, [palette, query]);

  async function choose(item: PaletteItem | undefined) {
    if (!item) return;
    close();
    saveRecent(palette.recentKey, item.id);
    try {
      await item.run();
    } catch (err) {
      useUi.getState().notify(message(err));
    }
  }

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className="switcher"
        role="dialog"
        aria-label={palette.placeholder}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="switcher-input"
          aria-label={palette.placeholder}
          placeholder={palette.placeholder}
          value={query}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, items.length - 1));
            } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              void choose(items[index]);
            }
          }}
        />
        <ul className="switcher-results" role="listbox" aria-label={palette.placeholder}>
          {items.map((item, i) => (
            <li
              key={item.id}
              role="option"
              aria-selected={i === index}
              className={i === index ? "selected" : undefined}
              onMouseMove={() => setIndex(i)}
              onClick={() => void choose(item)}
            >
              <span className="switcher-title">{item.label}</span>
              {item.detail && <span className="switcher-alias">{item.detail}</span>}
              {item.hint && <span className="switcher-hint">{item.hint}</span>}
            </li>
          ))}
          {items.length === 0 && <li className="muted">No matches</li>}
        </ul>
      </div>
    </div>
  );
}
