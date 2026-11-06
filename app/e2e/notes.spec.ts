import { existsSync, mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { editor, expectFile, openVault, quickOpen, readNote } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

test("edits autosave to disk", async ({ page }) => {
  await quickOpen(page, "Welcome");
  await editor(page).click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\nAutosaved line.");
  await expectFile(VAULT, "Welcome.md", (t) => t.includes("\nAutosaved line."));
});

test("live preview renders links and properties; reading view too", async ({ page }) => {
  await quickOpen(page, "Welcome");
  // Links render as their display text while the editor isn't focused.
  const live = editor(page);
  await expect(live.locator(".cm-wikilink", { hasText: /^Jane$/ })).toBeVisible();
  await expect(live.locator(".cm-properties")).toContainText("meta");

  await page.keyboard.press("Meta+e");
  const reading = page.getByTestId("reading-view");
  await expect(reading.locator("a.internal-link", { hasText: "Acme" })).toHaveAttribute(
    "data-resolved",
    "Projects/Acme/Acme.md",
  );
  await expect(reading.locator(".properties")).toContainText("meta");
  await page.keyboard.press("Meta+e");
  await expect(editor(page)).toBeVisible();
});

test("clicking a link navigates; back returns", async ({ page }) => {
  await quickOpen(page, "Welcome");
  await editor(page)
    .locator(".cm-wikilink", { hasText: /^Acme$/ })
    .click();
  await expect(page.getByLabel("Note title")).toHaveValue("Acme");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("Note title")).toHaveValue("Welcome");
});

test("link previews need ⌘ and close when the pointer leaves", async ({ page }) => {
  await quickOpen(page, "Acme");
  await page.keyboard.press("Meta+e");
  const link = page
    .getByTestId("reading-view")
    .locator("a.internal-link", { hasText: "Jane Doe" })
    .first();
  const preview = page.locator(".hover-preview");

  // A plain hover does nothing.
  await link.hover();
  await page.waitForTimeout(600);
  await expect(preview).toHaveCount(0);

  // Pressing ⌘ while over the link opens it; moving away closes it.
  await page.keyboard.down("Meta");
  await expect(preview).toContainText("Jane Doe");
  await page.keyboard.up("Meta");
  await page.mouse.move(5, 300);
  await expect(preview).toHaveCount(0);

  // Hovering with ⌘ held opens it too; the pointer can move onto the
  // preview, and leaving the preview closes it.
  await page.keyboard.down("Meta");
  await link.hover();
  await expect(preview).toBeVisible();
  await page.keyboard.up("Meta");
  await preview.hover();
  await page.waitForTimeout(400);
  await expect(preview).toBeVisible();
  await page.mouse.move(5, 300);
  await expect(preview).toHaveCount(0);
});

