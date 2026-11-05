/**
 * What the command bar's two halves share: the main window
 * (`state/commandBar.ts`) and the bar's own window (`commandBar.tsx`), which
 * loads only this, not the app's state.
 */

/** Something you had open, which you can point the session at (they start off). */
export interface BarChip {
  kind: "note" | "project" | "workspace";
  /** A vault path, a project id or a workspace name. */
  value: string;
  label: string;
}

/** What the bar asks for. */
export interface BarRequest {
  prompt: string;
  /** The chips turned on. */
  chips: BarChip[];
  /** Show the session, rather than leave it to work in the background. */
  show: boolean;
}

/** What the bar's window is told when it opens. */
export interface BarOpening {
  chips: BarChip[];
}

/** The bar's window → the main window: start this. */
export const START_EVENT = "command-bar://start";
/** The main window → the bar's window: you're open, with these chips. */
export const OPEN_EVENT = "command-bar://open";
