import { ChevronRight, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { SearchResult } from "../api/generated/SearchResult";
import type { SmartResult } from "../api/generated/SmartResult";
import { type FileMatch, matchFiles, nameQuery } from "../lib/fileMatch";
import { useSmart, useSmartReady } from "../state/smart";
import { showSettings } from "./SettingsDialog";
import { useUi } from "../state/ui";
import { message, useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";

const DELAY = 150;
/** File names shown before "Show all". */
const NAMES_SHOWN = 6;

/** What a search looks in: file names (and aliases), and the text of notes. */
interface Kinds {
  names: boolean;
  text: boolean;
}

const KINDS_KEY = "groundwork.search.kinds";

function savedKinds(): Kinds {
  try {
    const saved = JSON.parse(localStorage.getItem(KINDS_KEY) ?? "null") as Partial<Kinds> | null;
    if (saved && (saved.names || saved.text)) return { names: !!saved.names, text: !!saved.text };
  } catch {
    // Both, as by default.
  }
  return { names: true, text: true };
}

function saveKinds(kinds: Kinds) {
  try {
    localStorage.setItem(KINDS_KEY, JSON.stringify(kinds));
  } catch {
    // Not remembered.
  }
}

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
                onClick={(e) => open(r.path, { line: r.line ?? undefined, newTab: e.metaKey })}
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
                onClick={(e) => open(r.path, { line: r.line ?? undefined, newTab: e.metaKey })}
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

/** Files by name, the text of notes, or both; or smart search by meaning. */
export function SearchPanel() {
  const search = useUi((s) => s.search);
  const revision = useVault((s) => s.revision);
  const files = useVault((s) => s.files);
  const [kinds, setKinds] = useState(savedKinds);
  // "Show all" names, for the query it was pressed on.
  const [allFor, setAllFor] = useState<string | null>(null);
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
  }, [query]);

  useEffect(() => {
    const q = query.trim();
    if (!q || smart || !kinds.text) return;
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
  }, [query, revision, smart, kinds.text]);

  const names: FileMatch[] | null = useMemo(() => {
    if (!kinds.names || smart) return null;
    const { words, path } = nameQuery(query);
    if (!words) return null;
    const within = path
      ? files.filter((f) => f.path.toLowerCase().includes(path.toLowerCase()))
      : files;
    return matchFiles(within, words, 100);
  }, [files, query, kinds.names, smart]);

  const allNames = allFor === query;
  const open = useWorkspace.getState().open;
  const shown = kinds.text && query.trim() && results ? results.items : null;
  const searching = !!query.trim();
  const nothing = searching && !names?.length && (!kinds.text || shown?.length === 0);
  const setKind = (kind: keyof Kinds, on: boolean) => {
    const next = { ...kinds, [kind]: on };
    setKinds(next);
    saveKinds(next);
    input.current?.focus();
  };
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
            } else if (names?.[0]) {
              open(names[0].file.path, { newTab: e.metaKey });
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
      {!smart && (
        <div className="search-kinds" role="group" aria-label="Search in">
          {(
            [
              ["names", "File names"],
              ["text", "Text in notes"],
            ] as const
          ).map(([kind, label]) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={kinds[kind]}
                // One of them is always on.
                disabled={kinds[kind] && !kinds[kind === "names" ? "text" : "names"]}
                onChange={(e) => setKind(kind, e.target.checked)}
              />
              {label}
            </label>
          ))}
        </div>
      )}
      {smart ? (
        <SmartResults ask={smartAsk} />
      ) : (
        <>
          {!searching && (
            <div className="search-help muted">
              {kinds.text ? (
                <>
                  <p>Words must all appear in a note.</p>
                  <p>
                    <code>"exact phrase"</code> <code>-exclude</code> <code>path:folder</code>{" "}
                    <code>#tag</code>
                  </p>
                </>
              ) : (
                <p>
                  Finds files by name or alias. <code>path:folder</code> narrows them.
                </p>
              )}
            </div>
          )}
          {nothing && (
            <p className="search-summary muted" aria-live="polite">
              No matches.
            </p>
          )}
          {!!names?.length && (
            <section className="search-section" aria-label="File names">
              <h3 className="search-heading">
                File names{" "}
                <span className="count">{names.length >= 100 ? "100+" : names.length}</span>
              </h3>
              <ul className="search-names" aria-label="Matching files">
                {(allNames ? names : names.slice(0, NAMES_SHOWN)).map(({ file, alias }) => (
                  <li key={file.path}>
                    <button
                      className="search-name"
                      title={file.path}
                      onClick={(e) => open(file.path, { newTab: e.metaKey })}
                    >
                      {alias ?? file.title}
                      {alias && <span className="search-alias">→ {file.title}</span>}
                      <span className="search-folder">{folderOf(file.path)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {names.length > NAMES_SHOWN && (
                <button
                  className="link-button search-more"
                  onClick={() => setAllFor(allNames ? null : query)}
                >
                  {allNames ? "Show fewer" : `Show all ${names.length}`}
                </button>
              )}
            </section>
          )}
          {!!shown?.length && (
            <h3 className="search-heading">
              Text in notes{" "}
              <span className="count">
                {shown.length}
                {shown.length >= 100 ? "+" : ""}
              </span>
            </h3>
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
