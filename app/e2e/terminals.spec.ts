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
  return page.locator(".area:not([hidden]) .dv-active-group .terminal-view").evaluate((el) => {
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

const VIEW = ".area:not([hidden]) .dv-active-group .terminal-view";

/** Clicks text shown in the active terminal. */
async function clickText(page: Page, text: string) {
  const at = await page.locator(VIEW).evaluate((el, text) => {
    type Line = { translateToString(trim: boolean): string };
    const term = (
      el as unknown as {
        terminal: {
          cols: number;
          rows: number;
          buffer: { active: { viewportY: number; getLine(i: number): Line | undefined } };
        };
      }
    ).terminal;
    const buffer = term.buffer.active;
    const screen = el.querySelector(".xterm-screen")!.getBoundingClientRect();
    for (let y = term.rows - 1; y >= 0; y--) {
      const x =
        buffer
          .getLine(buffer.viewportY + y)
          ?.translateToString(true)
          .indexOf(text) ?? -1;
      if (x < 0) continue;
      const w = screen.width / term.cols;
      const h = screen.height / term.rows;
      return { x: screen.left + (x + 2.5) * w, y: screen.top + (y + 0.5) * h };
    }
    return null;
  }, text);
  if (!at) throw new Error(`${text} isn't on screen`);
  await page.mouse.move(at.x - 5, at.y);
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
}

const prompt = /\$ ?$/m;
const tab = (page: Page, name: string | RegExp) =>
  page.locator(".area:not([hidden]) .dv-tab").filter({ hasText: name });

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
  await page.locator(".area:not([hidden]) .dv-active-group .terminal-view").click();
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

  await page.locator(".area:not([hidden]) .dv-active-group .terminal-view").click();
  await page.keyboard.press("Meta+w");
  await expect(page.locator(".area:not([hidden]) .terminal-view")).toHaveCount(0);

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

test("workspaces keep their own terminals, with badges and a session manager", async ({ page }) => {
  await page.getByRole("tab", { name: "Workspaces" }).click();
  const panel = page.locator(".workspaces-panel");
  await panel.getByRole("button", { name: "New workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "New workspace" });
  await dialog.getByLabel("Name").fill("Acme API");
  await dialog.getByLabel("Folder").fill(`${VAULT}/Projects/Acme`);
  await dialog.getByRole("button", { name: "Create" }).click();

  // It opens with a terminal in its folder.
  await expect(tab(page, /^Acme$/)).toBeVisible();
  await expect.poll(() => screen(page)).toMatch(prompt);
  await run(page, 'echo "at $(basename "$PWD") in ${GROUNDWORK_WORKSPACE_ID%%-*}"');
  await expect.poll(() => screen(page)).toContain("at Acme in ws");

  // Vault paths in the output open the file, here beside the terminal.
  await run(page, 'echo "see Meetings/2026-11-02 Kickoff.md"');
  await expect.poll(() => screen(page)).toMatch(/^see Meetings/m);
  await clickText(page, "Meetings/2026-11-02 Kickoff.md");
  await expect(tab(page, "2026-11-02 Kickoff")).toBeVisible();
  await tab(page, /^Acme$/).click();

  // The notes have their own tabs; ⌘2 comes back, and so does a reload.
  await page.keyboard.press("Meta+1");
  await expect(tab(page, /^Acme$/)).toHaveCount(0);
  await expect(panel.locator(".area-row.current")).toContainText("Notes");
  await page.keyboard.press("Meta+2");
  await expect(tab(page, /^Acme$/)).toBeVisible();
  await page.reload();
  await expect(tab(page, /^Acme$/)).toBeVisible();
  await expect.poll(() => screen(page)).toContain("at Acme in ws");

  // A notification from a terminal you aren't looking at.
  await page.getByRole("tab", { name: "Workspaces" }).click();
  await page.locator(VIEW).click();
  await run(page, "sleep 1; printf '\\033]9;Tests passed\\007'");
  await page.keyboard.press("Meta+1");
  const acme = panel.locator(".area-item").filter({ hasText: "Acme API" });
  await expect(acme.locator(".area-row").getByRole("status")).toHaveAttribute(
    "aria-label",
    "Waiting on you",
    { timeout: 10_000 },
  );
  await expect(page.getByText("Acme: Tests passed")).toBeVisible();
  await page.getByRole("button", { name: "Show" }).click();
  await expect(tab(page, /^Acme$/)).toBeVisible();
  await expect(acme.locator(".area-row").getByRole("status")).toHaveAttribute("aria-label", "Idle");

  // A command that ends while you're elsewhere is finished.
  await page.locator(VIEW).click();
  await run(page, "sleep 3");
  await expect(acme.locator(".area-tab").getByRole("status")).toHaveAttribute(
    "aria-label",
    "Running",
  );
  await page.keyboard.press("Meta+1");
  await expect(acme.locator(".area-row").getByRole("status")).toHaveAttribute(
    "aria-label",
    "Finished",
    { timeout: 10_000 },
  );

  // Every running terminal is listed with where it is.
  const sessions = page.getByRole("region", { name: "Running terminals" });
  await expect(sessions.locator(".session").filter({ hasText: "in Acme API" })).toHaveCount(1);
  await expect(sessions.locator(".session-meta").filter({ hasText: "in Acme API" })).toContainText(
    "vault/Projects/Acme",
  );

  // Deleting the workspace ends its terminal.
  await acme.locator(".area-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await expect(page.getByText("Its terminal will end.")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(acme).toHaveCount(0);
  await expect(panel.locator(".area-row.current")).toContainText("Notes");
  await expect(sessions.locator(".session").filter({ hasText: "in Acme API" })).toHaveCount(0, {
    timeout: 10_000,
  });
});
