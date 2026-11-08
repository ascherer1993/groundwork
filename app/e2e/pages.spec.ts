import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_VAULT as VAULT } from "./fixtures";
import { expectFile, openVault, quickOpen, showLinks } from "./helpers";

test.describe.configure({ mode: "serial" });

const BUNDLE = "Projects/Acme/demos/login-flow.page";
const SKETCH = "Projects/Acme/demos/sketch.html";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await openVault(page, VAULT);
});

function activePanel(page: Page) {
  return page.locator(".area:not([hidden]) .dv-groupview.dv-active-group");
}

function frame(page: Page) {
  return activePanel(page).frameLocator(".page-frame");
}

test("a page runs in its tab, and its source is a click away", async ({ page }) => {
  await quickOpen(page, "sketch.html");
  await expect(frame(page).getByText("A single-file page.")).toBeVisible();

  await activePanel(page).getByRole("radio", { name: "Source" }).click();
  await expect(activePanel(page).getByTestId("file-text")).toContainText("<title>Sketch</title>");
  await page.keyboard.press("Meta+e");
  await expect(frame(page).getByText("A single-file page.")).toBeVisible();

  // The page can't reach the app: no origin of its own, so no DOM access and
  // the backend refuses its connections.
  const sandbox = await activePanel(page).locator(".page-frame").getAttribute("sandbox");
  expect(sandbox).not.toContain("allow-same-origin");
  const inPage = page.frames().find((f) => f.url().includes("/sketch.html"))!;
  const reach = await inPage.evaluate(
    (url) =>
      new Promise((resolve) => {
        let parent = "readable";
        try {
          // (The e2e tsconfig has no DOM types.)
          const frameWindow = globalThis as unknown as { parent: { document: { title: string } } };
          void frameWindow.parent.document.title;
        } catch {
          parent = "blocked";
        }
        const ws = new WebSocket(url);
        ws.onopen = () => resolve(`${parent}, socket open`);
        ws.onerror = () => resolve(`${parent}, socket refused`);
      }),
    "ws://127.0.0.1:1441", // the e2e backend (playwright.config.ts)
  );
  expect(reach).toBe("blocked, socket refused");

  // App shortcuts work while the page has focus.
  await frame(page).getByText("A single-file page.").click();
  await page.keyboard.press("Meta+o");
  await expect(page.getByLabel("Find a file")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("state saves to the bundle and follows edits made elsewhere", async ({ page }) => {
  await quickOpen(page, "login-flow");
  const box = frame(page).getByRole("checkbox", { name: "I've reviewed this" });
  await expect(box).not.toBeChecked();
  // The bundle's stylesheet applies (teal headings in light mode).
  await expect(frame(page).getByRole("heading", { name: "Login flow" })).toHaveCSS(
    "color",
    "rgb(15, 118, 110)",
  );
  // readFile: the timings start from a CSV next to the bundle.
  const login = frame(page).getByRole("spinbutton").first();
  await expect(login).toHaveValue("120");

  await box.check();
  await expectFile(VAULT, `${BUNDLE}/state.json`, (t) => t === '{\n  "reviewed": true\n}\n');

  // Claude (or anyone) editing the state file updates the open page, without a reload.
  writeFileSync(join(VAULT, BUNDLE, "state.json"), '{ "reviewed": false }');
  await expect(box).not.toBeChecked();

  // Editing a timing keeps it in the state; the CSV stays as it was.
  await box.check();
  await login.fill("150");
  await login.press("Tab");
  await expectFile(
    VAULT,
    `${BUNDLE}/state.json`,
    (t) => t.includes('"reviewed": true') && t.includes('"login": 150'),
  );
  await expect(frame(page).getByText("(CSV: 120)")).toBeVisible();
  expect(readFileSync(join(VAULT, "Projects/Acme/demos/timings.csv"), "utf8")).toContain(
    "login,120",
  );

  // And the state is there the next time the page opens.
  await page.reload();
  await expect(frame(page).getByRole("checkbox", { name: "I've reviewed this" })).toBeChecked();
  await expect(frame(page).getByRole("spinbutton").first()).toHaveValue("150");

  // Resetting drops the edits from the state.
  await frame(page).getByRole("button", { name: "Reset to the CSV" }).click();
  await expect(frame(page).getByRole("spinbutton").first()).toHaveValue("120");
  await expectFile(VAULT, `${BUNDLE}/state.json`, (t) => t === '{\n  "reviewed": true\n}\n');
});

test("links in a page open notes in Groundwork", async ({ page }) => {
  await quickOpen(page, "login-flow");
  await frame(page).getByRole("link", { name: "Back to Acme" }).click();
  await expect(activePanel(page).locator(".inline-title")).toHaveValue("Acme");

  // Back to the page; a [[wikilink]] href works too.
  await page.keyboard.press("Meta+[");
  await frame(page).getByRole("link", { name: "Kickoff notes" }).click();
  await expect(activePanel(page).locator(".inline-title")).toHaveValue("2026-11-02 Kickoff");
});

test("diagrams render once when views switch quickly", async ({ page }) => {
  // Mermaid loads on first use; reading view and live preview both render
  // Acme's diagram while it does.
  await quickOpen(page, "sketch.html");
  await frame(page).getByRole("link", { name: "Acme" }).click();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Meta+e");
  const reading = activePanel(page).locator(".reading-view");
  await expect(reading.locator(".mermaid-block svg")).toHaveCount(1);
  await expect(page.locator(".mermaid-error")).toHaveCount(0);
  // Nothing of Mermaid's left at the end of the page.
  await expect(page.locator('body > [id^="dmermaid"]')).toHaveCount(0);
});

test("embeds are live and size themselves; pages reload when edited", async ({ page }) => {
  await quickOpen(page, "Demo review");
  await page.keyboard.press("Meta+e");
  const reading = activePanel(page).locator(".reading-view");
  const embeds = reading.locator(".embed-page .page-frame");
  await expect(embeds).toHaveCount(2);

  const bundle = reading.frameLocator(".embed-page .page-frame >> nth=0");
  await expect(bundle.getByRole("heading", { name: "Login flow" })).toBeVisible();
  // Taller than the placeholder: the page reported its height.
  await expect
    .poll(() => embeds.nth(0).evaluate((f) => f.getBoundingClientRect().height))
    .toBeGreaterThan(170);
  await expect(embeds.nth(1)).toHaveCSS("height", "120px");

  // An edit outside Groundwork shows up in the embed.
  const sketch = join(VAULT, SKETCH);
  writeFileSync(
    sketch,
    readFileSync(sketch, "utf8").replace("A single-file page.", "An edited page."),
  );
  const sketchFrame = reading.frameLocator(".embed-page .page-frame >> nth=1");
  await expect(sketchFrame.getByText("An edited page.")).toBeVisible();

  // In live preview too.
  await page.keyboard.press("Meta+e");
  const live = activePanel(page).locator(".cm-embed .embed-page .page-frame");
  await expect(live).toHaveCount(2);
  await expect(
    activePanel(page)
      .frameLocator(".cm-embed .embed-page .page-frame >> nth=0")
      .getByRole("heading", { name: "Login flow" }),
  ).toBeVisible();
});

test("clicking around an embed doesn't edit it; its buttons fold it and show its source", async ({
  page,
}) => {
  const note = join(VAULT, "Projects/Acme/demos/Ranking demo.md");
  writeFileSync(
    note,
    "---\ncreated: 2026-11-03T20:15\n---\n# Ranking\n\nRank the options.\n\n![[login-flow.page]]\n",
  );
  // Other tests count the page's backlinks.
  page.once("close", () => rmSync(note, { force: true }));
  await quickOpen(page, "Ranking demo");
  const panel = activePanel(page);
  const embed = panel.locator(".cm-embed-block");
  const header = embed.locator(".embed-header");
  const frameEl = embed.locator(".page-frame");
  await expect(header.getByRole("link", { name: "login-flow.page" })).toBeVisible();
  await expect(panel.locator(".cm-properties")).toBeVisible();

  // Beside the link, between header and page, beside the embed: nothing moves.
  const box = (await header.getByRole("link").boundingBox())!;
  const head = (await header.boundingBox())!;
  const whole = (await embed.boundingBox())!;
  for (const [x, y] of [
    [box.x + box.width + 30, box.y + box.height / 2],
    [box.x + 10, head.y + head.height + 2],
    [whole.x - 10, whole.y + 60],
  ] as const) {
    await page.mouse.click(x, y);
    await expect(embed).toBeVisible();
    await expect(panel.locator(".cm-properties")).toBeVisible();
    await expect(panel.locator(".cm-wikilink-source")).toHaveCount(0);
  }

  // The chevron folds the page away and back.
  const toggle = header.getByRole("button", { name: "Collapse embed" });
  await toggle.click();
  await expect(frameEl).toBeHidden();
  await expect(header.getByRole("button", { name: "Expand embed" })).toBeVisible();
  await expect(panel.locator(".cm-wikilink-source")).toHaveCount(0);
  await header.getByRole("button", { name: "Expand embed" }).click();
  await expect(frameEl).toBeVisible();

  // </> shows the source, with the cursor in it.
  await embed.getByRole("button", { name: "Edit embed" }).click();
  await expect(panel.locator(".cm-wikilink-source")).toHaveText("![[login-flow.page]]");
  await expect(embed).toHaveCount(0);
  await page.keyboard.type("x");
  await expect(panel.locator(".cm-wikilink-source")).toHaveText("![[login-flow.pagex]]");
  await page.keyboard.press("Backspace");

  // And the link still opens the page in one click.
  await panel.locator(".cm-line").filter({ hasText: "Rank the options." }).click();
  await expect(embed).toBeVisible();
  await embed.getByRole("link", { name: "login-flow.page" }).click();
  await expect(
    page.locator(".notes-side .dv-tab.dv-active-tab").filter({ hasText: "login-flow" }),
  ).toBeVisible();
});

test("a page's backlinks show in the links panel", async ({ page }) => {
  await quickOpen(page, "login-flow");
  await showLinks(page);
  const backlinks = page.getByTestId("backlinks");
  await expect(backlinks.locator(".link-source")).toHaveText(["Acme", "Demo review"]);
  await expect(page.getByTestId("outgoing")).toHaveCount(0);
});
