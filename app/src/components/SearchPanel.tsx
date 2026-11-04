import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { SearchResult } from "../api/generated/SearchResult";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";

const DELAY = 150;

function folderOf(path: string) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Full-text search over the vault's notes. */
export function SearchPanel() {
  const search = useUi((s) => s.search);
  const revision = useVault((s) => s.revision);
  const [query, setQuery] = useState(search.query);
  const [results, setResults] = useState<{ query: string; items: SearchResult[] } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);

  // Searches requested from elsewhere (⌘⇧F, a tag click) replace the query.
  const [nonce, setNonce] = useState(search.nonce);
  if (nonce !== search.nonce) {
    setNonce(search.nonce);
    setQuery(search.query);
  }
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [search.nonce]);

  useEffect(() => {
    useUi.setState((s) => ({ search: { ...s.search, query } }));
    const q = query.trim();
    if (!q) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .search(q)
        .then((items) => !cancelled && setResults({ query: q, items }))
        .catch(() => {});
    }, DELAY);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, revision]);

  const open = useWorkspace.getState().open;
  const shown = query.trim() && results ? results.items : null;
  const toggle = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <div className="search-panel">
      <input
        ref={input}
        className="search-input"
        type="search"
        aria-label="Search notes"
        placeholder="Search notes…"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && shown?.[0]) {
            const first = shown[0];
            open(first.path, { line: first.lines[0]?.line, newTab: e.metaKey });
          }
        }}
      />
      {!shown && (
        <div className="search-help muted">
          <p>Words must all appear in a note.</p>
          <p>
            <code>"exact phrase"</code> <code>-exclude</code> <code>path:folder</code>{" "}
            <code>#tag</code>
          </p>
        </div>
      )}
      {shown && (
        <p className="search-summary muted" aria-live="polite">
          {shown.length === 0
            ? "No matches."
            : `${shown.length}${shown.length >= 100 ? "+" : ""} note${shown.length === 1 ? "" : "s"}`}
        </p>
      )}
      <ul className="search-results" aria-label="Search results">
        {shown?.map((r) => {
          const isCollapsed = collapsed.has(r.path);
          return (
            <li key={r.path} className="search-result">
              <div className="search-file">
                <button
                  className="icon disclosure"
                  aria-label={isCollapsed ? "Expand" : "Collapse"}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(r.path)}
                >
                  <ChevronRight size={12} className={`chevron${isCollapsed ? "" : " open"}`} />
                </button>
                <button
                  className="search-title"
                  title={r.path}
                  onClick={(e) => open(r.path, { line: r.lines[0]?.line, newTab: e.metaKey })}
                >
                  {r.title}
                  <span className="search-folder">{folderOf(r.path)}</span>
                </button>
                {r.hits > 0 && <span className="search-hits">{r.hits}</span>}
              </div>
              {!isCollapsed &&
                r.lines.map((l) => (
                  <button
                    key={l.line}
                    className="search-line"
                    onClick={(e) => open(r.path, { line: l.line, newTab: e.metaKey })}
                  >
                    {l.segments.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : s.text))}
                  </button>
                ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
