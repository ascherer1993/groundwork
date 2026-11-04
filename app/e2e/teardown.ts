import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DAEMON = "../target/debug/groundworkd";

/** Stops the tests' terminal daemon, ending any shells they left running. */
export default function teardown() {
  const dataDir = process.env.GROUNDWORK_E2E_DATA;
  const socket = dataDir && join(dataDir, "groundworkd.sock");
  if (socket && existsSync(socket) && existsSync(DAEMON)) {
    execFileSync(DAEMON, ["--socket", socket, "--shutdown"]);
  }
}
