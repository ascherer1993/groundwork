import { isTauri } from "../api/transport";

/** Native folder picker on desktop; `null` in browser mode or if cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Open vault" });
  return typeof picked === "string" ? picked : null;
}
