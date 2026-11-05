import { expect, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { editor, expectFile, openVault, quickOpen } from "./helpers";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test("Quick add makes an event for the project you're in, and formats as you type", async ({
  page,
}) => {
  await quickOpen(page, "Kickoff");
  await expect(editor(page)).toContainText("Decided to tackle");

  // ⇧⌘A lists the choices; an event asks for a title, a date and a project.
  await page.keyboard.press("Shift+Meta+a");
  const menu = page.getByRole("listbox");
  await expect(menu.getByRole("option")).toHaveText([/^Person/, /^Event/, /^Todo/]);
  await page.keyboard.type("event");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New event" });
  await expect(dialog.getByLabel("Date")).toHaveValue(today());
  await expect(dialog.getByLabel("Project")).toHaveValue("acme");
  await dialog.getByLabel("Title").fill("Design review");
  await page.keyboard.press("Enter");

  // It's in Events, with its project, and the cursor is under Notes.
  const path = `Events/${today()} Design review.md`;
  await expect(page.locator(".notes-side .dv-tab.dv-active-tab")).toContainText(
    `${today()} Design review`,
  );
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("Jane walked us through it");
  await expectFile(
    VAULT,
    path,
    (t) =>
      t.includes("type: event") &&
      t.includes('projects: ["[[Acme]]"]') &&
      t.includes("## Notes\n\nJane walked us through it"),
  );

  // Formatting keys: a checkbox, then bold.
  await page.keyboard.press("Shift+Meta+2");
  await expectFile(VAULT, path, (t) => t.includes("\n- [ ] Jane walked us through it"));
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Alt+ArrowLeft");
  await page.keyboard.press("Meta+b");
  await expectFile(VAULT, path, (t) => t.includes("- [ ] Jane walked us through **it**"));
});

test("choices are made in Settings, with shortcuts of their own", async ({ page }) => {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Quick add", exact: true }).click();
  await settings.getByRole("button", { name: "Add a choice" }).click();
  const form = settings.getByRole("form", { name: "New choice" });
  await form.getByLabel("Name", { exact: true }).fill("Idea");
  await form.getByLabel("Type").selectOption("capture");
  await form.getByLabel("Adds to").fill("Ideas");
  await form.getByLabel("The line").fill("- {{prompt:Idea}}");
  await form.getByRole("button", { name: "Save" }).click();
  await expectFile(VAULT, ".groundwork/quickadd.yml", (t) => t.includes("name: Idea"));

  // Its shortcut, here or among all the shortcuts.
  await settings.getByRole("button", { name: "Shortcut for Quick add: Idea" }).click();
  await page.keyboard.press("Control+Meta+i");
  await settings.getByRole("button", { name: "Keyboard shortcuts" }).click();
  await settings.getByLabel("Search shortcuts").fill("idea");
  await expect(
    settings.getByRole("button", { name: "Shortcut for Quick add: Idea", exact: true }),
  ).toHaveText("⌃⌘I");
  await settings.getByRole("button", { name: "Done" }).click();

  await page.keyboard.press("Control+Meta+i");
  await page.getByRole("dialog", { name: "Add: Idea" }).getByRole("textbox").fill("Dark mode");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Added to Ideas")).toBeVisible();
  await expectFile(VAULT, "Ideas.md", (t) => t.endsWith("- Dark mode\n"));
});
