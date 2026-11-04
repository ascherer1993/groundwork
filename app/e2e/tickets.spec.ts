import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { expectFile, openVault, quickOpen } from "./helpers";

test.describe.configure({ mode: "serial" });

/** A checkout of the fixture's `acme-platform` repo, pushed to a bare origin. */
const CODE = realpathSync(mkdtempSync(join(tmpdir(), "groundwork-code-")));
const REPO = join(CODE, "acme");
const WORKTREE = join(CODE, "acme-worktrees", "TEAM-200-fix-signup");
{
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  mkdirSync(join(REPO, "apps/web"), { recursive: true });
  git(CODE, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(REPO, "init", "-q", "-b", "main");
  git(REPO, "config", "user.email", "test@example.com");
  git(REPO, "config", "user.name", "Test");
  git(REPO, "config", "commit.gpgsign", "false");
  writeFileSync(join(REPO, "apps/web/index.js"), "\n");
  git(REPO, "add", ".");
  git(REPO, "commit", "-q", "-m", "first");
  git(REPO, "remote", "add", "origin", join(CODE, "origin.git"));
  git(REPO, "push", "-q", "-u", "origin", "main");
}

const TICKET = "Projects/Acme/Work/TEAM-200 Fix signup.md";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

/** The current workspace's terminals, when they're on screen. */
const TERMINALS = ".terminals-side:not([hidden]) .area:not([hidden]) .terminal-view";
const NOTES = ".notes-side:not([hidden])";

/** What the active terminal shows. */
function screen(page: Page): Promise<string> {
  return page
    .locator(TERMINALS)
    .first()
    .evaluate((el) => {
      type Buffer = {
        length: number;
        getLine(i: number): { translateToString(trim: boolean): string } | undefined;
      };
      const term = (el as unknown as { terminal: { buffer: { active: Buffer } } }).terminal;
      const lines: string[] = [];
      for (let i = 0; i < term.buffer.active.length; i++) {
        lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? "");
      }
      return lines.join("\n");
    });
}

async function command(page: Page, name: string) {
  await page.keyboard.press("Meta+p");
  await page.keyboard.type(name);
  await expect(page.getByRole("option").first()).toContainText(name.replace(/…$/, ""));
  await page.keyboard.press("Enter");
}

const tab = (page: Page, name: string | RegExp) =>
  page.locator(`${NOTES} .dv-tab`).filter({ hasText: name });
const bar = (page: Page) => page.locator(`${NOTES} .note-bar`).first();
const terminals = (page: Page) => page.locator(TERMINALS);

