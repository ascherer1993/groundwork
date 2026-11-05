import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { openVault } from "./helpers";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

/** What the fake `claude` has been run with since `from` (the log's length then). */
function calls(from = 0): string {
  try {
    return readFileSync(join(process.env.GROUNDWORK_E2E_SETUP!, "claude-bin/calls"), "utf8").slice(
      from,
    );
  } catch {
    return "";
  }
}

test("the command bar starts Claude on the whole vault, or what you point it at", async ({
  page,
}) => {
  await page.keyboard.press("Meta+o");
  await page.getByLabel("Find a file").fill("Kickoff");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Note title")).toHaveValue("2026-11-02 Kickoff");
  const before = calls().length;

  // Its shortcut, which the desktop app makes global.
  await page.keyboard.press("Control+Alt+Space");
  const bar = page.getByRole("form", { name: "Ask Claude" });
  const chips = bar.getByRole("group", { name: "Point Claude at" }).getByRole("button");
  await expect(chips).toHaveText(["2026-11-02 Kickoff", "Acme"]);
  // They start off: the whole vault is in scope.
  await expect(chips.filter({ hasText: "Kickoff" })).toHaveAttribute("aria-pressed", "false");
  await expect(chips.filter({ hasText: "Acme" })).toHaveAttribute("aria-pressed", "false");
  await expect(bar.getByRole("textbox", { name: "Ask Claude" })).toBeFocused();
  await page.keyboard.type("Open a worktree for TEAM-9");
  await page.keyboard.press("Enter");

  // It works in the background: the notes stay as they were.
  await expect(bar).toBeHidden();
  await expect(page.locator(".toast")).toContainText("Claude is on it, in the Agents workspace.");
  await expect(page.getByRole("region", { name: "Terminals" })).toBeHidden();
  await expect.poll(() => calls(before)).toContain("Open a worktree for TEAM-9");
  const call = calls(before);
  expect(call).toContain("--append-system-prompt The user started this session from Groundwork's");
  expect(call).toContain("all of it is in scope");
  expect(call).not.toContain("They pointed you at");

  // ⌘↩ shows it; the palette opens the bar too. Agents isn't offered as a chip.
  const again = calls().length;
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("Ask Claude");
  await page.keyboard.press("Enter");
  await expect(chips).toHaveText(["2026-11-02 Kickoff", "Acme"]);
  // Pointed at the note, not the project.
  await chips.filter({ hasText: "Kickoff" }).click();
  await expect(chips.filter({ hasText: "Kickoff" })).toHaveAttribute("aria-pressed", "true");
  await expect(bar.getByRole("textbox", { name: "Ask Claude" })).toBeFocused();
  await page.keyboard.type("Summarise this");
  await page.keyboard.press("Meta+Enter");
  const terminals = page.getByRole("region", { name: "Terminals" });
  await expect(terminals).toBeVisible();
  await expect(terminals.locator(".terminals-name")).toHaveText("Agents");
  await expect.poll(() => calls(again)).toContain("Summarise this");
  expect(calls(again)).toContain("They pointed you at");
  expect(calls(again)).toContain("- The note Projects/Acme/Meetings/2026-11-02 Kickoff.md");
  expect(calls(again)).not.toContain("- The project Acme");

  // Esc closes it without starting anything.
  await page.keyboard.press("Control+Alt+Space");
  await page.keyboard.type("Never mind");
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();

  // The other specs share the vault: Agents goes, with its two sessions.
  await page.getByRole("tab", { name: "Workspaces" }).click();
  const agents = page
    .locator(".area-row")
    .filter({ has: page.locator(".area-name").getByText("Agents", { exact: true }) });
  await agents.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await expect(page.getByText("Its 2 terminals will end.")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(agents).toHaveCount(0);
});
