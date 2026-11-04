import { chmodSync, copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Browser mode on ports distinct from `npm run dev:browser`, so tests can run
// alongside a dev session. Machine-local state goes to a throwaway directory.
const BACKEND_PORT = 1441;
const UI_PORT = 1440;
const dataDir = mkdtempSync(join(tmpdir(), "groundwork-e2e-"));

// "Set up Claude Code" runs against a fake `claude` and a throwaway bin
// folder, never the real ones. Workers re-read this file, so the first
// (runner) process picks the folder and passes it on in the environment.
process.env.GROUNDWORK_E2E_SETUP ??= mkdtempSync(join(tmpdir(), "groundwork-e2e-setup-"));
const setupDir = process.env.GROUNDWORK_E2E_SETUP;
mkdirSync(join(setupDir, "claude-bin"), { recursive: true });
copyFileSync("../fixtures/bin/claude", join(setupDir, "claude-bin/claude"));
chmodSync(join(setupDir, "claude-bin/claude"), 0o755);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${UI_PORT}`,
    trace: "retain-on-failure",
    // Skip the first-run "set up Claude Code" prompt; setup.spec tests it.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://localhost:${UI_PORT}`,
          localStorage: [{ name: "groundwork.setupSeen", value: "1" }],
        },
      ],
    },
  },
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
  webServer: [
    {
      // The CLI is built too: "Set up Claude Code" links to it.
      command: `cargo build -q -p groundwork-cli && cargo run -q -p groundwork-backend --features dev-server --bin groundwork-dev-server -- --port ${BACKEND_PORT}`,
      port: BACKEND_PORT,
      env: {
        GROUNDWORK_DATA_DIR: dataDir,
        GROUNDWORK_CLAUDE: join(setupDir, "claude-bin/claude"),
        GROUNDWORK_BIN_DIR: join(setupDir, "bin"),
      },
      // The first run compiles the backend.
      timeout: 300_000,
      reuseExistingServer: false,
    },
    {
      command: `vite --port ${UI_PORT} --strictPort`,
      url: `http://localhost:${UI_PORT}`,
      env: { VITE_GROUNDWORK_BACKEND: `ws://127.0.0.1:${BACKEND_PORT}` },
      reuseExistingServer: false,
    },
  ],
});
