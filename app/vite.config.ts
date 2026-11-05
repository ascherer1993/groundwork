import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Set by `tauri dev` when targeting a device on the network.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
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
