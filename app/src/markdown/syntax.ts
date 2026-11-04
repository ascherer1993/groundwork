/**
 * Small, dependency-free helpers for Obsidian syntax, shared by the reading
 * view renderer and the editor. They mirror `crates/core/src/parse.rs`.
 */

export interface WikiTarget {
  /** The link path, without subpath. Empty for same-note links like `[[#Heading]]`. */
  target: string;
  /** `Heading`, `A#B` or `^block-id`, without the leading `#`. */
  subpath?: string;
  alias?: string;
}

/** Splits the inside of `[[...]]`. `\|` (used in tables) also separates the alias. */
export function splitWikilink(inner: string): WikiTarget {
  let link = inner;
  let alias: string | undefined;
  const pipe = inner.indexOf("|");
  if (pipe >= 0) {
    link = inner.slice(0, pipe).replace(/\\$/, "");
    alias = inner.slice(pipe + 1);
  }
  const hash = link.indexOf("#");
  const target = (hash >= 0 ? link.slice(0, hash) : link).trim();
  const subpath = hash >= 0 ? link.slice(hash + 1) || undefined : undefined;
  return { target, subpath, alias };
}

/** `target#subpath`, the form link handlers pass around. */
export function joinTarget({ target, subpath }: WikiTarget): string {
  return subpath ? `${target}#${subpath}` : target;
}

export function splitTarget(href: string): { target: string; subpath?: string } {
  const hash = href.indexOf("#");
  return hash >= 0
    ? { target: href.slice(0, hash), subpath: href.slice(hash + 1) || undefined }
    : { target: href };
}

/** What a wikilink shows when it has no alias. */
export function wikiDisplay({ target, subpath, alias }: WikiTarget): string {
  if (alias) return alias;
  if (!subpath) return target;
  const sub = subpath.replace(/#/g, " > ");
  return target ? `${target} > ${sub}` : sub;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

export function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isImage(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extension(path));
}

/** `true` for links like `https:`, `mailto:`, `obsidian:`. */
export function hasScheme(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/** `|300` or `|300x200` on an image embed sets its size. */
export function imageSize(alias?: string): { width?: number; height?: number } {
  const m = alias?.match(/^(\d+)(?:x(\d+))?$/);
  if (!m) return {};
  return { width: Number(m[1]), height: m[2] ? Number(m[2]) : undefined };
}

export interface Frontmatter {
  /** The YAML between the fences, or `null` when absent. */
  yaml: string | null;
  body: string;
  /** Number of lines before the body (the frontmatter block). */
  lineOffset: number;
  /** Character length of the frontmatter block including fences. */
  length: number;
}

export function splitFrontmatter(text: string): Frontmatter {
  const none = { yaml: null, body: text, lineOffset: 0, length: 0 };
  const first = text.indexOf("\n");
  if (first < 0 || text.slice(0, first).trimEnd() !== "---") return none;
  let offset = first + 1;
  let lines = 1;
  while (offset <= text.length) {
    const next = text.indexOf("\n", offset);
    const end = next < 0 ? text.length : next;
    const line = text.slice(offset, end).trimEnd();
    lines++;
    if (line === "---" || line === "...") {
      const length = next < 0 ? text.length : next + 1;
      return {
        yaml: text.slice(first + 1, offset),
        body: text.slice(length),
        lineOffset: lines,
        length,
      };
    }
    if (next < 0) break;
    offset = next + 1;
  }
  return none;
}

/**
 * The part of a note a `#subpath` points at: a heading's section (up to the
 * next heading of the same or higher level) or the block marked `^id`.
 */
export function extractSubpath(body: string, subpath: string): string | null {
  const lines = body.split("\n");
  if (subpath.startsWith("^")) {
    const id = subpath.slice(1);
    const marker = new RegExp(`(^|\\s)\\^${escapeRegExp(id)}\\s*$`);
    const at = lines.findIndex((l) => marker.test(l));
    if (at < 0) return null;
    // A list item is its own block; a paragraph runs back to the blank line.
    if (/^\s*([-*+]|\d+[.)])\s/.test(lines[at] ?? "")) return lines[at] ?? null;
    let start = at;
    while (start > 0 && (lines[start - 1] ?? "").trim() !== "") start--;
    return lines.slice(start, at + 1).join("\n");
  }
  const wanted = subpath.split("#").pop()!.trim().toLowerCase();
  let level = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(/^(#{1,6})\s+(.*?)\s*$/);
    if (!m) continue;
    const text = m[2]!
      .replace(/\s\^[\w-]+$/, "")
      .trim()
      .toLowerCase();
    if (start < 0) {
      if (text === wanted) {
        level = m[1]!.length;
        start = i;
      }
    } else if (m[1]!.length <= level) {
      return lines.slice(start, i).join("\n").trimEnd();
    }
  }
  return start < 0 ? null : lines.slice(start).join("\n").trimEnd();
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Callout types grouped by colour, as in Obsidian. */
const CALLOUT_GROUPS: Record<string, string[]> = {
  note: ["note", "info", "todo"],
  tip: ["tip", "hint", "important", "abstract", "summary", "tldr"],
  success: ["success", "check", "done"],
  question: ["question", "help", "faq"],
  warning: ["warning", "caution", "attention"],
  danger: ["failure", "fail", "missing", "danger", "error", "bug"],
  example: ["example"],
  quote: ["quote", "cite"],
};

export function calloutGroup(type: string): string {
  const t = type.toLowerCase();
  for (const [group, types] of Object.entries(CALLOUT_GROUPS)) {
    if (types.includes(t)) return group;
  }
  return "note";
}

const TASK_PREFIX = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)(.)(\].*)$/;

/** Today as `YYYY-MM-DD` in local time. */
export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Checks an open task (adding `✅ date` before any block id) or unchecks a
 * done one (removing the stamp). Mirrors `parse::toggle_task_line` in Rust.
 */
export function toggleTaskLine(line: string, date: string): string | null {
  const m = line.match(TASK_PREFIX);
  if (!m) return null;
  const [, prefix, status, rest] = m as unknown as [string, string, string, string];
  if (status === "x" || status === "X") {
    return `${prefix} ${rest.replace(/\s*✅\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu, "")}`;
  }
  const trimmed = rest.trimEnd();
  const block = trimmed.match(/\s\^[A-Za-z0-9-]+$/);
  const stamped = block
    ? `${trimmed.slice(0, block.index).trimEnd()} ✅ ${date}${trimmed.slice(block.index)}`
    : `${trimmed} ✅ ${date}`;
  return `${prefix}x${stamped}`;
}
