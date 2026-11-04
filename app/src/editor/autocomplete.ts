/** `[[` autocomplete: files, then `#headings` and `#^blocks` of the chosen file. */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import fuzzysort from "fuzzysort";
import { api } from "../api/client";
import type { FileSummary } from "../api/generated/FileSummary";
import { useVault } from "../state/vault";
import { notePath } from "./context";

function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Replaces `from..to` (plus an auto-closed `]]`) with a link formatted by the backend. */
function insertLink(
  view: EditorView,
  from: number,
  to: number,
  target: string,
  opts: { subpath?: string; embed?: boolean },
) {
  const source = notePath(view.state);
  void api.formatLink(source, target, opts).then((link) => {
    const end = view.state.sliceDoc(to, to + 2) === "]]" ? to + 2 : to;
    view.dispatch({
      changes: { from, to: end, insert: link },
      selection: { anchor: from + link.length },
      userEvent: "input.complete",
    });
  });
}

function fileOptions(
  query: string,
  files: FileSummary[],
  from: number,
  embed: boolean,
): Completion[] {
  const candidates = embed ? files : files.filter((f) => f.kind !== "asset");
  const results = query
    ? fuzzysort
        .go(query, candidates, {
          keys: ["title", (f: FileSummary) => f.aliases.join(" "), "path"],
          limit: 40,
        })
        .map((r) => r.obj)
    : candidates.slice(0, 40);
  return results.map((file) => ({
    label: file.title,
    detail: folderOf(file.path),
    type: file.kind,
    apply: (view: EditorView, _c: Completion, _from: number, to: number) =>
      insertLink(view, from, to, file.path, { embed }),
  }));
}

/** File names complete synchronously; headings and blocks need the backend. */
export function wikilinkCompletions(
  ctx: CompletionContext,
): CompletionResult | Promise<CompletionResult | null> | null {
  const match = ctx.matchBefore(/!?\[\[[^[\]\n]*$/);
  if (!match) return null;
  const embed = match.text.startsWith("!");
  const linkStart = match.from;
  const queryStart = match.from + (embed ? 3 : 2);
  const query = match.text.slice(embed ? 3 : 2);
  const source = notePath(ctx.state);

  const hash = query.indexOf("#");
  if (hash < 0) {
    return {
      from: queryStart,
      options: fileOptions(query, useVault.getState().files, linkStart, embed),
      filter: false,
    };
  }

  return subpathCompletions(query, hash, source, linkStart, queryStart, embed);
}

// `[[Note#…` → headings; `[[Note#^…` → block ids.
async function subpathCompletions(
  query: string,
  hash: number,
  source: string,
  linkStart: number,
  queryStart: number,
  embed: boolean,
): Promise<CompletionResult | null> {
  const noteName = query.slice(0, hash);
  const sub = query.slice(hash + 1);
  const [path] = noteName ? await api.resolveLinks(source, [noteName]) : [source];
  if (!path) return null;
  const note = await api.note(path);
  if (!note) return null;
  const blocks = sub.startsWith("^");
  const items = blocks
    ? note.blocks.map((b) => ({
        label: `^${b.id}`,
        subpath: `^${b.id}`,
        detail: `line ${b.line + 1}`,
      }))
    : note.headings.map((h) => ({ label: h.text, subpath: h.text, detail: `H${h.level}` }));
  const needle = blocks ? sub : sub.toLowerCase();
  const filtered = items.filter((i) => i.label.toLowerCase().includes(needle.toLowerCase()));
  return {
    from: queryStart + hash + 1,
    filter: false,
    options: filtered.map((i) => ({
      label: i.label,
      detail: i.detail,
      apply: (view: EditorView, _c: Completion, _from: number, to: number) =>
        insertLink(view, linkStart, to, path, { subpath: i.subpath, embed }),
    })),
  };
}
