import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { editor, expectFile, openVault, quickOpen } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

const props = (page: Page) => editor(page).locator(".cm-properties").first();
const row = (page: Page, key: string) => props(page).locator(`.property[data-key="${key}"]`);
const yamlShown = (page: Page) => editor(page).locator(".cm-frontmatter-line").first();

function note(name: string, text: string) {
  writeFileSync(join(VAULT, name), text);
  return () => rmSync(join(VAULT, name), { force: true });
}

test("values are edited in place, by type, without showing the YAML", async ({ page }) => {
  const file = "Typed props.md";
  const cleanup = note(
    file,
    "---\ntitle: Old title\ncount: 3\ndone: false\ndue: 2026-11-20\n---\nBody.\n",
  );
  await quickOpen(page, "Typed props");
  await expect(row(page, "count")).toHaveAttribute("data-type", "number");
  await expect(row(page, "done")).toHaveAttribute("data-type", "checkbox");
  await expect(row(page, "due")).toHaveAttribute("data-type", "date");

  // Text: a click edits it right there; Enter saves.
  await row(page, "title").locator(".pv-text").click();
  const title = row(page, "title").getByRole("textbox", { name: "title" });
  await expect(title).toBeFocused();
  await expect(yamlShown(page)).toBeHidden();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("New title");
  await page.keyboard.press("Enter");
  await expectFile(VAULT, file, (t) => t.includes("title: New title\n"));
  await expect(row(page, "title")).toContainText("New title");

  // Checkbox, number, date.
  await row(page, "done").getByRole("checkbox").click();
  await expectFile(VAULT, file, (t) => t.includes("done: true\n"));
  await row(page, "count").getByRole("spinbutton").fill("5");
  await page.keyboard.press("Enter");
  await expectFile(VAULT, file, (t) => t.includes("count: 5\n"));
  await row(page, "due").locator("input").fill("2026-12-01");
  await row(page, "due").locator("input").blur();
  await expectFile(VAULT, file, (t) => t.includes("due: 2026-12-01\n"));

  // Clicking around the panel leaves it a panel.
  await props(page).locator(".properties-title").click();
  await expect(yamlShown(page)).toBeHidden();
  // Changes can be undone in the editor.
  await editor(page).getByText("Body.").click();
  await page.keyboard.press("Meta+z");
  await expectFile(VAULT, file, (t) => t.includes("due: 2026-11-20\n"));
  cleanup();
});

test("text values suggest notes after [[", async ({ page }) => {
  const file = "Link prop.md";
  const cleanup = note(file, "---\nsee:\n---\nBody.\n");
  await quickOpen(page, "Link prop");
  await row(page, "see").locator(".pv-text").click();
  await page.keyboard.type("[[Welc");
  const list = page.locator(".property-suggest");
  await expect(list.getByRole("option").first()).toContainText("Welcome");
  await page.keyboard.press("Enter");
  await expect(row(page, "see").getByRole("textbox")).toHaveValue("[[Welcome]]");
  await page.keyboard.press("Enter");
  await expectFile(VAULT, file, (t) => t.includes('see: "[[Welcome]]"\n'));
  // The link shows as a link, and opens the note.
  await row(page, "see").getByRole("link", { name: "Welcome" }).click();
  await expect(page.getByLabel("Note title")).toHaveValue("Welcome");
  cleanup();
});

test("properties are added with a name and a type", async ({ page }) => {
  const file = "Add props.md";
  const cleanup = note(file, "---\ntype: note\n---\nBody.\n");
  await quickOpen(page, "Add props");
  await props(page).getByRole("button", { name: "Add property" }).click();
  const name = props(page).getByLabel("New property name");
  await expect(name).toBeFocused();
  await name.fill("links");
  // A familiar name picks its type; it can be changed.
  await expect(props(page).getByLabel("New property type")).toHaveValue("list");
  await page.keyboard.press("Enter");
  await expectFile(VAULT, file, (t) => t.includes("links: []\n"));

  // The new list's field has focus: each Enter adds a value.
  const add = row(page, "links").getByRole("textbox", { name: "Add a value to links" });
  await expect(add).toBeFocused();
  await page.keyboard.type("https://example.com/a");
  await page.keyboard.press("Enter");
  await expectFile(VAULT, file, (t) => t.includes("links: [https://example.com/a]\n"));
  await expect(add).toBeFocused();
  await page.keyboard.type("https://example.com/b");
  await page.keyboard.press("Enter");
  await expectFile(VAULT, file, (t) =>
    t.includes("links: [https://example.com/a, https://example.com/b]\n"),
  );
  await expect(
    row(page, "links").getByRole("link", { name: "https://example.com/a" }),
  ).toBeVisible();

  // A single value, chosen by type.
  await props(page).getByRole("button", { name: "Add property" }).click();
  await props(page).getByLabel("New property name").fill("reviewed");
  await props(page).getByLabel("New property type").selectOption("checkbox");
  await props(page).getByRole("button", { name: "Add", exact: true }).click();
  await expectFile(VAULT, file, (t) => t.includes("reviewed: false\n"));

  // Names must be new and plain.
  await props(page).getByRole("button", { name: "Add property" }).click();
  await props(page).getByLabel("New property name").fill("type");
  await page.keyboard.press("Enter");
  await expect(props(page).getByRole("alert")).toContainText("already");
  await page.keyboard.press("Escape");
  await expect(props(page).getByLabel("New property name")).toBeHidden();
  cleanup();
});

