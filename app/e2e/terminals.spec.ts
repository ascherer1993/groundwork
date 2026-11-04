import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { openVault } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

/** What the active terminal shows, scrollback included. */
function screen(page: Page): Promise<string> {
  return page.locator(".dv-active-group .terminal-view").evaluate((el) => {
    type Buffer = {
      length: number;
      getLine(i: number): { translateToString(trim: boolean): string } | undefined;
    };
    const term = (el as unknown as { terminal: { buffer: { active: Buffer } } }).terminal;
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  });
}

async function run(page: Page, command: string) {
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

const prompt = /\$ ?$/m;
const tab = (page: Page, name: string | RegExp) =>
  page.locator(".dv-tab").filter({ hasText: name });

test("a terminal runs a shell in the vault and comes back after a reload", async ({ page }) => {
  await page.keyboard.press("Meta+t");
  await expect(tab(page, /^vault$/)).toBeVisible();
  await expect.poll(() => screen(page)).toMatch(prompt);

  await run(
    page,
    'echo "in $(basename "$PWD") as $TERM_PROGRAM with ${GROUNDWORK_VAULT:+the vault}"',
  );
  await expect.poll(() => screen(page)).toContain("in vault as Groundwork with the vault");
  // The CLI works without "Set up Claude Code…", and uses this vault.
  await run(page, "groundwork vault");
  await expect.poll(() => screen(page)).toContain("$GROUNDWORK_VAULT");

  // Shift+Enter sends ESC CR, which Claude Code reads as a newline.
  await run(page, "cat -v");
  await page.keyboard.press("Shift+Enter");
  await expect.poll(() => screen(page)).toMatch(/^\^\[$/m);
  await page.keyboard.press("Control+c");

  // Programs can set the tab's title.
  await run(page, "printf '\\033]2;Build logs\\007'");
  await expect(tab(page, "Build logs")).toBeVisible();

  // The shell keeps running across a reload; the view comes back with its
  // screen and carries on.
  await run(page, "MARK=still-here");
  await page.reload();
  await expect(tab(page, "Build logs")).toBeVisible();
  await expect.poll(() => screen(page)).toContain("in vault as Groundwork with the vault");
  await page.locator(".dv-active-group .terminal-view").click();
  await run(page, 'echo "$MARK"');
  await expect.poll(() => screen(page)).toMatch(/^still-here$/m);

  // Exiting the shell closes the tab.
  await run(page, "exit");
  await expect(tab(page, "Build logs")).toHaveCount(0);
});

test("closing a terminal tab ends its shell; app shortcuts work from it", async ({ page }) => {
  await page.keyboard.press("Meta+t");
  await expect.poll(() => screen(page)).toMatch(prompt);
  await run(page, 'echo "pid=$$"');
  await expect.poll(() => screen(page)).toMatch(/^pid=\d+$/m);
  const pid = (await screen(page)).match(/^pid=(\d+)$/m)![1];

  // ⌘O reaches the app from inside the terminal.
  await page.keyboard.press("Meta+o");
  await expect(page.getByRole("dialog", { name: "Quick switcher" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.locator(".dv-active-group .terminal-view").click();
  await page.keyboard.press("Meta+w");
  await expect(page.locator(".terminal-view")).toHaveCount(0);

  await page.keyboard.press("Meta+t");
  await expect.poll(() => screen(page)).toMatch(prompt);
  await run(page, `sleep 1; kill -0 ${pid} 2>/dev/null && echo alive || echo gone`);
  await expect.poll(() => screen(page), { timeout: 10_000 }).toMatch(/^gone$/m);
  await run(page, "exit");
});

test("opening a note from a terminal tab opens it beside the terminal", async ({ page }) => {
  await page.keyboard.press("Meta+t");
  await expect.poll(() => screen(page)).toMatch(prompt);
  await page.keyboard.press("Meta+o");
  await page.keyboard.type("Welcome");
  await page.keyboard.press("Enter");
  await expect(tab(page, "Welcome")).toBeVisible();
  await expect(tab(page, /^vault$/)).toBeVisible();
  await tab(page, /^vault$/).click();
  await page.keyboard.press("Meta+w");
});
