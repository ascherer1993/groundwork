import { readFileSync, rmSync } from "node:fs";
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

test("the command bar starts Claude on the whole vault, and logs how it went", async ({ page }) => {
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
  // "[done]": the fake claude finishes with `groundwork done`, as a one-off.
  await page.keyboard.type("Open a worktree for TEAM-9 [done]");
  await page.keyboard.press("Enter");

  // It works in the background: the notes stay as they were.
  await expect(bar).toBeHidden();
  await expect(page.locator(".toast")).toContainText("Claude is on it, in the Agents workspace.");
  await expect(page.getByRole("region", { name: "Terminals" })).toBeHidden();
  await expect.poll(() => calls(before)).toContain("Open a worktree for TEAM-9");
  const call = calls(before);
  expect(call).toContain("--append-system-prompt The user started this session from Groundwork's");
  expect(call).toContain("all of it is in scope");
  expect(call).toContain("your last step is `groundwork done");
  expect(call).not.toContain("They pointed you at");

  // It says what it did in passing (in the desktop app, a macOS notification
  // while Groundwork is in the background; a toast while it's in front)...
  await expect(page.locator(".toast")).toContainText(
    "Finished: Did: Open a worktree for TEAM-9 [done]",
  );
  // ...and it goes in the inbox's history: nothing waits on you.
  const inboxButton = page.getByRole("button", { name: /^Inbox/ });
  const inbox = page.getByRole("dialog", { name: "Inbox" });
  await inboxButton.click();
  await inbox.getByRole("tab", { name: "Earlier" }).click();
  const told = inbox.getByRole("listitem", { name: /Did: Open a worktree for TEAM-9/ });
  await expect(told).toBeVisible();
  await expect(told).not.toContainText("Dismissed");
  await expect(inboxButton).toHaveAccessibleName("Inbox");
  await page.keyboard.press("Escape");

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
  await page.keyboard.type("Summarise this [keep]");
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

  // The command log has both, newest first: the one-off closed its tab.
  // (Once the fake claude has finished both; the log loads as it opens.)
  const logFile = join(VAULT, ".groundwork/command-log.jsonl");
  await expect.poll(() => readFileSync(logFile, "utf8").split('"event":"done"').length - 1).toBe(2);
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("command log");
  await page.keyboard.press("Enter");
  const log = page.getByRole("dialog", { name: "Command log" });
  const entries = log.getByRole("list", { name: "Requests" }).getByRole("listitem");
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText("Summarise this [keep]");
  await expect(entries.nth(0)).toContainText("Done");
  await expect(entries.nth(0)).toContainText("Shown");
  await expect(entries.nth(0)).toContainText("Tab left open");
  await expect(entries.nth(0)).toContainText("Pointed at 2026-11-02 Kickoff");
  await expect(entries.nth(0).getByRole("button", { name: "Show its tab" })).toBeVisible();
  const first = entries.nth(1);
  await expect(first).toContainText("Open a worktree for TEAM-9 [done]");
  await expect(first).toContainText("In the background");
  await expect(first).toContainText("Tab closed");
  await expect(first).toContainText("Did: Open a worktree for TEAM-9 [done]");
  // Its tab is gone, but the session can be carried on.
  const resumed = calls().length;
  await first.getByRole("button", { name: "Resume the session" }).click();
  await expect(log).toBeHidden();
  await expect.poll(() => calls(resumed)).toContain("--resume fake-session");

  // The other specs share the vault: Agents goes, with its two sessions (the
  // one kept open, and the one resumed).
  await page.getByRole("tab", { name: "Workspaces" }).click();
  const agents = page
    .locator(".area-row")
    .filter({ has: page.locator(".area-name").getByText("Agents", { exact: true }) });
  await agents.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await expect(page.getByText("Its 2 terminals will end.")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(agents).toHaveCount(0);
  rmSync(join(VAULT, ".groundwork/command-log.jsonl"), { force: true });
});
