/**
 * Vault files named in terminal output (`Projects/Acme/Kickoff notes.md`,
 * an absolute path into the vault, or one relative to the shell's folder)
 * become links that open the file. Names can have spaces, so instead of
 * guessing where a path ends, this looks for the vault's actual files.
 */
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

export interface VaultPathMatch {
  /** Vault path of the file. */
  path: string;
  /** Character offsets in the line, end exclusive (including any `:line`). */
  start: number;
  end: number;
  line?: number;
}

/**
 * Finds vault files in `text`. `files` are vault paths, `root` the vault's
 * absolute folder, and `cwd` the shell's folder.
 */
export function findVaultPaths(
  text: string,
  files: string[],
  root: string,
  cwd: string,
): VaultPathMatch[] {
  const inside = cwd === root ? "" : cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : null;
  const found: VaultPathMatch[] = [];
  for (const path of files) {
    const forms = [path, `${root}/${path}`];
    if (inside && path.startsWith(`${inside}/`)) forms.push(path.slice(inside.length + 1));
    for (const form of forms) {
      for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + 1)) {
        const end = at + form.length;
        if (!bounded(text, at, end, form)) continue;
        const suffix = /^:(\d+)/.exec(text.slice(end));
        found.push({ path, start: at, end: end + (suffix?.[0].length ?? 0) });
        if (suffix) found[found.length - 1]!.line = Number(suffix[1]);
      }
    }
  }
  // The longest match wins where they overlap (`a.md` inside `Notes/a.md`).
  found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: VaultPathMatch[] = [];
  for (const m of found) {
    if (!kept.some((k) => m.start < k.end && k.start < m.end)) kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Not part of a longer name: `xa.md`, `a.mdx` and `/other/a.md` aren't `a.md`. */
function bounded(text: string, start: number, end: number, form: string): boolean {
  const before = text[start - 1];
  const after = text[end];
  const pathChar = /[\w./~-]/;
  if (before !== undefined && pathChar.test(before) && !form.startsWith("/")) return false;
  return after === undefined || !/[\w/-]/.test(after);
}

/** Links vault files in a terminal's output. */
export function vaultLinkProvider(
  term: Terminal,
  context: () => { files: string[]; root: string; cwd: string } | null,
  open: (path: string, line?: number) => void,
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const ctx = context();
      const line = term.buffer.active.getLine(y - 1);
      if (!ctx || !line) return callback(undefined);
      const text = line.translateToString(true);
      const links: ILink[] = findVaultPaths(text, ctx.files, ctx.root, ctx.cwd).map((m) => ({
        range: { start: { x: m.start + 1, y }, end: { x: m.end, y } },
        text: text.slice(m.start, m.end),
        decorations: { pointerCursor: true, underline: true },
        activate: () => open(m.path, m.line),
      }));
      callback(links.length ? links : undefined);
    },
  };
}
