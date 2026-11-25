/**
 * Where Excalidraw finds its fonts: served by the app itself
 * (`vite.config.ts`), never a CDN, so canvases work offline (PLAN §5.17).
 * Imported before Excalidraw so it's set before anything loads.
 */

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
    /** What Excalidraw writes as a drawing's `source` (else the page's origin). */
    EXCALIDRAW_EXPORT_SOURCE?: string;
  }
}

window.EXCALIDRAW_ASSET_PATH = new URL("/excalidraw/", window.location.href).href;
window.EXCALIDRAW_EXPORT_SOURCE = "groundwork";

export {};
