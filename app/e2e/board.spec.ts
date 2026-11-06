import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { expectFile, openVault } from "./helpers";

test.describe.configure({ mode: "serial" });

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const TODAY = iso(now);
/** A day of next week: 0 is its Monday. */
function nextWeek(day: number): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 + day);
  return d;
}
const TUE = nextWeek(1);
const WED = nextWeek(2);
const THU = nextWeek(3);
const FRI = nextWeek(4);
const label = (d: Date) =>
  d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

mkdirSync(join(VAULT, "Events"), { recursive: true });
writeFileSync(
  join(VAULT, `Events/${iso(TUE)} Design review.md`),
  `---\ntype: event\ndate: ${iso(TUE)}\ntime: "10:00"\n---\nWith [[Jane Doe]].\n`,
);
writeFileSync(
  join(VAULT, "Rollout todos.md"),
  [
    "# Rollout todos",
    "",
    `- [ ] Draft the rollout plan ⏫ 📅 ${iso(WED)}`,
    "- [ ] Renew the certificate 📅 2026-01-02",
    "- [ ] Someday, no date",
    "",
  ].join("\n"),
);

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

/** Drags `from` onto `to`. (Playwright's own drag doesn't do HTML5 drag and drop in WebKit.) */
async function drag(page: Page, from: Locator, to: Locator) {
  const data = await page.evaluateHandle("new DataTransfer()");
  await from.dispatchEvent("dragstart", { dataTransfer: data });
  for (const type of ["dragenter", "dragover", "drop"]) {
    await to.dispatchEvent(type, { dataTransfer: data });
  }
  await from.dispatchEvent("dragend", { dataTransfer: data });
}

function day(page: Page, d: Date) {
  return page.locator(".todo-board").getByRole("region", { name: label(d) });
}

test("the board shows a week of events and todos, by day", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+t");
  const board = page.locator(".todo-board");
  await expect(board).toBeVisible();
  await expect(page.locator(".dv-tab.dv-active-tab")).toContainText("Todo board");

  // Overdue todos show on today.
  const today = board.locator(".board-day.is-today");
  await expect(today.locator(".todo-text")).toContainText(["Renew the certificate"]);
  await expect(board.locator(".todo-text", { hasText: "Someday" })).toHaveCount(0);

  await page.getByRole("button", { name: "Next week" }).click();
  await expect(day(page, TUE).locator(".board-event")).toHaveText(/10:00\s*Design review/);
  await expect(day(page, WED).locator(".todo-text")).toHaveText(["Draft the rollout plan"]);
  await expect(day(page, WED).locator(".task-meta")).toHaveText("P1");

  // Back to this week, and the board remembers the week it was on.
  await page.getByRole("button", { name: "This week" }).click();
  await expect(board.locator(".board-day.is-today")).toHaveCount(1);
  await page.getByRole("button", { name: "Next week" }).click();
  await day(page, TUE).locator(".board-event").click();
  await expect(page.getByLabel("Note title")).toHaveValue(`${iso(TUE)} Design review`);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(day(page, WED).locator(".todo-text")).toHaveText(["Draft the rollout plan"]);
});

test("ticking, dragging to another day and adding edit the notes", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+t");
  await page.getByRole("button", { name: "Next week" }).click();

  // Drag to Friday: rescheduled.
  const todo = day(page, WED).locator(".board-todo", { hasText: "Draft the rollout plan" });
  await drag(page, todo, day(page, FRI));
  await expectFile(VAULT, "Rollout todos.md", (t) =>
    t.includes(`- [ ] Draft the rollout plan ⏫ 📅 ${iso(FRI)}`),
  );
  await expect(day(page, FRI).locator(".todo-text")).toHaveText(["Draft the rollout plan"]);

  // Ticked: done today, so it moves to today's column, under done.
  await day(page, FRI).getByRole("checkbox", { name: "Done: Draft the rollout plan" }).click();
  await expectFile(VAULT, "Rollout todos.md", (t) =>
    t.includes(`- [x] Draft the rollout plan ⏫ 📅 ${iso(FRI)} ✅ ${TODAY}`),
  );
  await expect(day(page, FRI).locator(".board-todo")).toHaveCount(0);

  // Added on Thursday: into today's daily note, due that day.
  await day(page, THU).getByRole("button", { name: "Add" }).click();
  await page.keyboard.type("Book the room");
  await page.keyboard.press("Enter");
  await expectFile(VAULT, `Daily/${TODAY}.md`, (t) =>
    t.includes(`- [ ] Book the room 📅 ${iso(THU)} ➕ ${TODAY}`),
  );
  await expect(day(page, THU).locator(".todo-text")).toHaveText(["Book the room"]);

  await page.getByRole("button", { name: "This week" }).click();
  await expect(
    page.locator(".board-day.is-today .board-todos.is-done .todo-text", {
      hasText: "Draft the rollout plan",
    }),
  ).toHaveCount(1);
});
