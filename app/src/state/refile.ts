/**
 * Filing dated notes where the settings put them now (PLAN §5.3, §5.13):
 * daily notes by the daily notes format, and the notes of Quick add choices
 * whose folder has date tags (events, by year and month).
 */
import { api } from "../api/client";
import { confirmDialog, useUi } from "./ui";
import { message } from "./vault";

function notes(n: number): string {
  return n === 1 ? "1 note" : `${n} notes`;
}

/** Says what would move, asks, then moves it. */
export async function refileDatedNotes(): Promise<void> {
  const notify = useUi.getState().notify;
  try {
    const plan = await api.refileDatedNotes(true);
    const blocked =
      plan.blocked.length > 0
        ? ` ${notes(plan.blocked.length)} stay put, because a note is already where they’d go (${plan.blocked.map((m) => m.from).join(", ")}).`
        : "";
    if (plan.moved.length === 0) {
      notify(`Every daily note and event is already in its folder.${blocked}`);
      return;
    }
    const ok = await confirmDialog({
      title: `Move ${notes(plan.moved.length)} into their date folders?`,
      message: `Daily notes go where the daily notes format puts them (Settings › Daily notes), and the notes of Quick add choices whose folder has date tags go in their day’s folder. Subnotes go with them, links are updated, and folders left empty go to the Trash. For example, “${plan.moved[0]!.from}” goes to ${plan.moved[0]!.to}.${blocked}`,
      confirmLabel: "Move notes",
    });
    if (!ok) return;
    const done = await api.refileDatedNotes(false);
    notify(`Moved ${notes(done.moved.length)} into their date folders`);
  } catch (err) {
    notify(message(err));
  }
}
