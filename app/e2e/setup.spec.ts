import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { openVault } from "./helpers";

// The fake `claude` (fixtures/bin/claude) keeps its state next to itself.
const FAKE = join(process.env.GROUNDWORK_E2E_SETUP!, "claude-bin");

test.describe.configure({ mode: "serial" });

async function openSetup(page: Page) {
  await page.keyboard.press("Meta+p");
  await page.getByRole("textbox", { name: "Run a command…" }).fill("Set up Claude Code");
  await expect(page.getByRole("option").first()).toContainText("Set up Claude Code…");
  await page.keyboard.press("Enter");
  return page.getByRole("dialog", { name: "Set up Claude Code" });
}

test.describe("before setup has been opened", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the app offers to set up, until the dialog has been opened", async ({ page }) => {
    await openVault(page, VAULT);
    const toast = page.locator(".toast");
    await expect(toast).toContainText("Let Claude Code work with your notes");
    await toast.getByRole("button", { name: "Set up…" }).click();
    const dialog = page.getByRole("dialog", { name: "Set up Claude Code" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();

    // A new launch: not asked again.
    await page.reload();
    await expect(page.getByRole("tree", { name: "Files" })).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(toast).toBeHidden();
  });
});

test("sets up the command, the plugin and the default vault", async ({ page }) => {
  await openVault(page, VAULT);
  const dialog = await openSetup(page);
  const command = dialog.getByRole("region", { name: "The groundwork command" });
  const plugin = dialog.getByRole("region", { name: "Claude Code plugin" });
  const vault = dialog.getByRole("region", { name: "Default vault for the command" });

  await expect(command).toHaveAttribute("data-state", "missing");
  await command.getByRole("button", { name: "Install" }).click();
  await expect(command).toHaveAttribute("data-state", "ok");
  await expect(command).toContainText("runs this build.");

  await expect(plugin).toContainText("Not installed.");
  await plugin.getByRole("button", { name: "Install" }).click();
  await expect(plugin).toHaveAttribute("data-state", "ok");
  await expect(plugin).toContainText(/Version \d+\.\d+\.\d+, read from this copy/);

  await expect(vault).toContainText("the CLI uses whichever vault Groundwork opened last");
  await vault.getByRole("button", { name: "Use this vault" }).click();
  await expect(vault).toContainText("This vault");
  await expect(vault.getByRole("button")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
});

test("says when the plugin comes from another checkout, and fixes it", async ({ page }) => {
  // As if installed from an older clone of the repo.
  writeFileSync(join(FAKE, "marketplace"), "/elsewhere/groundwork\n");
  await openVault(page, VAULT);
  const toast = page.locator(".toast");
  await expect(toast).toContainText("Claude Code setup is out of date.");
  await toast.getByRole("button", { name: "Fix…" }).click();

  const plugin = page
    .getByRole("dialog", { name: "Set up Claude Code" })
    .getByRole("region", { name: "Claude Code plugin" });
  await expect(plugin).toHaveAttribute("data-state", "stale");
  await expect(plugin).toContainText("Installed from /elsewhere/groundwork, not this copy");
  await plugin.getByRole("button", { name: "Fix" }).click();
  await expect(plugin).toHaveAttribute("data-state", "ok");
});
