import { type EditorState, Facet, StateEffect } from "@codemirror/state";

export interface NoteContext {
  /** Vault path of the note being edited (changes when it's renamed). */
  path: () => string;
}

export const noteContext = Facet.define<NoteContext, NoteContext>({
  combine: (values) => values[0] ?? { path: () => "" },
});

export function notePath(state: EditorState): string {
  return state.facet(noteContext).path();
}

/** Forces decorations to rebuild (e.g. after the note was renamed). */
export const refreshPreview = StateEffect.define<null>();