test("a property's menu renames, retypes and removes it", async ({ page }) => {
  const file = "Menu props.md";
  const cleanup = note(file, "---\n# kept\nstatus: draft\nsize: 3\n---\nBody.\n");
  await quickOpen(page, "Menu props");

  await props(page).getByRole("button", { name: "status property options" }).click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  const rename = props(page).getByLabel("Rename status");
  await rename.fill("stage");
  await page.keyboard.press("Enter");
  await expectFile(VAULT, file, (t) => t.includes("# kept\nstage: draft\nsize: 3\n"));

  await props(page).getByRole("button", { name: "stage property options" }).click();
  await page.getByRole("menuitemradio", { name: "List" }).click();
  await expectFile(VAULT, file, (t) => t.includes("stage: [draft]\n"));
  await expect(row(page, "stage").locator(".property-value")).toHaveText(/draft/);

  await props(page).getByRole("button", { name: "size property options" }).click();
  await page.getByRole("menuitem", { name: "Remove property" }).click();
  await expectFile(VAULT, file, (t) => t === "---\n# kept\nstage: [draft]\n---\nBody.\n");
  cleanup();
});

test("every note can list references to other notes", async ({ page }) => {
  const file = "Reference list demo.md";
  const cleanup = note(file, "---\ntype: note\n---\nBody.\n");
  await quickOpen(page, "Reference list demo");
  const add = row(page, "references").getByRole("textbox", { name: "Add a note to references" });
  await add.click();
  await page.keyboard.type("jane");
  const list = page.getByRole("listbox", { name: "Add a note" });
  await expect(list.getByRole("option").first()).toContainText("Jane Doe");
  await page.keyboard.press("Enter");
  await expectFile(VAULT, file, (t) => t.includes('references: ["[[Jane Doe]]"]\n'));
  await expect(add).toBeFocused();
  await page.keyboard.type("Wel");
  await page.keyboard.press("Enter");
  await expectFile(VAULT, file, (t) => t.includes('references: ["[[Jane Doe]]", "[[Welcome]]"]\n'));
  // Notes already there aren't offered again.
  await page.keyboard.type("Jane");
  await expect(list.getByRole("option").filter({ hasText: /^Jane Doe/ })).toHaveCount(0);
  cleanup();
});

test("a contact's team is picked from the teams, or made", async ({ page }) => {
  const file = "Contacts/Lee Park.md";
  const before = readFileSync(join(VAULT, file), "utf8");
  await quickOpen(page, "Lee Park");
  const add = row(page, "team").getByRole("textbox", { name: "Add a team to team" });
  await add.click();
  const list = page.getByRole("listbox", { name: "Add a team" });
  await expect(list.getByRole("option")).toHaveText([/Design/, /Platform/]);
  await page.keyboard.type("plat");
  await page.keyboard.press("Enter");
  await expectFile(VAULT, file, (t) => t.includes('team: ["[[Platform]]"]\n'));

  await page.keyboard.type("Data");
  await list.getByRole("option", { name: "Create team “Data”" }).click();
  await expectFile(VAULT, "Teams/Data.md", (t) => t.includes("type: team"));
  await expectFile(VAULT, file, (t) => t.includes('team: ["[[Platform]]", "[[Data]]"]\n'));
  writeFileSync(join(VAULT, file), before);
  rmSync(join(VAULT, "Teams/Data.md"));
});

test("the YAML is one click away, and leaves when the cursor does", async ({ page }) => {
  const file = "Yaml props.md";
  const cleanup = note(file, "---\na: 1\n---\nBody.\n");
  await quickOpen(page, "Yaml props");
  await expect(yamlShown(page)).toBeHidden();
  await props(page).hover();
  await props(page).getByRole("button", { name: "Edit properties as YAML" }).click();
  await expect(yamlShown(page)).toBeVisible();
  await page.keyboard.type("2");
  await expectFile(VAULT, file, (t) => t.includes("a: 12\n"));
  await editor(page).getByText("Body.").click();
  await expect(yamlShown(page)).toBeHidden();
  await expect(props(page)).toBeVisible();
  // Arrow keys don't wander into it.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(yamlShown(page)).toBeHidden();
  cleanup();
});

test("a note without properties can get some", async ({ page }) => {
  const file = "No props.md";
  const cleanup = note(file, "Just text.\n");
  await quickOpen(page, "No props");
  await editor(page).hover();
  await props(page).getByRole("button", { name: "Add property" }).click();
  await props(page).getByLabel("New property name").fill("status");
  await page.keyboard.press("Enter");
  await expectFile(VAULT, file, (t) => t === "---\nstatus:\n---\nJust text.\n");
  // Its value is next.
  await expect(row(page, "status").getByRole("textbox", { name: "status" })).toBeFocused();
  await page.keyboard.type("draft");
  await page.keyboard.press("Enter");
  await expectFile(VAULT, file, (t) => t === "---\nstatus: draft\n---\nJust text.\n");
  expect(existsSync(join(VAULT, file))).toBe(true);
  cleanup();
});