test("following a link to a missing note creates it", async ({ page }) => {
  await quickOpen(page, "Daily/2026-11-03");
  await page.keyboard.press("Meta+e");
  const missing = page
    .getByTestId("reading-view")
    .locator("a.internal-link", { hasText: "2026-11-02" });
  await expect(missing).toHaveClass(/is-unresolved/);
  await missing.click();
  await expect(page.getByLabel("Note title")).toHaveValue("2026-11-02");
  // A daily note name: created in the daily notes folder.
  await expect.poll(() => existsSync(join(VAULT, "Daily/2026-11-02.md"))).toBe(true);
  // …from the daily template, dated that day rather than today.
  await expectFile(VAULT, "Daily/2026-11-02.md", (t) =>
    t.includes("# Monday, November 2\n\nYesterday: [[2026-11-01]] · Tomorrow: [[2026-11-03]]"),
  );
  await page.getByRole("button", { name: "Back" }).click();
  await page.keyboard.press("Meta+e");

  // Anything else: the default location (vault root in the fixture).
  await quickOpen(page, "Welcome");
  await editor(page).click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\nSee [[Someday idea");
  await page.keyboard.press("Escape");
  await page.locator(".inline-title").click();
  await editor(page).locator(".cm-wikilink", { hasText: "Someday idea" }).click();
  await expect(page.getByLabel("Note title")).toHaveValue("Someday idea");
  expect(existsSync(join(VAULT, "Someday idea.md"))).toBe(true);
});

test("[[ autocomplete inserts a link", async ({ page }) => {
  await quickOpen(page, "Kickoff");
  await editor(page).click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\nAsk [[jane");
  await expect(page.locator(".cm-tooltip-autocomplete li[aria-selected]")).toContainText(
    "Jane Doe",
  );
  // CodeMirror ignores Enter for a moment after the list (re)opens.
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await expectFile(VAULT, "Projects/Acme/Meetings/2026-11-02 Kickoff.md", (t) =>
    t.includes("Ask [[Jane Doe]]"),
  );
});

test("task metadata shows under the task, and inline while editing it", async ({ page }) => {
  await quickOpen(page, "Welcome");
  const task = editor(page).locator(".cm-line", { hasText: "Try the quick switcher" });
  await expect(task.locator(".cm-task-meta")).toHaveText(/^(Due|Overdue) .+ · Created /);
  await expect(task).not.toContainText("📅");
  await task.click();
  await expect(task.locator(".cm-task-meta")).toHaveCount(0);
  await expect(task).toContainText("📅 2026-11-05 ➕ 2026-11-03");
  await page.locator(".inline-title").click();
});

test("checking a task in reading view stamps it done", async ({ page }) => {
  await quickOpen(page, "Welcome");
  await page.keyboard.press("Meta+e");
  const box = page.getByTestId("reading-view").locator(".task-checkbox").first();
  await expect(box).not.toBeChecked();
  await box.click();
  await expectFile(VAULT, "Welcome.md", (t) =>
    /- \[x\] Try the quick switcher .*✅ \d{4}-\d{2}-\d{2}/.test(t),
  );
  // Other specs share the vault: open it again.
  await box.click();
  await expectFile(VAULT, "Welcome.md", (t) => t.includes("- [ ] Try the quick switcher"));
  await page.keyboard.press("Meta+e");
});

test("external edits reload into the open note", async ({ page }) => {
  await quickOpen(page, "Jane Doe");
  await expect(editor(page)).toContainText("Knows the auth service well.");
  const path = join(VAULT, "Contacts/Jane Doe.md");
  writeFileSync(path, readNote(VAULT, "Contacts/Jane Doe.md").replace("well.", "very well."));
  await expect(editor(page)).toContainText("Knows the auth service very well.");
});

test("backlinks panel lists linking notes and links mentions", async ({ page }) => {
  await quickOpen(page, "Jane Doe");
  const backlinks = page.getByTestId("backlinks");
  await expect(backlinks.getByRole("button", { name: "Welcome", exact: true })).toBeVisible();
  await expect(backlinks.getByRole("button", { name: "Acme", exact: true })).toBeVisible();

  // Add an unlinked mention, then link it from the panel.
  writeFileSync(join(VAULT, "Mention.md"), "We should ask Jane Doe.\n");
  const unlinked = page.getByTestId("unlinked");
  await unlinked.getByRole("button", { name: /Unlinked mentions/ }).click();
  const row = unlinked.locator(".link-group", { hasText: "We should ask Jane Doe." });
  await row.getByRole("button", { name: "Link" }).click();
  await expectFile(VAULT, "Mention.md", (t) => t === "We should ask [[Jane Doe]].\n");
  await expect(backlinks.getByRole("button", { name: "Mention", exact: true })).toBeVisible();
});

test("renaming from the title updates links, and undo restores them", async ({ page }) => {
  await quickOpen(page, "Jane Doe");
  const title = page.getByLabel("Note title");
  await title.fill("Jane Smith");
  await title.press("Enter");

  await expect.poll(() => existsSync(join(VAULT, "Contacts/Jane Smith.md"))).toBe(true);
  await expectFile(VAULT, "Welcome.md", (t) => t.includes("[[Jane Smith|Jane]]"));
  await expect(page.getByRole("tab", { name: "Jane Smith" })).toBeVisible();

  await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => existsSync(join(VAULT, "Contacts/Jane Doe.md"))).toBe(true);
  await expectFile(VAULT, "Welcome.md", (t) => t.includes("[[Jane Doe|Jane]]"));
  await expect(title).toHaveValue("Jane Doe");
});

test("quick switcher creates a note when nothing matches", async ({ page }) => {
  await page.keyboard.press("Meta+o");
  await page.getByLabel("Find a file").fill("Brand new idea");
  await expect(page.getByText("Create “Brand new idea”")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Note title")).toHaveValue("Brand new idea");
  await expect.poll(() => existsSync(join(VAULT, "Brand new idea.md"))).toBe(true);
});

test("file tree: rename inline and delete with confirmation", async ({ page }) => {
  const tree = page.getByRole("tree", { name: "Files" });
  await tree
    .getByRole("treeitem", { name: "Brand new idea" })
    .locator("> button")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  const input = page.getByLabel("New name");
  await input.fill("Renamed idea");
  await input.press("Enter");
  await expect(tree.getByRole("treeitem", { name: "Renamed idea" })).toBeVisible();
  expect(existsSync(join(VAULT, "Renamed idea.md"))).toBe(true);

  await tree
    .getByRole("treeitem", { name: "Renamed idea" })
    .locator("> button")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(tree.getByRole("treeitem", { name: "Renamed idea" })).toHaveCount(0);
  expect(existsSync(join(VAULT, "Renamed idea.md"))).toBe(false);
});

test("file tree: new folders show at once, from the menu or from outside", async ({ page }) => {
  const tree = page.getByRole("tree", { name: "Files" });
  await tree
    .getByRole("treeitem", { name: "Daily" })
    .locator("> button")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "New folder" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Archive");
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await expect(tree.getByRole("treeitem", { name: "Archive" })).toBeVisible();
  expect(existsSync(join(VAULT, "Daily/Archive"))).toBe(true);

  // Empty folders made and removed in Finder.
  mkdirSync(join(VAULT, "Made outside"));
  await expect(tree.getByRole("treeitem", { name: "Made outside" })).toBeVisible();
  rmdirSync(join(VAULT, "Made outside"));
  await expect(tree.getByRole("treeitem", { name: "Made outside" })).toHaveCount(0);
});

test("file tree: new projects, and folders made into projects", async ({ page }) => {
  const tree = page.getByRole("tree", { name: "Files" });
  const menu = async (name: string) =>
    tree
      .getByRole("treeitem", { name, exact: true })
      .locator("> button")
      .click({ button: "right" });

  await menu("Projects");
  await page.getByRole("menuitem", { name: "New project…" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Name").fill("Test Project");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("“Test Project” is a project")).toBeVisible();
  // Its overview opens; the folder shows as a project.
  await expect(
    page.locator(".notes-side .dv-tab").filter({ hasText: "Test Project" }),
  ).toBeVisible();
  await expectFile(VAULT, "Projects/Test Project/.groundwork.yml", (t) =>
    t.includes("overview: Test Project.md"),
  );
  const project = tree.getByRole("treeitem", { name: "Test Project", exact: true }).first();
  await expect(project.locator("> button").getByLabel("Project")).toBeVisible();

  // An existing folder.
  mkdirSync(join(VAULT, "Projects/Side gig"));
  await expect(tree.getByRole("treeitem", { name: "Side gig" })).toBeVisible();
  await menu("Side gig");
  await expect(page.getByRole("menuitem", { name: "New ticket…" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Make this a project" }).click();
  await expect(
    tree.getByRole("treeitem", { name: "Side gig" }).locator("> button").getByLabel("Project"),
  ).toBeVisible();
  await menu("Side gig");
  await expect(page.getByRole("menuitem", { name: "Make this a project" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "New ticket…" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("tabs and splits persist across reloads", async ({ page }) => {
  await quickOpen(page, "Welcome");
  await page.keyboard.press("Meta+o");
  await page.getByLabel("Find a file").fill("Acme");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("tab", { name: "Acme" })).toBeVisible();
  await page.keyboard.press("Meta+\\");
  await expect(page.locator(".dv-groupview")).toHaveCount(2);
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.locator(".dv-groupview")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: "Welcome" })).toBeVisible();
});

test("a middle click closes a tab", async ({ page }) => {
  await quickOpen(page, "Welcome");
  await page.keyboard.press("Meta+o");
  await page.getByLabel("Find a file").fill("Acme");
  await page.keyboard.press("Meta+Enter");
  const tabs = page.locator(".notes-side .dv-tab");
  await expect(tabs).toHaveCount(2);
  await tabs.filter({ hasText: "Welcome" }).click({ button: "middle" });
  await expect(tabs).toHaveCount(1);
  await expect(tabs).toHaveText("Acme");
});

test("clicks land on the clicked line, even below late-rendering blocks", async ({ page }) => {
  // Properties, callouts and Mermaid render after the editor first measures
  // them; if it doesn't re-measure, clicks hit the line below. It shows when
  // the note is shorter than the window, so use a tall one.
  await page.setViewportSize({ width: 1400, height: 1000 });
  for (const note of ["TEAM-123", "Projects/Acme/Acme"]) {
    await quickOpen(page, note);
    await expect(page.locator(".cm-properties")).toBeVisible();
    if (note.endsWith("Acme")) await expect(page.locator(".mermaid-block svg")).toBeVisible();
    const lines = editor(page).locator(".cm-line");

    // The first click after opening, before anything else makes the editor
    // re-measure, is the one that used to miss.
    const last = lines.filter({ hasText: /\w/ }).last();
    const lastBox = (await last.boundingBox())!;
    await page.mouse.click(lastBox.x + 30, lastBox.y + lastBox.height / 2);
    await expect(last).toHaveClass(/cm-activeLine/);

    for (let i = 0; i < (await lines.count()); i++) {
      const line = lines.nth(i);
      if (!((await line.textContent()) ?? "").trim()) continue;
      await page.locator(".inline-title").click();
      const box = (await line.boundingBox())!;
      await page.mouse.click(box.x + 30, box.y + box.height / 2);
      await expect(line).toHaveClass(/cm-activeLine/);
    }
    await page.locator(".inline-title").click();
  }
});
