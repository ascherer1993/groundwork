import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

/** Opens `vault` from the welcome screen, or switches to it. */
export async function openVault(page: Page, vault: string) {
  await page.goto("/");
  const pathInput = page.getByLabel("Vault path");
  const switchButton = page.getByRole("button", { name: "Switch vault" });
  await expect(pathInput.or(switchButton)).toBeVisible();
  if (await switchButton.isVisible()) {
    if ((await page.locator(".vault-name").getAttribute("title")) === vault) return;
    await switchButton.click();
  }
  await pathInput.fill(vault);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tree", { name: "Files" })).toBeVisible();
}

/** Opens a file through the quick switcher. */
export async function quickOpen(page: Page, query: string) {
  await page.keyboard.press("Meta+o");
  await page.getByLabel("Find a file").fill(query);
  await expect(page.getByRole("option").first()).toBeVisible();
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
