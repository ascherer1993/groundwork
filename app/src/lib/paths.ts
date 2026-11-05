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

/**
 * Tabs that show a view rather than a file have a path of their own, so they
 * take part in a tab's history like files: `project:<id>` is a project view.
 */
const PROJECT_VIEW = "project:";

export function projectViewPath(id: string): string {
  return `${PROJECT_VIEW}${id}`;
}

/** The project a project view's path is for. */
export function projectOfView(path: string | null | undefined): string | null {
  return path?.startsWith(PROJECT_VIEW) ? path.slice(PROJECT_VIEW.length) : null;
}

/** A view's path, not a file's. */
export function isViewPath(path: string | null | undefined): boolean {
  return projectOfView(path) !== null;
}
