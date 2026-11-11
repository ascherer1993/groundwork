import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { api } from "../api/client";
import type { CanvasTheme } from "../api/generated/CanvasTheme";

/**
 * How canvases look (PLAN §5.17): like the app (which follows macOS), or
 * always light or dark. Kept in this machine's settings.
 */
interface CanvasSettings {
  theme: CanvasTheme;
  setTheme(theme: CanvasTheme): void;
}

export const useCanvasSettings = create<CanvasSettings>((set) => ({
  theme: "app",
  setTheme(theme) {
    set({ theme });
    void api
      .settings()
      .then((current) => api.saveSettings({ ...current, canvasTheme: theme }))
      .catch(() => {});
  },
}));

/** Reads how canvases look from this machine's settings. */
export async function loadCanvasSettings() {
  try {
    const settings = await api.settings();
    if (settings.canvasTheme) useCanvasSettings.setState({ theme: settings.canvasTheme });
  } catch {
    // The default stands.
  }
}

const DARK = "(prefers-color-scheme: dark)";

function subscribeScheme(onChange: () => void) {
  const query = matchMedia(DARK);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The look a canvas has now: the setting, with "app" resolved. */
export function useCanvasTheme(): "light" | "dark" {
  const theme = useCanvasSettings((s) => s.theme);
  const appDark = useSyncExternalStore(subscribeScheme, () => matchMedia(DARK).matches);
  if (theme === "app") return appDark ? "dark" : "light";
  return theme;
}
