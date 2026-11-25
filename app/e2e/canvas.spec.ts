import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { expectFile, openVault, quickOpen } from "./helpers";

// Canvases (PLAN §5.17): Excalidraw drawings in `.excalidraw` files.

test.describe.configure({ mode: "serial" });

const ARCHITECTURE = "Projects/Acme/demos/Architecture.excalidraw";
const KICKOFF = "Projects/Acme/Meetings/2026-11-02 Kickoff";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

const tree = (page: Page) => page.getByRole("tree", { name: "Files" });
const item = (page: Page, name: string) => tree(page).getByRole("treeitem", { name, exact: true });
const row = (page: Page, name: string) => item(page, name).locator("> button");

/** Opens each folder in turn, outermost first. */
async function expand(page: Page, ...folders: string[]) {
  for (const name of folders) {
    const folder = item(page, name);
    await expect(folder).toBeVisible();
    if ((await folder.getAttribute("aria-expanded")) !== "true") await row(page, name).click();
  }
}

function canvas(page: Page) {
  return page.locator(".area:not([hidden]) .dv-groupview.dv-active-group [data-testid=canvas]");
}

type Scene = { elements: { type: string; isDeleted?: boolean; customData?: { icon?: string } }[] };

function scene(path: string): Scene {
  return JSON.parse(readFileSync(join(VAULT, path), "utf8")) as Scene;
}

/** Drags across the canvas with whatever tool is chosen. */
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const box = (await canvas(page).locator("canvas.interactive").boundingBox())!;
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2, {
    steps: 4,
  });
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 4 });
  await page.mouse.up();
}

/** What the page sees, as far as these tests need (e2e has no DOM types). */
type Browser = {
  copied?: { type: string; width: number; height: number } | null;
  navigator: {
    clipboard: { write(items: { getType(type: string): Promise<Blob> }[]): Promise<void> };
  };
  createImageBitmap(blob: Blob): Promise<{ width: number; height: number }>;
};

/** Replaces the clipboard with one that records what's written to it. */
async function recordClipboard(page: Page) {
  await page.evaluate(() => {
    const w = globalThis as unknown as Browser;
    w.copied = null;
    w.navigator.clipboard.write = async (items) => {
      const blob = await items[0]!.getType("image/png");
      const image = await w.createImageBitmap(blob);
      w.copied = { type: blob.type, width: image.width, height: image.height };
    };
  });
}

function copied(page: Page) {
  return page.evaluate(() => (globalThis as unknown as Browser).copied);
}

test("a canvas opens from the tree, offline, with only the app's own fonts", async ({ page }) => {
  const outside: string[] = [];
  const fonts: number[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname) && !/^(data|blob):/.test(r.url()))
      outside.push(r.url());
  });
  page.on("response", (r) => {
    if (r.url().includes("/excalidraw/fonts/")) fonts.push(r.status());
  });

  await page.reload();
  await expand(page, "Projects", "Acme", "demos");
  // Listed by name, with its own icon, without `.excalidraw`.
  const architecture = item(page, "Architecture");
  await expect(architecture.locator(".kind-canvas")).toBeVisible();
  await expect(architecture).toHaveText("Architecture");
  await row(page, "Architecture").click();

  await expect(canvas(page).locator(".excalidraw")).toBeVisible();
  await expect(page.locator(".dv-tab.dv-active-tab")).toContainText("Architecture");
  await expect.poll(() => fonts.length).toBeGreaterThan(0);
  expect(fonts.every((status) => status === 200)).toBe(true);
  expect(outside).toEqual([]);
});

test("drawing saves to the file, and ⌘Z undoes the drawing", async ({ page }) => {
  await quickOpen(page, "Architecture");
  await expect(canvas(page).locator(".excalidraw")).toBeVisible();
  const before = scene(ARCHITECTURE).elements.length;

  await canvas(page).getByTestId("toolbar-rectangle").click({ force: true });
  await drag(page, [600, 360], [720, 440]);
  await expectFile(VAULT, ARCHITECTURE, (t) => {
    const s = JSON.parse(t) as Scene;
    return s.elements.length === before + 1 && s.elements.at(-1)!.type === "rectangle";
  });

  // Not "undo the last file change": the canvas's own undo.
  await page.keyboard.press("Meta+z");
  await expectFile(VAULT, ARCHITECTURE, (t) => (JSON.parse(t) as Scene).elements.length === before);
});

test("copying takes only what's drawn, plus a margin, at twice the size", async ({ page }) => {
  await quickOpen(page, "Architecture");
  await expect(canvas(page).locator(".excalidraw")).toBeVisible();
  await recordClipboard(page);
  await canvas(page).getByRole("button", { name: "Copy as image" }).click();
  await expect(page.getByText("Copied the drawing as an image")).toBeVisible();
  // The drawing spans 480 × 80 (see the fixture); 24 around it; drawn at 2×.
  const image = await copied(page);
  expect(image?.type).toBe("image/png");
  expect(Math.abs(image!.width - (480 + 48) * 2)).toBeLessThanOrEqual(8);
  expect(Math.abs(image!.height - (80 + 48) * 2)).toBeLessThanOrEqual(8);

  // Exporting saves the same picture as a file.
  const download = page.waitForEvent("download");
  await canvas(page).getByRole("button", { name: "Export image" }).click();
  await page.getByRole("menuitem", { name: "Export JPEG…" }).click();
  expect((await download).suggestedFilename()).toBe("Architecture.jpg");
});

