import fuzzysort from "fuzzysort";
import type { FileSummary } from "../api/generated/FileSummary";

export interface FileMatch {
  file: FileSummary;
  /** Set when the match came from an alias. */
  alias?: string;
}

/** Files whose title, alias or path loosely matches `query`, best first. */
export function matchFiles(files: FileSummary[], query: string, limit = 50): FileMatch[] {
  const q = query.trim();
  if (!q) return files.slice(0, limit).map((file) => ({ file }));
  const results = fuzzysort.go(q, files, {
    keys: ["title", (f: FileSummary) => f.aliases.join("\u0000"), "path"],
    limit,
    threshold: 0.2,
  });
  return results.map((r) => {
    const aliasScore = r[1]?.score ?? 0;
    const titleScore = r[0]?.score ?? 0;
    const alias =
      aliasScore > titleScore ? r.obj.aliases.find((a) => fuzzysort.single(q, a)) : undefined;
    return { file: r.obj, alias };
  });
}

/**
 * The part of a search query that names files: its words, without the
 * operators (`path:`, `#tag`, `-word`) that only make sense for text. A
 * `path:` comes back separately, to narrow the files too.
 */
export function nameQuery(query: string): { words: string; path?: string } {
  let path: string | undefined;
  const words: string[] = [];
  for (const m of query.matchAll(/"([^"]*)"?|(\S+)/g)) {
    const token = m[1] ?? m[2] ?? "";
    if (m[2]?.toLowerCase().startsWith("path:")) path = token.slice(5);
    else if (m[2] && (token.startsWith("#") || token.startsWith("-"))) continue;
    else if (token) words.push(token);
  }
  return { words: words.join(" "), path: path || undefined };
}
