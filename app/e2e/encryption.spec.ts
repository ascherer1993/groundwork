import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { expectFile, openVault, quickOpen, readNote } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

test.afterAll(() => {
  rmSync(join(VAULT, "Diary.md"), { force: true });
  rmSync(join(VAULT, "Mentions diary.md"), { force: true });
});

const tree = (page: Page) => page.getByRole("tree", { name: "Files" });
const row = (page: Page, name: string) =>
  tree(page).getByRole("treeitem", { name, exact: true }).locator("> button");
const header = (page: Page) => page.locator(".dv-active-group .file-header");
const lockButton = (page: Page) => header(page).getByRole("button", { name: "Lock note" });
const locked = (page: Page) => page.getByRole("form", { name: "Encrypted note" });
const editor = (page: Page) => page.locator(".dv-active-group .cm-content");

async function unlock(page: Page, password: string) {
  await locked(page).getByLabel("Password").fill(password);
  await locked(page).getByRole("button", { name: "Unlock" }).click();
}

test("a note encrypts, unlocks with its password, and locks again", async ({ page }) => {
  writeFileSync(join(VAULT, "Diary.md"), "# Diary\n\nThe safe code is 4711.\n");
  writeFileSync(join(VAULT, "Mentions diary.md"), "See ![[Diary]].\n");

  await row(page, "Diary").click();
  await expect(editor(page)).toContainText("The safe code is 4711.");

  // Encrypt it from the file tree: the passwords must match.
  await row(page, "Diary").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Encrypt…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Password", { exact: true }).fill("open sesame");
  await dialog.getByLabel("Confirm password").fill("open sesame!");
  await dialog.getByLabel("Hint (optional)").fill("ali baba");
  await dialog.getByRole("button", { name: "Encrypt" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("The passwords don't match.");
  await dialog.getByLabel("Confirm password").fill("open sesame");
  await dialog.getByRole("button", { name: "Encrypt" }).click();
  await expect(dialog).toHaveCount(0);

  // On disk, only the hint is readable; the open tab locks at once.
  await expectFile(VAULT, "Diary.md", (t) => t.includes("encrypted: groundwork-v1"));
  expect(readNote(VAULT, "Diary.md")).not.toContain("4711");
  expect(readNote(VAULT, "Diary.md")).toContain("hint: ali baba");
  await expect(locked(page)).toBeVisible();
  await expect(locked(page)).toContainText("Hint: ali baba");
  await expect(page.locator(".dv-active-group .cm-editor")).toHaveCount(0);
  await expect(lockButton(page)).toHaveCount(0);
  await expect(row(page, "Diary").locator(".tree-lock")).toBeVisible();

  // Search doesn't see inside it.
  await page.keyboard.press("Shift+Meta+f");
  await page.getByLabel("Search notes").fill("4711");
  await expect(page.getByText("No matches.")).toBeVisible();
  await page.getByRole("tablist", { name: "Sidebar" }).getByRole("tab", { name: "Files" }).click();

  // A wrong password is refused; the right one opens it.
  await unlock(page, "wrong");
  await expect(locked(page).getByRole("alert")).toHaveText("Wrong password.");
  await unlock(page, "open sesame");
  await expect(editor(page)).toContainText("The safe code is 4711.");

  // Edits are saved encrypted.
  const before = readNote(VAULT, "Diary.md");
  await editor(page).click();
  await page.keyboard.press("Meta+End");
  await page.keyboard.type("\nNew line 9.");
  await expectFile(VAULT, "Diary.md", (t) => t !== before && t.includes("hint: ali baba"));
  expect(readNote(VAULT, "Diary.md")).not.toContain("New line 9");

  // The lock button in the header locks it, keeping the edit.
  await lockButton(page).click();
  await expect(locked(page)).toBeVisible();
  await unlock(page, "open sesame");
  await expect(editor(page)).toContainText("New line 9.");

  // Embeds and the note's own text elsewhere stay hidden.
  await row(page, "Mentions diary").click({ modifiers: ["Meta"] });
  await expect(page.locator(".dv-active-group .embed-locked")).toHaveText(
    "Encrypted note. Open it to unlock it.",
  );

  // It's open in two tabs now: closing one keeps it unlocked, closing the
  // last locks it.
  await row(page, "Diary").click();
  await expect(editor(page)).toContainText("New line 9.");
  const diaryTabs = page.locator(".notes-side .dv-tab", { hasText: /^Diary$/ });
  await expect(diaryTabs).toHaveCount(2);
  await page.keyboard.press("Meta+w");
  await expect(diaryTabs).toHaveCount(1);
  await diaryTabs.click();
  await expect(editor(page)).toContainText("New line 9.");
  await page.keyboard.press("Meta+w");
  await expect(diaryTabs).toHaveCount(0);
  await row(page, "Diary").click();
  await expect(locked(page)).toBeVisible();

  // Taking the encryption off writes it back in the clear.
  await row(page, "Diary").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove encryption…" }).click();
  await page.getByRole("dialog").getByLabel("Password").fill("open sesame");
  await page.getByRole("dialog").getByRole("button", { name: "Remove encryption" }).click();
  await expectFile(
    VAULT,
    "Diary.md",
    (t) => t.includes("New line 9.") && !t.includes("encrypted:"),
  );
  await expect(editor(page)).toContainText("New line 9.");
  await expect(row(page, "Diary").locator(".tree-lock")).toHaveCount(0);
});

test("the fixture's encrypted note opens with its password", async ({ page }) => {
  await quickOpen(page, "Credentials");
  await expect(locked(page)).toContainText("Hint: the fixture one");
  await unlock(page, "fixture-password");
  await expect(editor(page)).toContainText("Staging admin");
  // The lock shortcut locks it.
  await editor(page).click();
  await page.keyboard.press("Control+Meta+l");
  await expect(locked(page)).toBeVisible();
});

test("an unlocked note left unused locks itself", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await openVault(page, VAULT);
  await quickOpen(page, "Credentials");
  await unlock(page, "fixture-password");
  await expect(editor(page)).toContainText("Staging admin");
  // Used now and then, it stays unlocked…
  await page.clock.fastForward("08:00");
  await editor(page).click();
  await page.clock.fastForward("08:00");
  await expect(editor(page)).toContainText("Staging admin");
  // …but not ten minutes (the default) without use.
  await page.clock.fastForward("11:00");
  await expect(locked(page)).toBeVisible();
});
