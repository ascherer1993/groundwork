import { useMemo, useState } from "react";
import { api } from "../api/client";
import { type FileMatch, matchFiles } from "../lib/fileMatch";
import { useUi } from "../state/ui";
import { message, useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";

function folderOf(path: string) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** ⌘O: jump to any file by name or alias; Enter on no match creates a note. */
export function QuickSwitcher() {
  const files = useVault((s) => s.files);
  const setSwitcher = useUi((s) => s.setSwitcher);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const items = useMemo(() => matchFiles(files, query), [files, query]);

  const close = () => setSwitcher(false);

  async function choose(item: FileMatch | undefined, newTab: boolean) {
    close();
    const ws = useWorkspace.getState();
    if (item) {
      ws.open(item.file.path, { newTab });
      return;
    }
    const name = query.trim();
    if (!name) return;
    try {
      // Placed like a link to a missing note, so "2026-11-04" lands in Daily/.
      const path = await api.createFromLink(ws.activePath ?? "", name);
      ws.open(path, { newTab });
    } catch (err) {
      useUi.getState().notify(message(err));
    }
  }

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className="switcher"
        role="dialog"
        aria-label="Quick switcher"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="switcher-input"
          aria-label="Find a file"
          placeholder="Find or create a note…"
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
              // Shift+Enter always creates, like Obsidian.
              void choose(e.shiftKey ? undefined : items[index], e.metaKey);
            }
          }}
        />
        <ul className="switcher-results" role="listbox" aria-label="Files">
          {items.map((item, i) => (
            <li
              key={item.file.path}
              role="option"
              aria-selected={i === index}
              className={i === index ? "selected" : undefined}
              onMouseMove={() => setIndex(i)}
              onClick={(e) => void choose(item, e.metaKey)}
            >
              <span className="switcher-title">{item.alias ?? item.file.title}</span>
              {item.alias && <span className="switcher-alias">→ {item.file.title}</span>}
              <span className="switcher-path">{folderOf(item.file.path)}</span>
            </li>
          ))}
          {items.length === 0 && query.trim() && (
            <li className="switcher-create selected" onClick={() => void choose(undefined, false)}>
              Create “{query.trim()}” <kbd>↵</kbd>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