test("a ticket gets a worktree, a note and a workspace, and closes and restores", async ({
  page,
}) => {
  await command(page, "New ticket…");
  const dialog = page.getByRole("dialog", { name: "New ticket" });
  await dialog.getByLabel("Key or link").fill("https://example.atlassian.net/browse/TEAM-200");
  await dialog.getByLabel("Title").fill("Fix signup");
  await expect(dialog.getByLabel("Branch name")).toHaveAttribute("placeholder", "fix-signup");
  await dialog.getByRole("checkbox", { name: "Acme" }).check();
  await expect(dialog.getByRole("combobox", { name: "Repo" })).toContainText(
    "Automatic (acme-platform)",
  );
  await dialog.getByRole("checkbox", { name: "web" }).check();
  await dialog.getByRole("button", { name: "Create" }).click();

  // This machine doesn't know where the repo is yet.
  const locate = page.getByRole("dialog", { name: "Where is Acme platform?" });
  await locate.getByLabel("Checkout").fill(join(REPO, "apps"));
  await locate.getByRole("button", { name: "Save" }).click();

  // The workspace: the note beside a terminal running the setup.
  await expect(tab(page, "TEAM-200 Fix signup")).toBeVisible();
  await expect(terminals(page)).toHaveCount(1);
  // The echoed command can be garbled by the terminal resizing, so npm's own output counts too.
  await expect.poll(() => screen(page)).toMatch(/npm install|^npm /m);
  expect(existsSync(join(WORKTREE, "apps/web/index.js"))).toBe(true);
  await expectFile(
    VAULT,
    TICKET,
    (t) =>
      t.includes("type: ticket") &&
      t.includes('projects: ["[[Acme]]"]') &&
      t.includes("branch: TEAM-200-fix-signup") &&
      t.includes("# TEAM-200 Fix signup"),
  );
  await expect(bar(page)).toContainText("TEAM-200");
  await expect(bar(page)).toContainText("Active");
  await expect(bar(page)).toContainText("TEAM-200-fix-signup");
  await expect(bar(page).getByRole("button", { name: "Split" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Note · Split · Terminal.
  await bar(page).getByRole("button", { name: "Note" }).click();
  await expect(terminals(page)).toHaveCount(0);
  await expect(tab(page, "TEAM-200 Fix signup")).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Note" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await bar(page).getByRole("button", { name: "Split" }).click();
  await expect(terminals(page)).toHaveCount(1);
  await bar(page).getByRole("button", { name: "Terminal" }).click();
  await expect(page.getByRole("region", { name: "Notes", exact: true })).toBeHidden();
  await expect(terminals(page)).toHaveCount(1);
  await page.keyboard.press("Control+Meta+2");

  // Actions for its code.
  await bar(page).getByRole("button", { name: "Actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Run Storybook" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "web: dev" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar(page).getByRole("button", { name: "Open Jira ticket" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Open in VS Code" })).toBeVisible();

  // The tickets view, by project.
  await page.getByRole("tab", { name: "Tickets" }).click();
  const acme = page.locator(".tickets-panel").getByRole("region", { name: "Acme" });
  await expect(acme).toContainText("TEAM-200 Fix signup");
  await expect(acme).toContainText("TEAM-123 Fix login");
  await expect(acme.locator(".ticket-row").filter({ hasText: "TEAM-200" })).toContainText(
    "TEAM-200-fix-signup",
  );

  // The workspaces view groups it under its project.
  await page.getByRole("tab", { name: "Workspaces" }).click();
  await expect(page.locator(".area-group").filter({ hasText: "Acme" })).toContainText(
    "TEAM-200 Fix signup",
  );

  // Closing would lose the branch, which isn't on the remote.
  await bar(page).getByRole("button", { name: "Close ticket…" }).click();
  await expect(page.getByText("its branch isn't on the remote")).toBeVisible();
  await page.getByRole("button", { name: "Close anyway" }).click();
  await expect(page.getByText("Closed “TEAM-200 Fix signup”")).toBeVisible();
  await expect.poll(() => existsSync(WORKTREE)).toBe(false);
  await expectFile(VAULT, TICKET, (t) => t.includes("status: closed") && !t.includes("workspace:"));
  await expect(bar(page)).toContainText("Closed");
  await expect(page.locator(".area-group").filter({ hasText: "TEAM-200" })).toHaveCount(0);

  await bar(page).getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => existsSync(join(WORKTREE, "apps/web/index.js"))).toBe(true);
  await expect(bar(page)).toContainText("Active");
  await expect(terminals(page)).toHaveCount(1);
});

test("tickets blocks, adding a worktree to a note, and workspaces for any note", async ({
  page,
}) => {
  writeFileSync(
    join(VAULT, "Projects/Acme/Board.md"),
    "# Board\n\n```tickets\nproject: this\n```\n",
  );
  await quickOpen(page, "Board");
  const block = page.locator(`${NOTES} .tickets-view`);
  await expect(block).toContainText("TEAM-123 Fix login");
  await expect(block).toContainText("TEAM-200 Fix signup");
  await block.getByText("TEAM-123 Fix login").click();
  await expect(tab(page, "TEAM-123 Fix login")).toBeVisible();

  // An existing note becomes a ticket, where it is.
  const tree = page.getByRole("tree", { name: "Files" });
  await tree.getByRole("treeitem", { name: "Welcome" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add worktree…" }).click();
  const dialog = page.getByRole("dialog", { name: "Add worktree" });
  await dialog.getByLabel("Key or link").fill("TEAM-500");
  await dialog.getByRole("combobox", { name: "Repo" }).selectOption("acme-platform");
  await dialog.getByRole("button", { name: "Add worktree" }).click();
  await expect(tab(page, /^Welcome$/)).toBeVisible();
  await expect(bar(page)).toContainText("TEAM-500");
  await expectFile(VAULT, "Welcome.md", (t) => t.includes("branch: TEAM-500-welcome"));
  expect(existsSync(join(CODE, "acme-worktrees", "TEAM-500-welcome"))).toBe(true);

  // Any note can have a workspace; Jane works on Acme, so it starts there.
  await bar(page).getByRole("button", { name: "Note" }).click();
  await quickOpen(page, "Jane Doe");
  await command(page, "Open this note’s workspace");
  await expect(terminals(page)).toHaveCount(1);
  await expect(bar(page).getByRole("button", { name: "Split" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expectFile(VAULT, "Contacts/Jane Doe.md", (t) => /workspace: ws-/.test(t));
  await page.getByRole("tab", { name: "Workspaces" }).click();
  await expect(page.locator(".area-row").filter({ hasText: "Jane Doe" })).toContainText(
    "vault/Projects/Acme",
  );
});
