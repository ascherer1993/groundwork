import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { editor, expectFile, openVault, quickOpen } from "./helpers";

test.describe.configure({ mode: "serial" });

/**
 * Pastes (into the focused editor) or drops (at `x`, `y`) a 40×20 red PNG
 * named `name`, drawn in the page. In-page code is a string: the e2e
 * tsconfig has no DOM types.
 */
async function sendImage(page: Page, name: string, drop?: { x: number; y: number }) {
  await page.evaluate(`(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 20;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 40, 20);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], ${JSON.stringify(name)}, { type: "image/png" }));
    const drop = ${JSON.stringify(drop ?? null)};
    const init = { bubbles: true, cancelable: true };
    if (drop) {
      document.elementFromPoint(drop.x, drop.y).dispatchEvent(
        new DragEvent("drop", { ...init, dataTransfer: data, clientX: drop.x, clientY: drop.y }),
      );
    } else {
      document.activeElement.dispatchEvent(new ClipboardEvent("paste", { ...init, clipboardData: data }));
    }
  })()`);
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

test.afterAll(() => {
  rmSync(join(VAULT, "attachments"), { recursive: true, force: true });
});

test("pasting an image saves it and embeds it; its corner resizes it", async ({ page }) => {
  const note = "Image paste.md";
  writeFileSync(join(VAULT, note), "Before\n");
  await quickOpen(page, "Image paste");
  const cm = editor(page);
  await cm.locator(".cm-line").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");

  await sendImage(page, "image.png");

  await expectFile(VAULT, note, (t) => /^Before\n!\[\[Pasted image \d{14}\.png\]\]\n?$/.test(t));
  const files = readdirSync(join(VAULT, "attachments"));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^Pasted image \d{14}\.png$/);

  // Move the cursor off the embed so it shows as the image.
  await cm.locator(".cm-line").first().click();
  const img = cm.locator(".cm-embed-image img");
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((i) => (i as unknown as { naturalWidth: number }).naturalWidth))
    .toBe(40);

  // Drag the corner handle 60px to the right: 40px → 100px.
  const box = (await img.boundingBox())!;
  await img.hover();
  const handle = cm.locator(".cm-image-resize");
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 30, h.y + h.height / 2, { steps: 3 });
  await page.mouse.move(h.x + h.width / 2 + 60, h.y + h.height / 2, { steps: 3 });
  await page.mouse.up();
  const width = Math.round(box.width + 60);
  await expectFile(VAULT, note, (t) => t.includes(`.png|${width}]]`));
  await expect(cm.locator(".cm-embed-image img")).toHaveAttribute("width", String(width));

  rmSync(join(VAULT, note));
  expect(existsSync(join(VAULT, note))).toBe(false);
});

test("dropping an image keeps its name", async ({ page }) => {
  const note = "Image drop.md";
  writeFileSync(join(VAULT, note), "Dropped here: \n");
  await quickOpen(page, "Image drop");
  const line = editor(page).locator(".cm-line").first();
  await expect(line).toHaveText("Dropped here: ");
  const box = (await line.boundingBox())!;

  await sendImage(page, "My chart.png", { x: box.x + box.width - 2, y: box.y + box.height / 2 });

  await expectFile(VAULT, note, (t) => t.startsWith("Dropped here: ![[My chart.png]]"));
  expect(existsSync(join(VAULT, "attachments/My chart.png"))).toBe(true);
  rmSync(join(VAULT, note));
});

test("a clicked image shows its source above it, and drags to a new place", async ({ page }) => {
  const note = "Image move.md";
  mkdirSync(join(VAULT, "attachments"), { recursive: true });
  writeFileSync(
    join(VAULT, "attachments/move.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="teal"/></svg>',
  );
  writeFileSync(join(VAULT, note), "First line\n![[move.svg]]\nLast line\n");
  await quickOpen(page, "Image move");
  const cm = editor(page);
  await cm.locator(".cm-line").first().click();
  const img = cm.locator(".cm-embed-image img");
  await expect(img).toBeVisible();

  // Clicking shows the source, and the image stays, below it.
  await img.click();
  await expect(cm.locator(".cm-wikilink-source")).toHaveText("![[move.svg]]");
  await expect(cm.locator(".cm-embed-preview img")).toBeVisible();
  // Clicking the image again keeps it all.
  await cm.locator(".cm-embed-preview img").click();
  await expect(cm.locator(".cm-wikilink-source")).toHaveText("![[move.svg]]");
  await expect(cm.locator(".cm-embed-preview img")).toBeVisible();

  // Dragging it to the start of the first line moves it there, line and all.
  await cm.locator(".cm-line", { hasText: "Last line" }).click();
  const first = cm.locator(".cm-line", { hasText: "First line" });
  const box = (await first.boundingBox())!;
  await cm.locator(".cm-embed-image img").dragTo(first, {
    targetPosition: { x: 1, y: box.height / 2 },
  });
  await expectFile(VAULT, note, (t) => t === "![[move.svg]]\nFirst line\nLast line\n");
  rmSync(join(VAULT, note));
});
