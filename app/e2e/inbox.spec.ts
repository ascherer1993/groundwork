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

const inboxButton = (page: Page) => page.getByRole("button", { name: /^Inbox/ });
const inbox = (page: Page) => page.getByRole("dialog", { name: "Inbox" });

test("agents ask, tell and wait on you through the inbox", async ({ page }) => {
  await page.keyboard.press("Meta+t");
  await expect.poll(() => screen(page)).toMatch(/\$ ?$/m);

  // notify: something to know, with the note it's about.
  await run(page, 'groundwork notify "Tidied the welcome note" --link "[[Welcome]]"');
  await expect(inboxButton(page)).toHaveAccessibleName("Inbox, 1 waiting");
  await expect(page.getByText("Note: Tidied the welcome note")).toBeVisible();
  await inboxButton(page).click();
  const note = inbox(page).getByRole("listitem", { name: /Tidied the welcome note/ });
  await expect(note).toContainText("vault");
  await note.getByRole("button", { name: "Welcome" }).click();
  await expect(inbox(page)).toHaveCount(0);
  await expect(
    page.locator(".notes-side .dv-tab.dv-active-tab").filter({ hasText: "Welcome" }),
  ).toBeVisible();
  await inboxButton(page).click();
  await note.getByRole("button", { name: "Dismiss" }).click();
  await expect(inbox(page)).toContainText("Nothing waiting on you.");
  await expect(inboxButton(page)).toHaveAccessibleName("Inbox");
  await page.keyboard.press("Escape");

  // ask: the agent waits for the answer and gets it.
  await run(page, 'groundwork ask "Which env?" --choice staging --choice prod; echo "exit=$?"');
  await expect(inboxButton(page)).toHaveAccessibleName("Inbox, 1 waiting");
  await page.keyboard.press("Meta+Shift+i");
  const question = inbox(page).getByRole("listitem", { name: /Which env\?/ });
  await expect(question.getByRole("button", { name: "prod" })).toBeVisible();
  await question.getByLabel("Answer").fill("staging, please");
  await question.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => screen(page)).toMatch(/^staging, please\nexit=0$/m);
  await expect(inboxButton(page)).toHaveAccessibleName("Inbox");

  // Earlier: what was answered, and with what; what was dismissed.
  await inbox(page).getByRole("tab", { name: "Earlier" }).click();
  const answered = inbox(page)
    .getByRole("listitem", { name: /Which env\?/ })
    .first();
  await expect(answered).toContainText("Answered: staging, please");
  await expect(
    inbox(page)
      .getByRole("listitem", { name: /Tidied the welcome note/ })
      .first(),
  ).toContainText("Dismissed");
  await page.keyboard.press("Escape");
  // It opens on what's waiting again.
  await inboxButton(page).click();
  await expect(inbox(page).getByRole("tab", { name: "Waiting" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Escape");

  // Claude's Notification hook, while you look elsewhere: an attention
  // item and a waiting badge, until you go to the terminal.
  await run(
    page,
    `sleep 1; printf '{"session_id":"s-1","message":"Claude needs your permission to use Bash"}' | groundwork hook notification`,
  );
  await page.keyboard.press("Control+Meta+1");
  await expect(inboxButton(page)).toHaveAccessibleName("Inbox, 1 waiting", { timeout: 10_000 });
  await page.getByRole("tab", { name: "Workspaces" }).click();
  const row = page.locator(".area-row").filter({ hasText: "vault" }).first();
  await expect(row.getByRole("status")).toHaveAttribute("aria-label", "Waiting on you");
  await inboxButton(page).click();
  const waiting = inbox(page).getByRole("listitem", { name: /needs your permission/ });
  await expect(waiting).toContainText("Claude is waiting");
  await waiting.getByRole("button", { name: "Go to the terminal" }).click();
  await expect(page.getByRole("region", { name: "Terminals", exact: true })).toBeVisible();
  await expect(inboxButton(page)).toHaveAccessibleName("Inbox");
  await expect(row.getByRole("status")).not.toHaveAttribute("aria-label", "Waiting on you");

  // Leave no workspace behind.
  await page.keyboard.press("Meta+w");
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row).toHaveCount(0);
});
