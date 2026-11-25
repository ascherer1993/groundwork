import { isTauri } from "../api/transport";

/** Whether the native folder picker is there (the desktop app, not browser mode). */
export const canPickFolder = isTauri;

/**
 * Native folder picker on desktop; `null` in browser mode or if cancelled.
 * `start` is the folder it opens at, when it's an absolute path or `~/…`.
 */
export async function pickFolder(
  opts: { title?: string; start?: string } = {},
): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  let defaultPath: string | undefined;
  const start = opts.start?.trim();
  if (start?.startsWith("/")) defaultPath = start;
  else if (start === "~" || start?.startsWith("~/")) {
    const { homeDir, join } = await import("@tauri-apps/api/path");
    defaultPath = await join(await homeDir(), start.slice(1).replace(/^\//, ""));
  }
  const picked = await open({
    directory: true,
    multiple: false,
    title: opts.title ?? "Open vault",
    defaultPath,
  });
  return typeof picked === "string" ? picked : null;
}
