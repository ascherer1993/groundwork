import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { openVault } from "./helpers";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

const views = (page: Page) => page.getByRole("group", { name: "Main view" });
const pressed = (page: Page, view: string) =>
  expect(views(page).getByRole("button", { name: view })).toHaveAttribute("aria-pressed", "true");

test("shortcuts can be changed in settings, and stay changed", async ({ page }) => {
  // The top bar: the views as icons, with their keys in the tooltips.
  await expect(views(page).getByRole("button", { name: "Terminals" })).toHaveAttribute(
    "title",
    "Terminals only (⌃⌘3)",
  );
  await page.keyboard.press("Control+Meta+1");
  await pressed(page, "Notes");

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const shortcut = (label: string) =>
    dialog.getByRole("button", { name: `Shortcut for ${label}`, exact: true });
  await expect(shortcut("Show terminals only")).toHaveText("⌃⌘3");

  // Record new keys.
  await shortcut("Show terminals only").click();
  await expect(shortcut("Show terminals only")).toHaveText("Press keys…");
  await page.keyboard.press("Shift+a");
  await expect(dialog.getByRole("status")).toContainText("add ⌘, ⌃ or ⌥");
  await page.keyboard.press("Control+Meta+t");
  await expect(shortcut("Show terminals only")).toHaveText("⌃⌘T");
  // Keys another command had move over; that one has none now.
  await shortcut("Show notes and terminals").click();
  await page.keyboard.press("Meta+o");
  await expect(dialog.getByRole("status")).toContainText("“Open quick switcher”’s");
  await expect(shortcut("Open quick switcher")).toHaveText("None");
  await dialog.getByRole("button", { name: "Done" }).click();

  // The new keys work; the old ones don't.
  await page.keyboard.press("Control+Meta+t");
  await pressed(page, "Terminals");
  await page.keyboard.press("Control+Meta+1");
  await pressed(page, "Notes");
  await page.keyboard.press("Control+Meta+3");
  await pressed(page, "Notes");
  await page.keyboard.press("Meta+o");
  await pressed(page, "Split");
  await expect(page.getByRole("dialog", { name: "Quick switcher" })).toHaveCount(0);

  // They stay after a restart, and show in the palette and tooltips.
  await page.reload();
  await expect(views(page).getByRole("button", { name: "Terminals" })).toHaveAttribute(
    "title",
    "Terminals only (⌃⌘T)",
  );
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("Show terminals only");
  await expect(page.getByRole("option").first()).toContainText("⌃⌘T");
  await page.keyboard.press("Escape");

  // One resets; then all do.
  await page.keyboard.press("Meta+,");
  await dialog.getByRole("button", { name: "Reset Show terminals only" }).click();
  await expect(shortcut("Show terminals only")).toHaveText("⌃⌘3");
  await dialog.getByRole("button", { name: "Reset all" }).click();
  await expect(shortcut("Open quick switcher")).toHaveText("⌘O");
  await expect(shortcut("Show notes and terminals")).toHaveText("⌃⌘2");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("Meta+o");
  await expect(page.getByRole("dialog", { name: "Quick switcher" })).toBeVisible();
});
