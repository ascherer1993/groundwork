import { Columns3 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TodoFilter } from "../api/generated/TodoFilter";
import { TODO_BOARD } from "../lib/paths";
import { mountTodos } from "../markdown/todos";
import { useWorkspace } from "../state/workspace";

/** `#tag`, `path:…` and `p1` narrow the list; other words match the text. */
export function filterOf(query: string): TodoFilter {
  const filter: TodoFilter = { tags: [] };
  const words: string[] = [];
  for (const word of query.trim().split(/\s+/).filter(Boolean)) {
    if (word.startsWith("#") && word.length > 1) filter.tags.push(word.slice(1));
    else if (/^path:./i.test(word)) filter.path = word.slice(5);
    else if (/^p[0-5]$/i.test(word)) filter.maxPriority = Number(word[1]);
    else words.push(word);
  }
  if (words.length) filter.text = words.join(" ");
  return filter;
}

/** Every open todo in the vault, grouped by when it's due. */
export function TodosPanel() {
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => {
      stop = mountTodos(el, { kind: "agenda", filter: filterOf(query) }, "");
    }, 120);
    return () => {
      clearTimeout(timer);
      stop?.();
    };
  }, [query]);

  return (
    <div className="todos-panel">
      <div className="todos-panel-head">
        <input
          className="search-input"
          type="search"
          aria-label="Filter todos"
          placeholder="Filter…  #tag  path:Projects  p1"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="icon"
          aria-label="Open the todo board"
          title="Open the todo board (a week by day)"
          onClick={(e) => useWorkspace.getState().open(TODO_BOARD, { newTab: e.metaKey })}
        >
          <Columns3 size={15} />
        </button>
      </div>
      <div ref={list} aria-label="Todos" role="region" />
    </div>
  );
}
