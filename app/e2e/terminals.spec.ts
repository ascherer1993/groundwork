import { homedir } from "node:os";
import { basename } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { openVault } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

/** The current workspace's dock, when the terminals are on screen. */
const TERMINALS = ".terminals-side:not([hidden]) .area:not([hidden])";
const VIEW = `${TERMINALS} .dv-active-group .terminal-view`;

/** What the active terminal shows, scrollback included. */
function screen(page: Page): Promise<string> {
  return page.locator(VIEW).evaluate((el) => {
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
/** A tab of the current workspace's terminals. */
const tab = (page: Page, name: string | RegExp) =>
  page.locator(`${TERMINALS} .dv-tab`).filter({ hasText: name });
/** A tab of the notes. */
const noteTab = (page: Page, name: string | RegExp) =>
  page.locator(".notes-side:not([hidden]) .dv-tab").filter({ hasText: name });

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
  await page.locator(VIEW).click();
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

  await page.locator(VIEW).click();
  await page.keyboard.press("Meta+w");
  await expect(page.locator(`${TERMINALS} .terminal-view`)).toHaveCount(0);

  await page.keyboard.press("Meta+t");
  await expect.poll(() => screen(page)).toMatch(prompt);
  await run(page, `sleep 1; kill -0 ${pid} 2>/dev/null && echo alive || echo gone`);
  await expect.poll(() => screen(page), { timeout: 10_000 }).toMatch(/^gone$/m);
  await run(page, "exit");
});

test("notes, notes beside terminals, or terminals alone", async ({ page }) => {
  const views = page.getByRole("group", { name: "Main view" });
  const notes = page.getByRole("region", { name: "Notes", exact: true });
  const terminals = page.getByRole("region", { name: "Terminals", exact: true });

  // A terminal comes up beside the notes.
  await views.getByRole("button", { name: "Notes" }).click();
  await expect(terminals).toBeHidden();
  await page.keyboard.press("Meta+t");
  await expect.poll(() => screen(page)).toMatch(prompt);
  await expect(notes).toBeVisible();
  await expect(views.getByRole("button", { name: "Split" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Notes open on their own side, never among the terminals.
  await page.keyboard.press("Meta+o");
  await page.keyboard.type("Welcome");
  await page.keyboard.press("Enter");
  await expect(noteTab(page, "Welcome")).toBeVisible();
  await expect(tab(page, "Welcome")).toHaveCount(0);
  await expect(tab(page, /^vault$/)).toBeVisible();

  // Terminals alone; opening a note brings the notes back beside them.
  await page.keyboard.press("Control+Meta+3");
  await expect(notes).toBeHidden();
  await expect(tab(page, /^vault$/)).toBeVisible();
  await page
    .getByRole("tree", { name: "Files" })
    .getByRole("treeitem", { name: "Welcome" })
    .click();
  await expect(notes).toBeVisible();
  await expect(terminals).toBeVisible();

  // ⌘W closes the tab on the side last used.
  await page.locator(VIEW).click();
  await page.keyboard.press("Meta+w");
  await expect(tab(page, /^vault$/)).toHaveCount(0);
  await expect(noteTab(page, "Welcome")).toBeVisible();
  await page.keyboard.press("Control+Meta+1");
  await expect(terminals).toBeHidden();
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

  // Vault paths in the output open the file, among the notes.
  await run(page, 'echo "see Meetings/2026-11-02 Kickoff.md"');
  await expect.poll(() => screen(page)).toMatch(/^see Meetings/m);
  await clickText(page, "Meetings/2026-11-02 Kickoff.md");
  await expect(noteTab(page, "2026-11-02 Kickoff")).toBeVisible();

  // Each workspace has its own terminals: ⌘1… switch between them, and a
  // reload comes back to the same one.
  const acmeRow = panel.locator(".area-item").filter({ hasText: "Acme API" }).locator(".area-row");
  await expect(acmeRow).toHaveClass(/current/);
  await page.keyboard.press("Meta+1");
  await expect(tab(page, /^Acme$/)).toHaveCount(0);
  await expect(acmeRow).not.toHaveClass(/current/);
  await page.keyboard.press("Meta+2");
  await expect(tab(page, /^Acme$/)).toBeVisible();
  await page.reload();
  await expect(tab(page, /^Acme$/)).toBeVisible();
  await expect.poll(() => screen(page)).toContain("at Acme in ws");

  // A notification from a terminal you aren't looking at.
  await page.getByRole("tab", { name: "Workspaces" }).click();
  await page.locator(VIEW).click();
  await run(page, "sleep 1; printf '\\033]9;Tests passed\\007'");
  await page.keyboard.press("Control+Meta+1");
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
  await page.keyboard.press("Control+Meta+1");
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
  await expect(sessions.locator(".session").filter({ hasText: "in Acme API" })).toHaveCount(0, {
    timeout: 10_000,
  });
});

test("terminals open in a chosen folder", async ({ page }) => {
  const tree = page.getByRole("tree", { name: "Files" });
  /** Checks the active terminal's folder, then ends it. */
  const isIn = async (name: string) => {
    await expect(tab(page, new RegExp(`^${name}$`))).toBeVisible();
    await expect.poll(() => screen(page)).toMatch(prompt);
    await run(page, 'echo "in $(basename "$PWD")"');
    await expect.poll(() => screen(page)).toMatch(new RegExp(`^in ${name}$`, "m"));
    await run(page, "exit");
    await expect(tab(page, new RegExp(`^${name}$`))).toHaveCount(0);
  };

  // From a folder in the file tree.
  await tree
    .getByRole("treeitem", { name: "Projects" })
    .locator("> button")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open terminal here" }).click();
  await isIn("Projects");

  // From the palette: a vault folder, or any folder typed in.
  const inFolder = async (choice: string) => {
    await page.keyboard.press("Meta+p");
    await page.keyboard.type("New terminal in folder");
    await page.keyboard.press("Enter");
    await expect(page.getByPlaceholder("New terminal in…")).toBeVisible();
    await page.keyboard.type(choice);
    await page.keyboard.press("Enter");
  };
  await inFolder("Contacts");
  await isIn("Contacts");
  await inFolder("Another folder");
  const dialog = page.getByRole("dialog", { name: "Folder" });
  await dialog.getByRole("textbox").fill("~");
  await dialog.getByRole("button", { name: "Open" }).click();
  await isIn(basename(homedir()));

  // A workspace's folder can change; new terminals start there.
  await page.getByRole("tab", { name: "Workspaces" }).click();
  const panel = page.locator(".workspaces-panel");
  await panel.getByRole("button", { name: "New workspace" }).click();
  const create = page.getByRole("dialog", { name: "New workspace" });
  await create.getByLabel("Name").fill("Moving");
  await create.getByRole("button", { name: "Create" }).click();
  await isIn("vault");
  const moving = panel.locator(".area-item").filter({ hasText: "Moving" });
  await moving.locator(".area-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Change folder…" }).click();
  const change = page.getByRole("dialog", { name: "Change folder" });
  await change.getByLabel("Folder").fill(`${VAULT}/Daily`);
  await change.getByRole("button", { name: "Change" }).click();
  await expect(moving.locator(".area-folder")).toHaveText("vault/Daily");
  await page.keyboard.press("Meta+t");
  await isIn("Daily");

  await moving.locator(".area-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(moving).toHaveCount(0);
});
