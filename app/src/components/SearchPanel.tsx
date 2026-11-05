import { ChevronRight, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { SearchResult } from "../api/generated/SearchResult";
import type { SmartResult } from "../api/generated/SmartResult";
import { useSmart, useSmartReady } from "../state/smart";
import { showSettings } from "./SettingsDialog";
import { useUi } from "../state/ui";
import { message, useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";

const DELAY = 150;

function folderOf(path: string) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** A smart search: the query as it was when Enter was pressed. */
interface SmartAsk {
  query: string;
  run: number;
}

/** Notes found by meaning: searched on Enter, since qmd takes a moment. */
function SmartResults({ ask }: { ask: SmartAsk | null }) {
  const [state, setState] = useState<
    { run: number; items: SmartResult[] } | { run: number; error: string } | null
  >(null);
  const open = useWorkspace.getState().open;

  useEffect(() => {
    if (!ask) return;
    let cancelled = false;
    api
      .smartSearch(ask.query)
      .then((items) => !cancelled && setState({ run: ask.run, items }))
      .catch((err) => !cancelled && setState({ run: ask.run, error: message(err) }));
    return () => {
      cancelled = true;
    };
  }, [ask]);

  if (!ask) {
    return (
      <div className="search-help muted">
        <p>Finds notes by meaning, not just their words. Press Enter to search.</p>
      </div>
    );
  }
  if (state?.run !== ask.run) {
    return (
      <p className="search-summary muted" aria-live="polite">
        Searching…
      </p>
    );
  }
  if ("error" in state) {
    return (
      <p className="search-summary error" role="alert">
        {state.error}
      </p>
    );
  }
  return (
    <>
      <p className="search-summary muted" aria-live="polite">
        {state.items.length === 0
          ? "Nothing found."
          : `${state.items.length} note${state.items.length === 1 ? "" : "s"} about “${ask.query}”`}
      </p>
      <ul className="search-results" aria-label="Search results">
        {state.items.map((r) => (
          <li key={r.path} className="search-result">
            <div className="search-file">
              <button
                className="search-title smart-title"
                title={r.path}
                onClick={(e) => open(r.path, { newTab: e.metaKey })}
              >
                {r.title}
                <span className="search-folder">{folderOf(r.path)}</span>
              </button>
              <span className="search-hits" title="How well it matches">
                {Math.round(r.score * 100)}%
              </span>
            </div>
            {r.snippet && (
              <button
                className="search-line smart-snippet"
                onClick={(e) => open(r.path, { newTab: e.metaKey })}
              >
                {r.snippet}
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Full-text search over the vault's notes, or smart search by meaning. */
export function SearchPanel() {
  const search = useUi((s) => s.search);
  const revision = useVault((s) => s.revision);
  const [query, setQuery] = useState(search.query);
  const [results, setResults] = useState<{ query: string; items: SearchResult[] } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const [smart, setSmart] = useState(false);
  const [smartAsk, setSmartAsk] = useState<SmartAsk | null>(null);
  const smartReady = useSmartReady();
  useEffect(() => {
    void useSmart.getState().load();
  }, []);

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
    if (!q || smart) return;
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
  }, [query, revision, smart]);

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
      <div className="search-bar">
        <input
          ref={input}
          className="search-input"
          type="search"
          aria-label="Search notes"
          placeholder={smart ? "Ask about your notes…" : "Search notes…"}
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            if (smart) {
              const q = query.trim();
              setSmartAsk(q ? { query: q, run: (smartAsk?.run ?? 0) + 1 } : null);
            } else if (shown?.[0]) {
              const first = shown[0];
              open(first.path, { line: first.lines[0]?.line, newTab: e.metaKey });
            }
          }}
        />
        <button
          type="button"
          className={`smart-toggle${smart ? " active" : ""}`}
          aria-pressed={smart}
          title={
            smartReady
              ? "Smart search: find notes by meaning (qmd)"
              : "Smart search finds notes by meaning. Set it up in Settings."
          }
          onClick={() => {
            if (!smartReady) return showSettings("Search");
            setSmart(!smart);
            input.current?.focus();
          }}
        >
          <Sparkles size={13} /> Smart
        </button>
      </div>
      {smart ? (
        <SmartResults ask={smartAsk} />
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
