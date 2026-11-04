import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PAGE_STATE = "Projects/Acme/demos/login-flow.page/state.json";
const SOURCE = fileURLToPath(new URL("../../fixtures/vault", import.meta.url));

/**
 * A fresh copy of the repo's fixture vault (tests edit files), named `vault`
 * like the original. One copy per test file.
 */
const dir = mkdtempSync(join(tmpdir(), "groundwork-vault-"));
export const FIXTURE_VAULT = join(dir, "vault");
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
cpSync(SOURCE, FIXTURE_VAULT, { recursive: true });
// Left over from using the fixture vault in the app (and ignored by git).
for (const path of [".groundwork/activity", ".groundwork/page-state", PAGE_STATE]) {
  rmSync(join(FIXTURE_VAULT, path), { recursive: true, force: true });
}
