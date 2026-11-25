import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { editor, expectFile, openVault, quickOpen } from "./helpers";

test.describe.configure({ mode: "serial" });

const NOTE = "Spelling check.md";
const DICTIONARY = join(VAULT, ".groundwork/dictionary.txt");

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

test.afterEach(() => {
  rmSync(join(VAULT, NOTE), { force: true });
  rmSync(DICTIONARY, { force: true });
});

const misspelled = (page: Page) => editor(page).locator(".cm-misspelled");

async function spellingSettings(page: Page) {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Spelling" }).click();
  return dialog;
}

test("misspelled words are underlined, corrected and added to the dictionary", async ({ page }) => {
  writeFileSync(
    join(VAULT, NOTE),
    "This sentense has a mistaek, `codde`, a [[Wikii]] link, #tagg and src/fiel.ts.\n",
  );
  await quickOpen(page, "Spelling check");

  // Only prose is checked.
  await expect(misspelled(page)).toHaveText(["sentense", "mistaek"]);
  await page.screenshot({ path: test.info().outputPath("light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: test.info().outputPath("dark.png") });
  await page.emulateMedia({ colorScheme: "light" });

  // Right-click offers corrections; choosing one fixes the word.
  await misspelled(page).filter({ hasText: "sentense" }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Add “sentense” to dictionary" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("menu.png") });
  await page.getByRole("menuitem", { name: "sentence", exact: true }).click();
  await expectFile(VAULT, NOTE, (t) => t.startsWith("This sentence has a mistaek"));
  await expect(misspelled(page)).toHaveText(["mistaek"]);

  // Adding a word keeps it in the vault's dictionary and takes the underline away.
  await misspelled(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add “mistaek” to dictionary" }).click();
  await expect(misspelled(page)).toHaveCount(0);
  expect(readFileSync(DICTIONARY, "utf8")).toBe("mistaek\n");

  // A word isn't underlined while it's being typed, only once you've left it.
  await editor(page).getByText("link").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Anothr");
  await page.waitForTimeout(600);
  await expect(misspelled(page)).toHaveCount(0);
  await page.keyboard.type(" ");
  await expect(misspelled(page)).toHaveText(["Anothr"]);
});

test("Settings › Spelling turns checking off and removes the vault's words", async ({ page }) => {
  writeFileSync(join(VAULT, NOTE), "A mistaek and a speling error.\n");
  writeFileSync(DICTIONARY, "# this vault's words\nmistaek\n");
  await quickOpen(page, "Spelling check");
  await expect(misspelled(page)).toHaveText(["speling"]);

  const dialog = await spellingSettings(page);
  const words = dialog.getByRole("list", { name: "This vault’s words" });
  await expect(words.getByRole("listitem")).toHaveText(["mistaek"]);
  await page.screenshot({ path: test.info().outputPath("settings.png") });
  await dialog.getByRole("button", { name: "Remove mistaek" }).click();
  await expect(dialog.getByText("None yet.")).toBeVisible();
  expect(readFileSync(DICTIONARY, "utf8")).toBe("# this vault's words\n");

  await dialog.getByLabel("Check spelling in notes").uncheck();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(misspelled(page)).toHaveCount(0);

  // Kept after a reload, then turned back on.
  await page.reload();
  await quickOpen(page, "Spelling check");
  await expect(editor(page)).toContainText("speling");
  await page.waitForTimeout(600);
  await expect(misspelled(page)).toHaveCount(0);
  await (await spellingSettings(page)).getByLabel("Check spelling in notes").check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(misspelled(page)).toHaveText(["mistaek", "speling"]);
  expect(existsSync(DICTIONARY)).toBe(true);
});
