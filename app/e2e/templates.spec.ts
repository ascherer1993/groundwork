import { expect, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { editor, expectFile, openVault, quickOpen } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

async function runCommand(page: import("@playwright/test").Page, name: string) {
  await page.keyboard.press("Meta+p");
  await page.getByRole("textbox", { name: "Run a command…" }).fill(name);
  await expect(page.getByRole("option").first()).toContainText(name);
  await page.keyboard.press("Enter");
}

test("new note from a template asks its prompts and places the cursor", async ({ page }) => {
  await runCommand(page, "New note from template");
  await page.getByRole("textbox", { name: "New note from template…" }).fill("Meeting");
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "New note from “Meeting”" });
  await dialog.getByLabel("Name").fill("Vendor call");
  await dialog.getByLabel("Attendees").fill("Jane Doe");
  await dialog.getByRole("button", { name: "Create" }).click();

  await expect(page.getByLabel("Note title")).toHaveValue("Vendor call");
  // The cursor is where the template's {{cursor}} was.
  await page.keyboard.type("First point");
  await expectFile(VAULT, "Vendor call.md", (t) =>
    /^---\ntype: meeting\ncreated: \d{4}-\d\d-\d\dT\d\d:\d\d\n---\n# Vendor call\n\n\*\*When:\*\* \w+day, \w+ \d+ · \*\*With:\*\* Jane Doe\n\n## Notes\n\nFirst point\n\n## Action items\n$/.test(
      t,
    ),
  );
});

test("insert template merges properties and inserts at the cursor", async ({ page }) => {
  await quickOpen(page, "Welcome");
  await editor(page).click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await runCommand(page, "Insert template");
  await page.getByRole("textbox", { name: "Insert template…" }).fill("Meeting");
  await page.keyboard.press("Enter");
  await page.getByLabel("Attendees").fill("Bob");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Typed after insert");
  await expectFile(
    VAULT,
    "Welcome.md",
    (t) =>
      /^---\n[\s\S]*type: meeting\n---\n/.test(t) &&
      t.includes("**With:** Bob\n\n## Notes\n\nTyped after insert\n\n## Action items\n"),
  );
});

test("⌘⇧D opens today's daily note", async ({ page }) => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  await page.keyboard.press("Meta+Shift+d");
  await expect(page.getByLabel("Note title")).toHaveValue(today);
  await expectFile(VAULT, `Daily/${today}.md`, (t) => t.length > 0);
});

test("the command palette lists recent commands first", async ({ page }) => {
  await runCommand(page, "Toggle links panel");
  await page.keyboard.press("Meta+p");
  await expect(page.getByRole("option").first()).toContainText("Toggle links panel");
  await expect(page.getByRole("option", { name: /Open today’s daily note/ })).toContainText("⌘⇧D");
  await page.keyboard.press("Enter");
});
