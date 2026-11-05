import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { openVault } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

const TERMINALS = ".terminals-side:not([hidden]) .area:not([hidden])";
const VIEW = `${TERMINALS} .dv-active-group .terminal-view`;
const prompt = /\$ ?$/m;

function screen(page: Page): Promise<string> {
  return page.locator(VIEW).evaluate((el) => {
    type Buffer = {
      length: number;
      getLine(i: number): { translateToString(trim: boolean): string } | undefined;
    };
    const buffer = (el as unknown as { terminal: { buffer: { active: Buffer } } }).terminal.buffer
      .active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  });
}

async function run(page: Page, command: string) {
  await page.locator(VIEW).click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

const tabs = (page: Page) => page.locator(`${TERMINALS} .dv-tab`);
const workspaceName = (page: Page) => page.locator(".terminals-header .terminals-name");

test("the CLI opens notes, workspaces and tabs in the window", async ({ page }) => {
  await page.keyboard.press("Meta+t");
  await expect.poll(() => screen(page)).toMatch(prompt);
  const home = (await workspaceName(page).textContent()) ?? "";

  // open: a note by name comes up in the notes.
  await run(page, 'groundwork open "Jane Doe"');
  await expect(
    page.locator(".notes-side .dv-tab.dv-active-tab").filter({ hasText: "Jane Doe" }),
  ).toBeVisible();
  await expect.poll(() => screen(page)).toContain("Opened Contacts/Jane Doe.md");

  // A tab made in the background, running a command, read back as text.
  await run(
    page,
    'T=$(groundwork tab new --cmd "echo made-by-cli" --background); sleep 1; echo "lines=$(groundwork tab read --tab "$T" | grep -c "^made-by-cli$")"',
  );
  await expect.poll(() => screen(page)).toMatch(/^lines=1$/m);
  await expect(tabs(page)).toHaveCount(2);
  await run(page, 'echo "tabs=$(groundwork tab list | grep -c "this tab")"');
  await expect.poll(() => screen(page)).toMatch(/^tabs=1$/m);

  // A workspace made from the CLI is listed at once, and opened by name.
  await run(page, "groundwork workspace create Scratch");
  await page.getByRole("tab", { name: "Workspaces" }).click();
  const scratch = page.locator(".area-item").filter({ hasText: "Scratch" });
  await expect(scratch).toHaveCount(1);
  await run(page, "groundwork workspace open scratch");
  await expect(workspaceName(page)).toHaveText("Scratch");
  await scratch.locator(".area-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(scratch).toHaveCount(0);
  const homeRow = page.locator(".area-item").filter({ hasText: home }).first();
  await homeRow.locator(".area-row").click();
  await expect(workspaceName(page)).toHaveText(home);

  // A tab whose Claude Code session the hooks reported can be forked…
  await tabs(page).first().click();
  await run(page, `echo '{"session_id":"abc-123"}' | groundwork hook prompt; echo hooked`);
  await expect.poll(() => screen(page)).toMatch(/^hooked$/m);
  await tabs(page).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Resume conversation" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Fork session" }).click();
  await expect(tabs(page)).toHaveCount(3);
  await expect.poll(() => screen(page)).toContain("fake claude: --resume abc-123 --fork-session");
  await expect(tabs(page).first()).not.toHaveClass(/dv-active-tab/);

  // …or its conversation resumed in it.
  await tabs(page).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Resume conversation" }).click();
  await expect.poll(() => screen(page)).toMatch(/^fake claude: --resume abc-123$/m);

  // The workspace's own tabs' rows have the menu too.
  await homeRow.getByRole("button", { name: /^Show .*terminals$/ }).click();
  await homeRow.locator(".area-tab").first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Fork session" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Leave no workspace behind.
  await homeRow.locator(".area-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(homeRow).toHaveCount(0);
});
