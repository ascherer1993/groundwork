import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { openVault, quickOpen, showLinks } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

const tree = (page: Page) => page.getByRole("tree", { name: "Files" });
const item = (page: Page, name: string) => tree(page).getByRole("treeitem", { name, exact: true });
const row = (page: Page, name: string) => item(page, name).locator("> button");

test("subnotes sit under their note, and go where it goes", async ({ page }) => {
  writeFileSync(join(VAULT, "Standup.md"), "# Standup\n\nSee [[Standup.transcript]].\n");
  writeFileSync(join(VAULT, "Standup.transcript.md"), "Me: hello.\n");
  writeFileSync(join(VAULT, "Standup 2.md"), "Not a subnote.\n");

  // Listed under the note by its key; a look-alike stays on its own.
  const standup = item(page, "Standup");
  await expect(standup).toHaveAttribute("aria-expanded", "true");
  const transcript = standup.getByRole("treeitem", { name: "Standup.transcript" });
  await expect(transcript).toHaveText("transcript");
  await expect(item(page, "Standup 2")).not.toHaveAttribute("aria-expanded");
  await expect(standup.getByRole("treeitem", { name: "Standup 2" })).toHaveCount(0);

  // The note's chevron folds them away; the row still opens the note.
  await row(page, "Standup").getByRole("button", { name: "Hide subnotes" }).click();
  await expect(transcript).toHaveCount(0);
  await expect(standup).toHaveAttribute("aria-expanded", "false");
  await row(page, "Standup").getByRole("button", { name: "Show subnotes" }).click();
  await expect(transcript).toBeVisible();

  // The note bar goes down to subnotes and back up.
  await row(page, "Standup").click();
  const bar = page.getByRole("toolbar", { name: "Subnotes" });
  await bar.getByRole("button", { name: "transcript" }).click();
  await expect(page.getByLabel("Note title")).toHaveValue("Standup.transcript");
  await expect(transcript.locator("> button")).toHaveClass(/selected/);
  // Its tab names it by its key, with its note underneath.
  const tab = page.locator(".notes-side .dv-tab.dv-active-tab");
  await expect(tab.locator(".note-tab-main")).toHaveText("transcript");
  await expect(tab.locator(".note-tab-under")).toHaveText("Standup");
  await bar.getByRole("button", { name: "Standup", exact: true }).click();
  await expect(page.getByLabel("Note title")).toHaveValue("Standup");
  await expect(tab).toHaveText("Standup");
  await expect(tab.locator(".note-tab-under")).toHaveCount(0);

  // A new subnote, from the note's menu.
  await row(page, "Standup").click({ button: "right" });
  await page.getByRole("menuitem", { name: "New subnote…" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("summary");
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await expect(page.getByLabel("Note title")).toHaveValue("Standup.summary");
  await expect(standup.getByRole("treeitem", { name: "Standup.summary" })).toHaveText("summary");
  await expect.poll(() => existsSync(join(VAULT, "Standup.summary.md"))).toBe(true);

  // Renaming the note takes its subnotes, and the links to them.
  await row(page, "Standup").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await page.getByLabel("New name").fill("Retro");
  await page.getByLabel("New name").press("Enter");
  await expect(page.getByText("Renamed “Standup” with its 2 subnotes")).toBeVisible();
  const retro = item(page, "Retro");
  await expect(retro.getByRole("treeitem", { name: "Retro.transcript" })).toHaveText("transcript");
  await expect(retro.getByRole("treeitem", { name: "Retro.summary" })).toBeVisible();
  for (const [path, exists] of [
    ["Retro.md", true],
    ["Retro.transcript.md", true],
    ["Retro.summary.md", true],
    ["Standup.transcript.md", false],
  ] as const) {
    await expect.poll(() => existsSync(join(VAULT, path)), path).toBe(exists);
  }

  // Deleting it says the subnotes go too.
  await row(page, "Retro").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("dialog")).toContainText("its 2 subnotes");
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(retro).toHaveCount(0);
  await expect.poll(() => existsSync(join(VAULT, "Retro.transcript.md"))).toBe(false);

  await row(page, "Standup 2").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(item(page, "Standup 2")).toHaveCount(0);
});

test("a meeting links to its transcript", async ({ page }) => {
  // (The project view's events leave the transcript out: see projects.spec.ts.)
  await quickOpen(page, "2026-11-02 Kickoff");
  await page
    .getByRole("toolbar", { name: "Subnotes" })
    .getByRole("button", { name: "transcript" })
    .click();
  await expect(page.getByLabel("Note title")).toHaveValue("2026-11-02 Kickoff.transcript");
});

test("the sidebar and the links panel resize, and remember it", async ({ page }) => {
  const sidebar = page.locator("aside.sidebar");
  const width = async (locator: ReturnType<Page["locator"]>) =>
    Math.round((await locator.boundingBox())!.width);
  const drag = async (name: string, dx: number) => {
    const box = (await page.getByRole("separator", { name }).boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y);
    await page.mouse.move(x + dx, y);
    await page.mouse.up();
  };

  const before = await width(sidebar);
  await drag("Resize sidebar", 120);
  await expect.poll(() => width(sidebar)).toBe(before + 120);
  await page.reload();
  await expect.poll(() => width(sidebar)).toBe(before + 120);
  await page.getByRole("separator", { name: "Resize sidebar" }).dblclick();
  await expect.poll(() => width(sidebar)).toBe(before);

  await quickOpen(page, "Welcome");
  await showLinks(page);
  const links = page.locator(".dv-active-group .links-aside");
  const linksBefore = await width(links);
  // Dragging left widens it.
  await drag("Resize links panel", -100);
  await expect.poll(() => width(links)).toBe(linksBefore + 100);
  await page.getByRole("separator", { name: "Resize links panel" }).dblclick();
  await expect.poll(() => width(links)).toBe(linksBefore);
  // Leave the links panel closed, as it was.
  await page
    .locator(".dv-active-group .file-header")
    .getByRole("button", { name: "Links panel" })
    .click();
});
