/**
 * macOS notifications, through `tauri-plugin-notification`. In development
 * builds (`make dev`) macOS shows them as Terminal's, so they appear only if
 * Terminal may send notifications; the built app sends its own.
 */
import { isTauri } from "../api/transport";

/** Sends one; resolves to why it couldn't be, or null. */
export async function desktopNotify(title: string, body: string): Promise<string | null> {
  if (!isTauri()) return "notifications only work in the desktop app";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // Called directly, not through `window.Notification`, which drops errors.
    await invoke("plugin:notification|notify", { options: { title, body } });
    return null;
  } catch (err) {
    return String(err);
  }
}
