import { autocompletion, closeCompletion, currentCompletions } from "@codemirror/autocomplete";
import { selectAll } from "@codemirror/commands";
import { EditorState, Prec } from "@codemirror/state";
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
    /** Escape (with no completion open). */
    onCancel?(): void;
    /** Focus left the field. */
    onBlur?(): void;
  },
): EditorView {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.value ?? "",
      extensions: [
        // Before the completions' own Escape (same precedence, so listed first),
        // which also takes it when they're active with nothing to show.
        Prec.highest(
          keymap.of([
            {
              key: "Escape",
              run: (v) => {
                if (!opts.onCancel) return false;
                if (currentCompletions(v.state).length) return closeCompletion(v);
                opts.onCancel();
                return true;
              },
            },
          ]),
        ),
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
          // The field's own text; the browser's would select the note around it.
          { key: "Mod-a", run: selectAll },
        ]),
        EditorView.domEventHandlers({
          blur: () => {
            opts.onBlur?.();
          },
        }),
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
        // Long todos wrap onto more lines rather than scrolling sideways
        // (where a scroll bar would cover the text).
        EditorView.lineWrapping,
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
          // Room for the 📅 and priority emoji, so they don't push the line taller.
          "&.cm-editor .cm-line": {
            padding: "0",
            lineHeight: "1.5",
            // See below: the note's editor hides the browser's caret.
            caretColor: "var(--accent) !important",
          },
          "&.cm-editor .cm-placeholder": { color: "var(--text-faint)" },
          // Inside a note, the note's editor hides the browser's caret (set
          // on the lines above) and selection on every line within it (it
          // draws its own), these included. More specific, so these win.
          "&.cm-editor .cm-line::selection, &.cm-editor .cm-line ::selection": {
            backgroundColor: "var(--selection) !important",
          },
        }),
      ],
    }),
  });
  return view;
}
