import type { TreeNode } from "../api/generated/TreeNode";

/**
 * Subnotes (PLAN §5.15): `Name.key.md` beside `Name.md` belongs to it, like a
 * meeting's transcript. The key starts with a letter, so `Release 1.2` isn't
 * a subnote of `Release 1`. They nest: `Name.a.b.md` belongs to `Name.a.md`
 * when that exists, else to `Name.md`. Mirrors `crates/core/src/subnotes.rs`.
 */

/** The key of `stem` as a subnote of `parent` ("Standup.transcript" → "transcript"). */
export function subkey(parent: string, stem: string): string | null {
  if (!stem.startsWith(`${parent}.`)) return null;
  const rest = stem.slice(parent.length + 1);
  return /^\p{L}/u.test(rest) ? rest : null;
}

function noteStem(name: string): string | null {
  return /\.md$/i.test(name) && name.length > 3 ? name.slice(0, -3) : null;
}

/** A folder's entry with the subnotes listed under it. */
export type Grouped = {
  node: TreeNode;
  /** As a subnote, its key relative to the note it's under ("transcript"). */
  key?: string;
  subnotes: Grouped[];
};

/** The nearest note among `stems` that `stem` is a subnote of. */
function parentStem(stem: string, stems: Set<string>): string | null {
  for (let end = stem.lastIndexOf("."); end > 0; end = stem.lastIndexOf(".", end - 1)) {
    const candidate = stem.slice(0, end);
    if (stems.has(candidate) && subkey(candidate, stem)) return candidate;
  }
  return null;
}

/** A folder's children with each subnote moved under its note, order kept. */
export function groupSubnotes(children: TreeNode[]): Grouped[] {
  const stems = new Set<string>();
  for (const c of children) {
    const stem = c.kind === "note" ? noteStem(c.name) : null;
    if (stem) stems.add(stem);
  }
  const byStem = new Map<string, Grouped>();
  const all = children.map((node) => {
    const g: Grouped = { node, subnotes: [] };
    const stem = node.kind === "note" ? noteStem(node.name) : null;
    if (stem) byStem.set(stem, g);
    return g;
  });
  const top: Grouped[] = [];
  for (const g of all) {
    const stem = g.node.kind === "note" ? noteStem(g.node.name) : null;
    const parent = stem ? parentStem(stem, stems) : null;
    if (stem && parent) {
      g.key = stem.slice(parent.length + 1);
      byStem.get(parent)!.subnotes.push(g);
    } else {
      top.push(g);
    }
  }
  return top;
}

function folderNode(root: TreeNode, folder: string): TreeNode | null {
  if (!folder) return root;
  let node: TreeNode | undefined = root;
  const parts = folder.split("/");
  for (let i = 0; i < parts.length && node; i++) {
    const path = parts.slice(0, i + 1).join("/");
    node = node.children?.find((c) => c.path === path);
  }
  return node ?? null;
}

function find(
  groups: Grouped[],
  path: string,
  parent: Grouped | null,
): [Grouped, Grouped | null] | null {
  for (const g of groups) {
    if (g.node.path === path) return [g, parent];
    const inside = find(g.subnotes, path, g);
    if (inside) return inside;
  }
  return null;
}

/** A note's place among subnotes: the note it's under, and its own subnotes. */
export function subnoteFamily(
  root: TreeNode | null,
  path: string,
): { parent: Grouped | null; subnotes: Grouped[] } {
  const none = { parent: null, subnotes: [] };
  if (!root) return none;
  const folder = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  const node = folderNode(root, folder);
  const found = node?.children ? find(groupSubnotes(node.children), path, null) : null;
  return found ? { parent: found[1], subnotes: found[0].subnotes } : none;
}

/** Every subnote under a group, at any depth. */
export function allSubnotes(g: Grouped): TreeNode[] {
  return g.subnotes.flatMap((s) => [s.node, ...allSubnotes(s)]);
}
