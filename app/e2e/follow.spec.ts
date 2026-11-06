import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { openVault, quickOpen } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

async function command(page: Page, name: string) {
  await page.keyboard.press("Meta+p");
  await page.keyboard.type(name);
  await expect(page.getByRole("option").first()).toContainText(name);
  await page.keyboard.press("Enter");
}

/** A workspace's row in the Workspaces view. */
const row = (page: Page, name: string) =>
  page
    .locator(".area-row")
    .filter({ has: page.locator(".area-name").getByText(name, { exact: true }) });
const header = (page: Page) => page.locator(".terminals-header");
const activeNote = (page: Page) =>
  page.locator(".notes-side .dv-active-group .dv-tab.dv-active-tab");

test("the terminals follow the open note, unless locked", async ({ page }) => {
  // Two notes with workspaces: a project overview and a contact.
  await quickOpen(page, "Acme");
  await command(page, "Open this note’s workspace");
  await expect(header(page)).toContainText("Acme");
  await quickOpen(page, "Jane Doe");
  await command(page, "Open this note’s workspace");
  await expect(header(page)).toContainText("Jane Doe");
  await expect(header(page)).toContainText("Following notes");

  // A note in the project's folder follows the overview's workspace.
  await quickOpen(page, "2026-11-02 Kickoff");
  await expect(header(page).locator(".terminals-name")).toHaveText("Acme");
  await quickOpen(page, "Jane Doe");
  await expect(header(page).locator(".terminals-name")).toHaveText("Jane Doe");
  // A note with no workspace leaves the terminals as they are.
  await quickOpen(page, "Welcome");
  await expect(header(page).locator(".terminals-name")).toHaveText("Jane Doe");

  // Locked, they stay; unlocked, they catch up.
  await header(page).getByRole("button", { name: "Lock to this workspace" }).click();
  await expect(header(page)).toContainText("Locked");
  await quickOpen(page, "Acme");
  await expect(header(page).locator(".terminals-name")).toHaveText("Jane Doe");
  await page.reload();
  await expect(header(page)).toContainText("Locked");
  await header(page).getByRole("button", { name: "Unlock" }).click();
  await expect(header(page).locator(".terminals-name")).toHaveText("Acme");

  // Picking a workspace brings up its note.
  await page.getByRole("tab", { name: "Workspaces" }).click();
  await row(page, "Jane Doe").click();
  await expect(header(page).locator(".terminals-name")).toHaveText("Jane Doe");
  await expect(activeNote(page)).toContainText("Jane Doe");

  // Following never brings the terminals on screen.
  await page.keyboard.press("Control+Meta+1");
  await expect(page.getByRole("region", { name: "Terminals", exact: true })).toBeHidden();
  await quickOpen(page, "Acme");
  await expect(page.getByRole("region", { name: "Terminals", exact: true })).toBeHidden();
  await page.keyboard.press("Control+Meta+2");
  await expect(header(page).locator(".terminals-name")).toHaveText("Acme");

  // Keys step through the workspaces, round the list, and pick them by number.
  const name = header(page).locator(".terminals-name");
  await page.keyboard.press("Control+Meta+]");
  await expect(name).toHaveText("Jane Doe");
  await expect(activeNote(page)).toContainText("Jane Doe");
  await page.keyboard.press("Control+Meta+]");
  await expect(name).toHaveText("Acme");
  await page.keyboard.press("Control+Meta+[");
  await expect(name).toHaveText("Jane Doe");
  await page.keyboard.press("Meta+1");
  await expect(name).toHaveText("Acme");

  // Leave no workspaces for the other tests.
  for (const name of ["Acme", "Jane Doe"]) {
    await row(page, name).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(row(page, name)).toHaveCount(0);
  }
});
