import { Columns3 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TodoFilter } from "../api/generated/TodoFilter";
import { TODO_BOARD } from "../lib/paths";
import { mountTodos, TODO_GROUPINGS, type TodoGrouping } from "../markdown/todos";
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

const GROUP_KEY = "groundwork.todosGroup";
const FOLDED_KEY = "groundwork.todosFolded";

function savedGroup(): TodoGrouping {
  try {
    const g = localStorage.getItem(GROUP_KEY);
    return (TODO_GROUPINGS as (string | null)[]).includes(g) ? (g as TodoGrouping) : "note";
  } catch {
    return "note";
  }
}

/** The folded sections of each grouping, remembered across filters and runs. */
const foldedSets = new Map<TodoGrouping, Set<string>>();

function foldedFor(group: TodoGrouping): Set<string> {
  let set = foldedSets.get(group);
  if (!set) {
    set = new Set();
    try {
      const ids: unknown = JSON.parse(localStorage.getItem(`${FOLDED_KEY}.${group}`) ?? "[]");
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") set.add(id);
    } catch {
      // Nothing folded.
    }
    foldedSets.set(group, set);
  }
  return set;
}

function saveFolded(group: TodoGrouping) {
  try {
    localStorage.setItem(`${FOLDED_KEY}.${group}`, JSON.stringify([...foldedFor(group)]));
  } catch {
    // Not remembered.
  }
}

/** Every open todo in the vault, grouped by note, priority or due date. */
export function TodosPanel() {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<TodoGrouping>(savedGroup);
  const list = useRef<HTMLDivElement>(null);
  const choose = (g: TodoGrouping) => {
    setGroup(g);
    try {
      localStorage.setItem(GROUP_KEY, g);
    } catch {
      // Not remembered.
    }
  };

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => {
      stop = mountTodos(
        el,
        {
          kind: "agenda",
          filter: filterOf(query),
          group,
          folded: foldedFor(group),
          onFold: () => saveFolded(group),
        },
        "",
      );
    }, 120);
    return () => {
      clearTimeout(timer);
      stop?.();
    };
  }, [query, group]);

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
      <div className="tickets-controls todos-controls">
        <label>
          Group by{" "}
          <select value={group} onChange={(e) => choose(e.target.value as TodoGrouping)}>
            <option value="note">Note</option>
            <option value="priority">Priority</option>
            <option value="due">Due date</option>
          </select>
        </label>
      </div>
      <div ref={list} aria-label="Todos" role="region" />
    </div>
  );
}
