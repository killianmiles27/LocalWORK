import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
const root = resolve(import.meta.dirname, "../..");
const reviewDir = resolve(root, ".audit-tools/model-picker-review");
await mkdir(reviewDir, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, "vendor/browsers");
const { chromium } = createRequire(resolve(root, "vendor/playwright/package.json"))("playwright-core");
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, clearScreen: false });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1276, height: 570 } });
  const errors = []; page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`${server.resolvedUrls.local[0]}scripts/tests/model-picker-fixture.html`);
  const trigger = page.getByTestId("mode-switcher");
  await trigger.waitFor(); await trigger.click();
  const menu = page.getByRole("menu", { name: "Choose model" });
  const modelRows = menu.locator('button[role="menuitem"][aria-haspopup="menu"]');
  await page.waitForFunction(() => document.querySelectorAll('[role="menu"][aria-label="Choose model"] button[role="menuitem"][aria-haspopup="menu"]').length === 2);
  assert.equal(await modelRows.count(), 2, "only Swift Q2 and Gemma 4 should appear as model rows");
  await menu.getByRole("menuitem", { name: /Swift Q2/ }).hover();
  const profiles = page.getByRole("menu", { name: "Swift Q2 profiles" });
  await profiles.waitFor();
  assert.equal(await profiles.getByRole("menuitemradio").count(), 2, "Swift should expose only the 128K and 256K profiles");
  const rootRect = await menu.boundingBox(), profileRect = await profiles.boundingBox();
  assert.ok(profileRect.x >= rootRect.x + rootRect.width, "with ample room, profile choices should open to the model's right");
  await page.screenshot({ path: resolve(reviewDir, "wide-right-submenu.png") });
  await profiles.getByRole("menuitemradio", { name: "256K" }).click();
  await page.waitForFunction(() => window.calls.some(c => c.cmd === "mode_switch" && c.args.id === "swift-q2-256"));

  await trigger.click();
  const keyboardMenu = page.getByRole("menu", { name: "Choose model" });
  const swift = keyboardMenu.getByRole("menuitem", { name: /Swift Q2/ });
  await swift.focus(); await page.keyboard.press("ArrowRight");
  await page.getByRole("menu", { name: "Swift Q2 profiles" }).getByRole("menuitemradio").first().waitFor();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.getByRole("menu", { name: "Swift Q2 profiles" }).count(), 0, "ArrowLeft should return from profiles to the model list");
  await page.keyboard.press("Escape");
  assert.equal(await keyboardMenu.count(), 0, "Escape should close the picker");
  assert.equal(await trigger.evaluate(e => document.activeElement === e), true, "Escape should return focus to the picker trigger");

  await trigger.click();
  await page.getByRole("menu", { name: "Choose model" }).getByRole("menuitem", { name: /Gemma 4/ }).hover();
  await page.getByRole("menu", { name: "Gemma 4 profiles" }).waitFor();
  for (const viewport of [{ width: 900, height: 700 }, { width: 460, height: 400 }, { width: 1276, height: 570 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(60);
    const bounds = await page.locator('[role="menu"]').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }));
    assert.ok(bounds.length > 0, "open picker remains rendered after resize");
    for (const rect of bounds) assert.ok(rect.left >= 0 && rect.top >= 0 && rect.right <= viewport.width && rect.bottom <= viewport.height, `menu must remain in ${viewport.width}x${viewport.height}: ${JSON.stringify(rect)}`);
    if (viewport.width === 460) await page.screenshot({ path: resolve(reviewDir, "short-narrow-window.png") });
  }
  assert.deepEqual(errors, []);
  console.log("PASS model picker: two model rows, two Swift profiles, mode switch, right-side submenu, keyboard navigation and viewport-safe resizing; mocked IPC only");
} finally { await browser?.close(); await server.close(); }
