import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
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

/** A checkout of the fixture's second repo, `acme-infra`. */
const INFRA = join(CODE, "infra");
const INFRA_WORKTREE = join(CODE, "infra-worktrees", "TEAM-200-fix-signup");
{
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  mkdirSync(join(INFRA, "network"), { recursive: true });
  git(CODE, "init", "-q", "--bare", "-b", "main", "infra-origin.git");
  git(INFRA, "init", "-q", "-b", "main");
  git(INFRA, "config", "user.email", "test@example.com");
  git(INFRA, "config", "user.name", "Test");
  git(INFRA, "config", "commit.gpgsign", "false");
  writeFileSync(join(INFRA, "network/main.tf"), "\n");
  git(INFRA, "add", ".");
  git(INFRA, "commit", "-q", "-m", "first");
  git(INFRA, "remote", "add", "origin", join(CODE, "infra-origin.git"));
  git(INFRA, "push", "-q", "-u", "origin", "main");
}

/** A repo the vault doesn't list yet. */
const BILLING = join(CODE, "billing");
{
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  mkdirSync(BILLING, { recursive: true });
  git(BILLING, "init", "-q", "-b", "trunk");
  git(BILLING, "config", "user.email", "test@example.com");
  git(BILLING, "config", "user.name", "Test");
  git(BILLING, "config", "commit.gpgsign", "false");
  writeFileSync(join(BILLING, "README.md"), "\n");
  git(BILLING, "add", ".");
  git(BILLING, "commit", "-q", "-m", "first");
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
const views = (page: Page) => page.getByRole("group", { name: "Main view" });
const terminals = (page: Page) => page.locator(TERMINALS);
/** The current workspace's terminal tabs. */
const terminalTabs = (page: Page) =>
  page.locator(".terminals-side:not([hidden]) .area:not([hidden]) .dv-tab");

test("a ticket gets a worktree, a note and a workspace, and closes and restores", async ({
  page,
}) => {
  await command(page, "New ticket…");
  const dialog = page.getByRole("dialog", { name: "New ticket" });
  await dialog.getByLabel("Key or link").fill("https://example.atlassian.net/browse/TEAM-200");
  await dialog.getByLabel("Title").fill("Fix signup");
  await expect(dialog.getByLabel("Branch name")).toHaveAttribute("placeholder", "fix-signup");
  await dialog.getByRole("checkbox", { name: "Acme", exact: true }).check();
  // The project's one repo is chosen for it.
  await expect(dialog.getByRole("checkbox", { name: /^Acme platform/ })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /^Acme infra/ })).not.toBeChecked();
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
  await expect(views(page).getByRole("button", { name: "Split" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Notes · Split · Terminals, in the top bar.
  await views(page).getByRole("button", { name: "Notes" }).click();
  await expect(terminals(page)).toHaveCount(0);
  await expect(tab(page, "TEAM-200 Fix signup")).toBeVisible();
  await expect(views(page).getByRole("button", { name: "Notes" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await views(page).getByRole("button", { name: "Split" }).click();
  await expect(terminals(page)).toHaveCount(1);
  await views(page).getByRole("button", { name: "Terminals" }).click();
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
  await dialog.getByRole("checkbox", { name: /^Acme platform/ }).check();
  await dialog.getByRole("button", { name: "Add worktree" }).click();
  await expect(tab(page, /^Welcome$/)).toBeVisible();
  await expect(bar(page)).toContainText("TEAM-500");
  await expectFile(VAULT, "Welcome.md", (t) => t.includes("branch: TEAM-500-welcome"));
  expect(existsSync(join(CODE, "acme-worktrees", "TEAM-500-welcome"))).toBe(true);

  // Any note can have a workspace; Jane works on Acme, so it starts there.
  await views(page).getByRole("button", { name: "Notes" }).click();
  await quickOpen(page, "Jane Doe");
  await command(page, "Open this note’s workspace");
  await expect(terminals(page)).toHaveCount(1);
  await expect(views(page).getByRole("button", { name: "Split" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expectFile(VAULT, "Contacts/Jane Doe.md", (t) => /workspace: ws-/.test(t));
  await page.getByRole("tab", { name: "Workspaces" }).click();
  await expect(page.locator(".area-row").filter({ hasText: "Jane Doe" })).toContainText(
    "vault/Projects/Acme",
  );
});

test("a ticket spans repos in one workspace; its subnotes follow it; the Vault workspace", async ({
  page,
}) => {
  const header = page.locator(".terminals-header");
  await quickOpen(page, "TEAM-200 Fix signup");
  await page.keyboard.press("Control+Meta+2");
  await expect(header.locator(".terminals-name")).toHaveText("TEAM-200 Fix signup");
  const before = await terminalTabs(page).count();

  // Another repo, from the note bar; this Mac is asked where it is first.
  await bar(page).getByRole("button", { name: "Repos" }).click();
  await page.getByRole("menuitem", { name: "Add repo…" }).click();
  await page.getByRole("option", { name: /Acme infra/ }).click();
  const locate = page.getByRole("dialog", { name: "Where is Acme infra?" });
  await locate.getByLabel("Checkout").fill(INFRA);
  await locate.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Added Acme infra to “TEAM-200 Fix signup”")).toBeVisible();
  await expect.poll(() => existsSync(join(INFRA_WORKTREE, "network/main.tf"))).toBe(true);
  await expectFile(VAULT, TICKET, (t) => t.includes("repos: [acme-platform, acme-infra]"));
  // Its setup runs in a new terminal in the same workspace.
  await expect(terminalTabs(page)).toHaveCount(before + 1);
  await expect(header.locator(".terminals-name")).toHaveText("TEAM-200 Fix signup");
  await expect(bar(page).getByRole("button", { name: "Repos" })).toContainText("+1");

  // New terminals pick their worktree; the default is starred.
  await header.getByRole("button", { name: "New terminal in…" }).click();
  const platform = page.getByRole("menuitem", { name: /New terminal in Acme platform/ });
  await expect(platform.locator(".menu-star")).toHaveCount(1);
  await expect(
    page.getByRole("menuitem", { name: "New terminal in web (Acme platform)" }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: /New terminal in Acme infra/ }).click();
  await expect(terminalTabs(page)).toHaveCount(before + 2);
  await expect
    .poll(async () => {
      await page.keyboard.type("pwd\n");
      // Long paths wrap.
      return (await screen(page)).replace(/\n/g, "");
    })
    .toContain(INFRA_WORKTREE);

  // A repo the vault doesn't list yet is added from its checkout.
  const reposYml = join(VAULT, ".groundwork/repos.yml");
  const listed = readFileSync(reposYml, "utf8");
  await bar(page).getByRole("button", { name: "Repos" }).click();
  await page.getByRole("menuitem", { name: "Add repo…" }).click();
  await page.getByRole("option", { name: /Another repo, from its checkout/ }).click();
  const add = page.getByRole("dialog", { name: "Add a repo" });
  await add.getByLabel("Checkout").fill(BILLING);
  await add.getByLabel("Name").fill("Billing");
  await add.getByRole("button", { name: "Add repo" }).click();
  await expect(page.getByText("Added Billing to “TEAM-200 Fix signup”")).toBeVisible();
  expect(readFileSync(reposYml, "utf8")).toContain(
    "billing:\n  name: Billing\n  git:\n    base_branch: trunk\n",
  );
  expect(existsSync(join(CODE, "billing-worktrees", "TEAM-200-fix-signup", "README.md"))).toBe(
    true,
  );
  await expectFile(VAULT, TICKET, (t) => t.includes("repos: [acme-platform, acme-infra, billing]"));
  // Leave the vault's repos as they were for the other specs.
  writeFileSync(reposYml, listed);

  // Claude in a worktree can read the ticket's other repos. (The test's fake
  // `claude` names the options it doesn't know; long lines can come out garbled
  // as the terminal resizes, so only the start is checked.)
  await header.getByRole("button", { name: "New terminal in…" }).click();
  await page.getByRole("menuitem", { name: /New Claude in Acme infra/ }).click();
  await expect
    .poll(async () => (await screen(page)).replace(/\n/g, ""))
    .toContain("fake claude: unsupported: --add-dir /");
  // All its worktrees in one VS Code window.
  await expect(bar(page).getByRole("button", { name: "Open ticket in VS Code" })).toBeVisible();

  // The default can change.
  await header.getByRole("button", { name: "New terminal in…" }).click();
  await page.getByRole("menuitem", { name: "Make Acme infra the default" }).click();
  await expectFile(VAULT, TICKET, (t) => t.includes("repos: [acme-infra, acme-platform, billing]"));
  await expect(bar(page).getByRole("button", { name: "Repos" })).toContainText("Acme infra");

  // A subnote follows the ticket's workspace, not the project's.
  writeFileSync(
    join(VAULT, "Projects/Acme/Work/TEAM-200 Fix signup.infra.md"),
    "# The infra part\n",
  );
  await quickOpen(page, "Jane Doe");
  await expect(header.locator(".terminals-name")).toHaveText("Jane Doe");
  await quickOpen(page, "TEAM-200 Fix signup.infra");
  await expect(header.locator(".terminals-name")).toHaveText("TEAM-200 Fix signup");

  // The Vault workspace is always first to switch to, and made when picked.
  await header.locator(".terminals-name").click();
  await expect(page.getByRole("option").first()).toContainText("Vault");
  await page.keyboard.press("Enter");
  await expect(header.locator(".terminals-name")).toHaveText("Vault");
  await expect(terminalTabs(page)).toHaveCount(1);
  await page.getByRole("tab", { name: "Workspaces" }).click();
  const vaultRow = page
    .locator(".area-row")
    .filter({ has: page.locator(".area-name").getByText("Vault", { exact: true }) });
  await expect(vaultRow).toHaveCount(1);

  // Leave the shared data as it was found: no Vault workspace.
  await vaultRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(vaultRow).toHaveCount(0);
});