test("a new canvas from a folder's menu, with an icon on it", async ({ page }) => {
  await expand(page, "Projects", "Acme", "demos");
  await row(page, "demos").click({ button: "right" });
  await page.getByRole("menuitem", { name: "New specialty note" }).hover();
  await page
    .getByRole("menu", { name: "New specialty note" })
    .getByRole("menuitem", { name: "Canvas…" })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("Login flow");
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();

  const path = "Projects/Acme/demos/Login flow.excalidraw";
  await expect(canvas(page).locator(".excalidraw")).toBeVisible();
  expect(scene(path).elements).toEqual([]);
  await expect(item(page, "Login flow")).toBeVisible();

  // Nothing to copy yet.
  await canvas(page).getByRole("button", { name: "Copy as image" }).click();
  await expect(page.getByText("Nothing drawn yet")).toBeVisible();

  await canvas(page).getByRole("button", { name: "Icons" }).click();
  const picker = canvas(page).getByRole("dialog", { name: "Icons" });
  // The common ones first; a search finds the rest.
  await expect(picker.getByRole("button", { name: "server", exact: true })).toBeVisible();
  await picker.getByLabel("Search icons").fill("database");
  await picker.getByRole("button", { name: "database", exact: true }).click();
  await expectFile(VAULT, path, (t) => {
    const els = (JSON.parse(t) as Scene).elements;
    return els.length > 1 && els.every((el) => el.customData?.icon === "Database");
  });
  // Drawn with lines and shapes the canvas can recolour, not as a picture.
  const types = new Set(scene(path).elements.map((el) => el.type));
  expect(types.has("image")).toBe(false);
  expect([...types].every((t) => ["line", "ellipse", "rectangle"].includes(t))).toBe(true);
  await page.screenshot({ path: test.info().outputPath("icon.png") });
});

test("canvases can be subnotes, and move with their note", async ({ page }) => {
  await quickOpen(page, "2026-11-02 Kickoff");
  const kickoff = item(page, "2026-11-02 Kickoff");
  // The fixture's diagram is listed under the meeting, by its key.
  const diagram = kickoff.getByRole("treeitem", { name: "2026-11-02 Kickoff.diagram" });
  await expect(diagram).toHaveText("diagram");
  await expect(diagram.locator(".kind-canvas")).toBeVisible();

  await row(page, "2026-11-02 Kickoff").click({ button: "right" });
  await page.getByRole("menuitem", { name: "New specialty subnote" }).click();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").getByRole("textbox").fill("flow");
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await expect(canvas(page).locator(".excalidraw")).toBeVisible();
  expect(existsSync(join(VAULT, `${KICKOFF}.flow.excalidraw`))).toBe(true);
  await expect(kickoff.getByRole("treeitem", { name: "2026-11-02 Kickoff.flow" })).toHaveText(
    "flow",
  );

  // Its tab goes back up to the meeting; the meeting's bar has it.
  await page
    .getByRole("toolbar", { name: "Subnotes" })
    .getByRole("button", { name: "2026-11-02 Kickoff" })
    .click();
  await page
    .getByRole("toolbar", { name: "Subnotes" })
    .getByRole("button", { name: "diagram" })
    .click();
  await expect(canvas(page).locator(".excalidraw")).toBeVisible();
});

test("a change made elsewhere shows up, and later edits keep it", async ({ page }) => {
  const path = "Projects/Acme/Meetings/2026-11-02 Kickoff.diagram.excalidraw";
  await quickOpen(page, "Kickoff.diagram");
  await expect(canvas(page).locator(".excalidraw")).toBeVisible();

  const data = JSON.parse(readFileSync(join(VAULT, path), "utf8")) as {
    elements: Record<string, unknown>[];
  };
  data.elements.push({ ...data.elements[0]!, id: "from-elsewhere", x: 400, boundElements: [] });
  writeFileSync(join(VAULT, path), JSON.stringify(data, null, 2));
  // Give the watcher a moment to pass it on.
  await page.waitForTimeout(800);

  await canvas(page).getByTestId("toolbar-rectangle").click({ force: true });
  await drag(page, [620, 420], [720, 480]);
  await expectFile(VAULT, path, (t) => {
    const els = (JSON.parse(t) as { elements: { id: string; type: string }[] }).elements;
    return (
      els.some((el) => el.id === "from-elsewhere") && els.some((el) => el.type === "rectangle")
    );
  });
});

test("canvases can follow the app or stay light or dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await quickOpen(page, "Architecture");
  const excalidraw = canvas(page).locator(".excalidraw");
  await expect(excalidraw).not.toHaveClass(/theme--dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(excalidraw).toHaveClass(/theme--dark/);
  await page.screenshot({ path: test.info().outputPath("dark.png") });

  await page.keyboard.press("Meta+,");
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: "Canvases" })
    .click();
  await page.getByLabel("Canvas look").selectOption("light");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(excalidraw).not.toHaveClass(/theme--dark/);

  // It's kept: still light after a reload, though the app is dark.
  await page.reload();
  await quickOpen(page, "Architecture");
  await expect(canvas(page).locator(".excalidraw")).toBeVisible();
  await expect(canvas(page).locator(".excalidraw")).not.toHaveClass(/theme--dark/);

  await page.keyboard.press("Meta+,");
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: "Canvases" })
    .click();
  await page.getByLabel("Canvas look").selectOption("app");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(canvas(page).locator(".excalidraw")).toHaveClass(/theme--dark/);
  await page.emulateMedia({ colorScheme: "light" });
});
