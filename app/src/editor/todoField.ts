import { autocompletion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { popupTheme } from "./popupTheme";
import { todoFieldCompletions } from "./todoInput";

/**
 * A one-line editor for typing a new todo, with the same `@date` and
 * `!priority` completions as task lines in notes. Enter (with no
 * completion open) calls `onSubmit` with the text and clears the field,
 * unless `keep` (a field in a form, which submits it).
 */
export function todoField(
  parent: HTMLElement,
  opts: {
    label: string;
    placeholder: string;
    onSubmit(text: string): void;
    value?: string;
    onChange?(text: string): void;
    keep?: boolean;
  },
): EditorView {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.value ?? "",
      extensions: [
        // Completion keys take precedence, so Enter picks a suggestion first.
        autocompletion({ override: [todoFieldCompletions], icons: false }),
        keymap.of([
          {
            key: "Enter",
            run: (v) => {
              const text = v.state.doc.toString();
              if (!text.trim() && !opts.keep) return true;
              if (!opts.keep) {
                v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "" } });
              }
              opts.onSubmit(text);
              return true;
            },
          },
        ]),
        // One line only: pasted newlines become spaces.
        EditorState.transactionFilter.of((tr) =>
          tr.newDoc.lines > 1
            ? [
                tr,
                {
                  changes: {
                    from: 0,
                    to: tr.newDoc.length,
                    insert: tr.newDoc.toString().replace(/\n/g, " "),
                  },
                  sequential: true,
                },
              ]
            : tr,
        ),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange?.(u.state.doc.toString());
        }),
        placeholder(opts.placeholder),
        popupTheme,
        EditorView.contentAttributes.of({ "aria-label": opts.label, role: "textbox" }),
        EditorView.theme({
          "&": {
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            background: "var(--bg-input)",
            fontSize: "13px",
          },
          "&.cm-focused": { outline: "2px solid var(--accent)", outlineOffset: "-1px" },
          // Doubled selectors: this editor sits inside a note's editor, whose
          // theme also matches these elements.
          "&.cm-editor .cm-content": {
            padding: "5px 8px",
            caretColor: "var(--accent)",
            fontFamily: "var(--font-ui)",
          },
          "&.cm-editor .cm-line": { padding: "0" },
          "&.cm-editor .cm-placeholder": { color: "var(--text-faint)" },
        }),
      ],
    }),
  });
  return view;
}
