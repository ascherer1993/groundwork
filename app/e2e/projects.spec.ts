import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { expectFile, openVault, quickOpen } from "./helpers";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const view = (page: Page) => page.locator(".notes-side .project-view");
const names = (page: Page, section: string) =>
  view(page).getByRole("region", { name: section }).locator(".project-name");

test("a project's view lists its events, with search, filters and sort", async ({ page }) => {
  // From the overview note.
  await quickOpen(page, "Acme");
  await page
    .getByRole("toolbar", { name: "Project" })
    .getByRole("button", { name: "Project view" })
    .click();
  await expect(view(page).getByRole("heading", { name: "Acme" })).toBeVisible();
  await expect(page.locator(".notes-side .dv-tab.dv-active-tab")).toHaveText("Acme");
  await expect(page.locator(".notes-side .crumbs")).toHaveText("ProjectAcme");
  await view(page)
    .getByRole("tab", { name: /Events/ })
    .click();

  // Events in Events/ with the project, and the meetings in its folder;
  // not the offsite, which isn't Acme's. Newest first.
  await expect(names(page, "Events")).toHaveText(["Vendor call", "Kickoff", "Planning"]);
  await expect(view(page).locator(".project-row").first()).toContainText("Jane Doe, Sam Lee");
  await view(page).getByLabel("Search events").fill("sam");
  await expect(names(page, "Events")).toHaveText(["Vendor call"]);
  await view(page).getByLabel("Search events").fill("");
  await view(page).getByRole("combobox", { name: "Sort" }).selectOption("oldest");
  await expect(names(page, "Events")).toHaveText(["Planning", "Kickoff", "Vendor call"]);
  await view(page).getByRole("combobox", { name: "Sort" }).selectOption("title");
  await expect(names(page, "Events")).toHaveText(["Kickoff", "Planning", "Vendor call"]);
  await view(page).getByRole("combobox", { name: "Sort" }).selectOption("newest");
  await view(page).getByRole("button", { name: "Upcoming" }).click();
  await expect(view(page).getByText("No events match.")).toBeVisible();

  // A new event from here is the project's.
  await view(page).getByRole("button", { name: "New event" }).click();
  const dialog = page.getByRole("dialog", { name: "New event" });
  await expect(dialog.getByLabel("Project")).toHaveValue("acme");
  await dialog.getByLabel("Title", { exact: true }).fill("Launch");
  await dialog.getByLabel("Date").fill(inDays(30));
  await page.keyboard.press("Enter");
  const path = `Events/${inDays(30)} Launch.md`;
  await expectFile(VAULT, path, (t) => t.includes('projects: ["[[Acme]]"]'));
  await expect(page.locator(".notes-side .dv-tab.dv-active-tab")).toContainText("Launch");

  // Back to the view, where it's upcoming.
  await page.getByRole("button", { name: "Back" }).first().click();
  await expect(names(page, "Events")).toHaveText(["Launch"]);
  await expect(view(page).locator(".project-row.is-upcoming")).toHaveCount(1);
  await view(page).getByRole("button", { name: "Past" }).click();
  await expect(names(page, "Events")).toHaveText(["Vendor call", "Kickoff", "Planning"]);

  // An event opens in the tab.
  await view(page)
    .getByRole("button", { name: /Kickoff/ })
    .click();
  await expect(page.locator(".notes-side .dv-tab.dv-active-tab")).toContainText("Kickoff");
});

test("a project's people are its members and the people its notes mention", async ({ page }) => {
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("project’s view");
  await page.keyboard.press("Enter");
  await page.getByRole("option", { name: /Acme/ }).click();
  await view(page)
    .getByRole("tab", { name: /People/ })
    .click();

  const people = view(page).getByRole("region", { name: "People" });
  await expect(names(page, "People")).toHaveText(["Jane Doe", "Priya Shah", "Sam Lee"]);
  const jane = people.getByRole("button", { name: /Jane Doe/ });
  await expect(jane).toContainText("Member");
  await expect(jane).toContainText("Mentioned in 5 notes");
  await expect(jane).toContainText("Staff Engineer · Acme");
  await expect(people.getByRole("button", { name: /Sam Lee/ })).not.toContainText("Member");

  await people.getByRole("button", { name: "Mentioned only" }).click();
  await expect(names(page, "People")).toHaveText(["Sam Lee"]);
  await people.getByRole("button", { name: "Members" }).click();
  await expect(names(page, "People")).toHaveText(["Jane Doe", "Priya Shah"]);
  await people.getByRole("button", { name: "All" }).click();
  await people.getByLabel("Search people").fill("contoso");
  await expect(names(page, "People")).toHaveText(["Sam Lee"]);
  await people.getByLabel("Search people").fill("");
  await people.getByRole("combobox", { name: "Sort" }).selectOption("mentions");
  await expect(names(page, "People").first()).toHaveText("Jane Doe");
  await people.getByRole("combobox", { name: "Sort" }).selectOption("seen");
  await expect(names(page, "People")).toHaveText(["Jane Doe", "Sam Lee", "Priya Shah"]);

  // Its tickets, too.
  await view(page).getByRole("tab", { name: "Tickets" }).click();
  await expect(view(page).locator(".ticket-list")).toContainText("TEAM-123 Fix login");

  // The Tickets panel's project headings open it as well.
  await quickOpen(page, "Welcome");
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("Show tickets");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Acme", exact: true }).click();
  await expect(view(page).getByRole("heading", { name: "Acme" })).toBeVisible();
});
