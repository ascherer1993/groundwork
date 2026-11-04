import fuzzysort from "fuzzysort";
import { useMemo, useState } from "react";
import { api } from "../api/client";
import type { FileSummary } from "../api/generated/FileSummary";
import { useUi } from "../state/ui";
import { message, useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";

function folderOf(path: string) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

interface Item {
  file: FileSummary;
  /** Set when the match came from an alias. */
  alias?: string;
}

/** ⌘O: jump to any file by name or alias; Enter on no match creates a note. */
export function QuickSwitcher() {
  const files = useVault((s) => s.files);
  const setSwitcher = useUi((s) => s.setSwitcher);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const items: Item[] = useMemo(() => {
    const q = query.trim();
    if (!q) return files.slice(0, 50).map((file) => ({ file }));
    const results = fuzzysort.go(q, files, {
      keys: ["title", (f: FileSummary) => f.aliases.join("\u0000"), "path"],
      limit: 50,
      threshold: 0.2,
    });
    return results.map((r) => {
      const aliasScore = r[1]?.score ?? 0;
      const titleScore = r[0]?.score ?? 0;
      const alias =
        aliasScore > titleScore ? r.obj.aliases.find((a) => fuzzysort.single(q, a)) : undefined;
      return { file: r.obj, alias };
    });
  }, [files, query]);

  const close = () => setSwitcher(false);

  async function choose(item: Item | undefined, newTab: boolean) {
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
