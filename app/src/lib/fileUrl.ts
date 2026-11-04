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

/**
 * Where a page frame loads a page from (see `crates/backend/src/page_server.rs`).
 * Bundles end in `/`, so their relative links stay inside them.
 */
export function pageFileUrl(token: string, path: string): string {
  const base = isTauri()
    ? "groundwork://localhost"
    : DEV_SERVER_URL.replace(/^ws/, "http").replace(/\/$/, "");
  const slash = /\.page$/i.test(path) ? "/" : "";
  return `${base}/page/${token}/${encodePath(path)}${slash}`;
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
