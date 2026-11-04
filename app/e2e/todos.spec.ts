import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { editor, expectFile, openVault, quickOpen } from "./helpers";

test.describe.configure({ mode: "serial" });

const pad = (n: number) => String(n).padStart(2, "0");
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

mkdirSync(join(VAULT, "Daily"), { recursive: true });
writeFileSync(
  join(VAULT, "Daily/2026-12-01.md"),
  "# 2026-12-01\n\n## Todos\n\n```todos\nday\n```\n",
);
writeFileSync(
  join(VAULT, "Daily/2026-11-28.md"),
  [
    "# 2026-11-28",
    "",
    "- [ ] Book the venue",
    "- [ ] Send the proposal 📅 2026-11-30",
    "- [ ] Prepare the demo 📅 2026-12-01",
    "- [x] Wrap up the review ✅ 2026-12-01",
    "",
  ].join("\n"),
);

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

function block(page: Page) {
  return page.locator(".dv-groupview.dv-active-group .todos-view");
}

function section(page: Page, name: string) {
  return block(page).locator(`.todos-section[data-section="${name}"] .todo-text`);
}

test("a daily note's todos block shows that day", async ({ page }) => {
  await quickOpen(page, "Daily/2026-12-01");
  // Fixture tasks due in early November are overdue by then too.
  await expect(section(page, "overdue")).toContainText(["Send the proposal"]);
  await expect(section(page, "due")).toHaveText(["Prepare the demo"]);
  await expect(section(page, "carried")).toHaveText(["Book the venue"]);
  await expect(block(page).locator('[data-section="carried"] .todo-origin')).toHaveText(
    "from Nov 28 · 3d",
  );
  await expect(section(page, "done")).toHaveText(["Wrap up the review"]);
  // The same block in reading view.
  await page.keyboard.press("Meta+e");
  await expect(section(page, "overdue")).toContainText(["Send the proposal"]);
  await page.keyboard.press("Meta+e");
});

test("ticking, rescheduling and adding from the block edit the source notes", async ({ page }) => {
  await quickOpen(page, "Daily/2026-12-01");
  await block(page).getByRole("checkbox", { name: "Done: Prepare the demo" }).click();
  await expectFile(VAULT, "Daily/2026-11-28.md", (t) =>
    t.includes(`- [x] Prepare the demo 📅 2026-12-01 ✅ ${TODAY}`),
  );

  const proposal = block(page).locator(".todo-item", { hasText: "Send the proposal" });
  await proposal.hover();
  await proposal.getByRole("button", { name: "Reschedule" }).click();
  await page.getByRole("dialog", { name: "Reschedule" }).getByRole("textbox").fill("2026-12-05");
  await page.keyboard.press("Enter");
  await expectFile(VAULT, "Daily/2026-11-28.md", (t) =>
    t.includes("- [ ] Send the proposal 📅 2026-12-05\n"),
  );
  await expect(section(page, "overdue").filter({ hasText: "Send the proposal" })).toHaveCount(0);

  // The add field completes @dates and !priorities like task lines do.
  await block(page).getByRole("textbox", { name: "Add a todo" }).click();
  await page.keyboard.type("Call the caterer @2026-12-03");
  const suggestion = page.locator(".cm-tooltip-autocomplete li[aria-selected]");
  await expect(suggestion).toContainText("@2026-12-03");
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.keyboard.type(" !p");
  await expect(page.locator(".cm-tooltip-autocomplete li")).toHaveText([
    "!p0🔺 highest",
    "!p1⏫ high",
    "!p2🔼 medium",
    "!p3normal (no marker)",
    "!p4🔽 low",
    "!p5⏬ lowest",
  ]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(block(page).getByRole("textbox", { name: "Add a todo" })).toHaveText(
    "Call the caterer 📅 2026-12-03 ⏫",
  );
  await page.keyboard.press("Enter");
  await expectFile(VAULT, "Daily/2026-12-01.md", (t) =>
    t.includes(
      `## Todos\n\n- [ ] Call the caterer ⏫ 📅 2026-12-03 ➕ ${TODAY}\n\n\`\`\`todos\nday\n\`\`\``,
    ),
  );
});

test("typing a task: @date and @p complete, ➕ is stamped on leaving the line", async ({
  page,
}) => {
  await quickOpen(page, "Welcome");
  await editor(page).click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\n- [ ] Water the plants @2026-12-24");
  await expect(page.locator(".cm-tooltip-autocomplete li[aria-selected]")).toContainText(
    "@2026-12-24",
  );
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  // `@` offers priorities after the dates; `@p2` narrows to one.
  await page.keyboard.type(" @p2");
  await expect(page.locator(".cm-tooltip-autocomplete li")).toHaveText(["@p2🔼 medium"]);
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  // Still on the line: no stamp yet.
  await page.waitForTimeout(400);
  await expectFile(VAULT, "Welcome.md", (t) =>
    /^- \[ \] Water the plants 📅 2026-12-24 🔼$/m.test(t),
  );
  await page.keyboard.press("ArrowUp");
  await expectFile(VAULT, "Welcome.md", (t) =>
    t.includes(`- [ ] Water the plants 📅 2026-12-24 🔼 ➕ ${TODAY}`),
  );
});

test("the todos view lists open todos and filters them", async ({ page }) => {
  await page.getByRole("tab", { name: "Todos" }).click();
  const view = page.getByRole("region", { name: "Todos" });
  await expect(view.locator(".todo-text", { hasText: "Book the venue" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Filter todos" }).fill("caterer");
  await expect(view.locator(".todo-text")).toHaveText(["Call the caterer"]);
  await page.getByRole("searchbox", { name: "Filter todos" }).fill("path:Daily/2026-11-28 venue");
  await expect(view.locator(".todo-text")).toHaveText(["Book the venue"]);
});
