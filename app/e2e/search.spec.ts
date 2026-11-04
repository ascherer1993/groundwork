import { expect, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { editor, openVault } from "./helpers";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

test("⌘⇧F searches note text and opens the matching line", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+f");
  const box = page.getByRole("searchbox", { name: "Search notes" });
  await expect(box).toBeFocused();
  await box.fill("auth migration");
  const results = page.getByRole("list", { name: "Search results" });
  await expect(results.locator(".search-title")).toHaveText(["2026-11-03Daily"]);
  await expect(results.locator("mark")).toHaveText(["auth", "migration"]);
  await results.locator(".search-line").first().click();
  await expect(page.getByLabel("Note title")).toHaveValue("2026-11-03");
  await expect(editor(page).locator(".cm-activeLine")).toContainText("about the auth migration");

  await box.fill('"vendor contract" -nothing path:acme');
  await expect(results.locator(".search-title")).toHaveText([
    "2026-11-02 KickoffProjects/Acme/Meetings",
  ]);
  await box.fill("zzzz-no-such-text");
  await expect(page.getByText("No matches.")).toBeVisible();
});

test("tags list nested tags and search by tag", async ({ page }) => {
  await page.getByRole("tab", { name: "Tags" }).click();
  const tags = page.getByRole("list", { name: "Tags" });
  await expect(tags.locator(".tag-row")).toHaveText(["acme/legal1", "meta1", "waiting1"]);
  await tags.getByRole("button", { name: /waiting/ }).click();
  await expect(page.getByRole("searchbox", { name: "Search notes" })).toHaveValue("#waiting");
  await expect(page.locator(".search-title")).toHaveText([
    "2026-11-02 KickoffProjects/Acme/Meetings",
  ]);
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByRole("tree", { name: "Files" })).toBeVisible();
});
