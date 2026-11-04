import { isTauri } from "../api/transport";

const DEV_SERVER_URL: string = import.meta.env.VITE_GROUNDWORK_BACKEND ?? "ws://127.0.0.1:1430";

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** A URL the webview can load a vault file from (images, embeds, pages). */
export function vaultFileUrl(path: string): string {
  if (isTauri()) return `groundwork://localhost/vault/${encodePath(path)}`;
  const base = DEV_SERVER_URL.replace(/^ws/, "http").replace(/\/$/, "");
  return `${base}/vault/${encodePath(path)}`;
}

/** Opens an external URL in the system browser. */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
