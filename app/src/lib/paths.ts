import type { NodeKind } from "../api/generated/NodeKind";

/**
 * How a vault entry is labelled in the UI. Like Obsidian, notes drop `.md`;
 * other files keep their extension, shown muted.
 */
export function displayName(name: string, kind: NodeKind): { base: string; ext: string } {
  if (kind === "folder") return { base: name, ext: "" };
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" };
  const base = name.slice(0, dot);
  const ext = name.slice(dot);
  return kind === "note" ? { base, ext: "" } : { base, ext };
}

/** An HTML page: a single `.html` file or a `.page` bundle. */
export function isPagePath(path: string): boolean {
  return /\.(html?|page)$/i.test(path);
}

/** Every ancestor folder of a vault-relative path, outermost first. */
export function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}
