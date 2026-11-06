import { expect, test } from "@playwright/test";
import { FIXTURE_VAULT } from "./fixtures";
import { openVault, switchVault } from "./helpers";

// Tests share one backend, and later tests start from the state earlier ones leave.
test.describe.configure({ mode: "serial" });

test("open a vault, browse the tree, read a note", async ({ page }) => {
  await openVault(page, FIXTURE_VAULT);

  const tree = page.getByRole("tree", { name: "Files" });
  await expect(tree.getByRole("treeitem", { name: "Welcome" })).toBeVisible();
  // Dot-folders stay hidden.
  await expect(tree.getByText(".obsidian")).toHaveCount(0);

  await tree.getByRole("treeitem", { name: "Welcome" }).click();
  await expect(page.getByTestId("editor")).toContainText("This is the Groundwork test vault");

  // Page bundles are single items, not folders.
  for (const folder of ["Projects", "Acme", "demos"]) {
    await tree.getByRole("treeitem", { name: folder, exact: true }).locator("> button").click();
  }
  const bundle = tree.getByRole("treeitem", { name: "login-flow" });
  await expect(bundle).toBeVisible();
  await expect(bundle).not.toHaveAttribute("aria-expanded");
  await bundle.click();
  await expect(
    page.frameLocator(".page-frame").getByRole("heading", { name: "Login flow" }),
  ).toBeVisible();

  // The Files toolbar folds the tree back up.
  await page
    .getByRole("toolbar", { name: "Files" })
    .getByRole("button", { name: "Collapse all" })
    .click();
  await expect(tree.getByRole("treeitem", { name: "Projects", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(bundle).toHaveCount(0);

  // The backend keeps the vault open across reloads.
  await page.reload();
  await expect(tree.getByRole("treeitem", { name: "Welcome" })).toBeVisible();
});

test("switching vaults lists it under Recent", async ({ page }) => {
  await page.goto("/");
  await switchVault(page);
  await expect(page.getByRole("heading", { name: "Recent" })).toBeVisible();
  // Every test file opens its own copy, all named `vault`; the latest is first.
  await page
    .getByRole("button", { name: /^vault/ })
    .first()
    .click();
  await expect(page.getByRole("tree", { name: "Files" })).toBeVisible();
});
