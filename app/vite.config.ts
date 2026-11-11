import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";

// Set by `tauri dev` when targeting a device on the network.
const host = process.env.TAURI_DEV_HOST;

/** Where canvases load Excalidraw's fonts from (`window.EXCALIDRAW_ASSET_PATH`). */
const CANVAS_ASSETS = "excalidraw";
const FONTS = fileURLToPath(
  new URL("./node_modules/@excalidraw/excalidraw/dist/prod/fonts", import.meta.url),
);

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesIn(full) : [full];
  });
}

/**
 * Serves Excalidraw's fonts from the app, and copies them into the build, so
 * canvases never fetch them from a CDN (PLAN §5.17).
 */
function canvasFonts(): Plugin {
  return {
    name: "groundwork-canvas-fonts",
    configureServer(server) {
      server.middlewares.use(`/${CANVAS_ASSETS}/fonts`, (req, res, next) => {
        const path = decodeURIComponent((req.url ?? "").split("?")[0]!);
        const file = resolve(FONTS, `.${path}`);
        if (!file.startsWith(FONTS + sep)) return next();
        try {
          const bytes = readFileSync(file);
          res.setHeader("Content-Type", file.endsWith(".woff2") ? "font/woff2" : "font/ttf");
          res.end(bytes);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const file of filesIn(FONTS)) {
        this.emitFile({
          type: "asset",
          fileName: `${CANVAS_ASSETS}/fonts/${relative(FONTS, file).split(sep).join("/")}`,
          source: readFileSync(file),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), canvasFonts()],
  // Keep Rust compiler errors visible in the terminal.
  clearScreen: false,
  server: {
    // Tauri expects a fixed port.
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // The main window, and the command bar's window (PLAN §5.10).
    rollupOptions: { input: { main: "index.html", commandBar: "command-bar.html" } },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
