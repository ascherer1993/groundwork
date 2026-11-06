import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

/** Opens `vault` from the welcome screen, or switches to it. */
export async function openVault(page: Page, vault: string) {
  await page.goto("/");
  const pathInput = page.getByLabel("Vault path");
  const vaultMenu = page.locator(".vault-name");
  await expect(pathInput.or(vaultMenu)).toBeVisible();
  if (await vaultMenu.isVisible()) {
    if ((await vaultMenu.getAttribute("title")) === vault) return;
    await switchVault(page);
  }
  await pathInput.fill(vault);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tree", { name: "Files" })).toBeVisible();
}

/** Back to the welcome screen, through the menu on the vault's name. */
export async function switchVault(page: Page) {
  await page.locator(".vault-name").click();
  await page.getByRole("menuitem", { name: "Switch vault…" }).click();
}

/** Opens the links panel beside the active tab. */
export async function showLinks(page: Page) {
  const toggle = page.locator(".dv-active-group .file-header").getByRole("button", {
    name: "Links panel",
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
}

/** Opens a file through the quick switcher. */
export async function quickOpen(page: Page, query: string) {
  await page.keyboard.press("Meta+o");
  await page.getByLabel("Find a file").fill(query);
  await expect(
    page.getByRole("listbox", { name: "Files" }).getByRole("option").first(),
  ).toBeVisible();
  await page.keyboard.press("Enter");
}

export function readNote(vault: string, path: string): string {
  const full = join(vault, path);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

/** Waits until a file on disk satisfies `check`. */
export async function expectFile(vault: string, path: string, check: (text: string) => boolean) {
  const deadline = Date.now() + 5000;
  let text = readNote(vault, path);
  while (!check(text)) {
    if (Date.now() > deadline) throw new Error(`${path} never matched. It contains:\n${text}`);
    await new Promise((r) => setTimeout(r, 100));
    text = readNote(vault, path);
  }
}

/** The active tab's editor content. */
export function editor(page: Page) {
  return page.locator(
    ".area:not([hidden]) .dv-groupview.dv-active-group [data-testid=editor] .cm-content",
  );
}
