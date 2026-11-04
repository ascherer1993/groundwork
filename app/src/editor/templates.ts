import type { ChangeSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { splitFrontmatter } from "../markdown/syntax";

const KEY = /^([^\s#-][^:]*):/;

/** Top-level YAML entries (a key line plus its indented or list lines). */
function entries(yaml: string): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const line of yaml.split("\n")) {
    const m = line.match(KEY);
    if (m) out.push({ key: m[1]!.trim(), text: `${line}\n` });
    else if (line.trim() && out.length) out[out.length - 1]!.text += `${line}\n`;
  }
  return out;
}

/** The template's properties the note doesn't have yet, as YAML lines. */
export function missingProperties(noteYaml: string, templateYaml: string): string {
  const have = new Set(entries(noteYaml).map((e) => e.key));
  return entries(templateYaml)
    .filter((e) => !have.has(e.key))
    .map((e) => e.text)
    .join("");
}

/**
 * Inserts a rendered template at the cursor. Its properties are merged into
 * the note's (existing values win) and the cursor goes where `{{cursor}}` was.
 */
export function insertRendered(view: EditorView, rendered: { text: string; cursor?: number }) {
  const template = splitFrontmatter(rendered.text);
  const note = splitFrontmatter(view.state.doc.toString());
  const changes: ChangeSpec[] = [];
  let added = 0;
  if (template.yaml !== null) {
    const props = missingProperties(note.yaml ?? "", template.yaml);
    if (props && note.yaml === null) {
      const insert = `---\n${props}---\n`;
      changes.push({ from: 0, insert });
      added = insert.length;
    } else if (props) {
      // Just before the closing fence.
      const from = view.state.doc.toString().indexOf("\n") + 1 + note.yaml!.length;
      changes.push({ from, insert: props });
      added = props.length;
    }
  }
  // Never insert into the note's own properties.
  const at = Math.max(view.state.selection.main.head, note.length);
  changes.push({ from: at, insert: template.body });
  const cursor =
    rendered.cursor !== undefined && rendered.cursor >= template.length
      ? rendered.cursor - template.length
      : template.body.length;
  view.dispatch({
    changes,
    selection: { anchor: at + added + cursor },
    scrollIntoView: true,
    userEvent: "input.template",
  });
  view.focus();
}
