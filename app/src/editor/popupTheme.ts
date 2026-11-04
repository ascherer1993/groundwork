import { EditorView } from "@codemirror/view";

/**
 * Tooltips and completion popups, shared by every editor. Selectors repeat
 * `.cm-tooltip` to outrank CodeMirror's base theme (which sets monospace).
 */
export const popupTheme = EditorView.theme({
  ".cm-tooltip": {
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-elevated)",
    borderRadius: "var(--radius)",
    boxShadow: "var(--shadow)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-ui)",
    maxHeight: "18em",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "3px 10px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-text)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > completion-section": {
    padding: "6px 10px 2px",
    border: "none",
    fontSize: "11px",
    fontWeight: "600",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "var(--text-faint)",
  },
  ".cm-completionDetail": { marginLeft: "1em", opacity: 0.6, fontStyle: "normal" },
});
