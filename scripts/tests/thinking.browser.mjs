// Exercises the real Thinking component in pinned Chromium without starting the app/model.
// Run: node scripts/tests/thinking.browser.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createServer } from "vite";

const root = resolve(import.meta.dirname, "../..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, "vendor/browsers");
const { chromium } = createRequire(resolve(root, "vendor/playwright/package.json"))("playwright-core");
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, clearScreen: false });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(`${server.resolvedUrls.local[0]}scripts/tests/thinking-fixture.html`);
  const panel = page.getByRole("region", { name: "Assistant thinking" });
  const atBottom = () => panel.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 2);
  await panel.waitFor();
  assert.equal(await panel.evaluate(el => el.scrollHeight > el.clientHeight), true, "fixture must overflow");
  assert.equal(await atBottom(), true, "initial thinking should start at the bottom");

  await page.locator("#append").click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Assistant thinking"]')?.textContent?.includes("Appended line"));
  assert.equal(await atBottom(), true, "appending while following should stay at the bottom");

  await panel.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  const pausedAt = await panel.evaluate(el => el.scrollTop);
  await page.locator("#append").click();
  await page.waitForFunction(() => (document.querySelector('[aria-label="Assistant thinking"]')?.textContent?.match(/Appended line/g)?.length ?? 0) === 2);
  assert.equal(await panel.evaluate(el => el.scrollTop), pausedAt, "appending after scrolling up should preserve position");

  await panel.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll")); });
  await page.locator("#append").click();
  await page.waitForFunction(() => (document.querySelector('[aria-label="Assistant thinking"]')?.textContent?.match(/Appended line/g)?.length ?? 0) === 3);
  assert.equal(await atBottom(), true, "returning to the bottom should resume following");

  // The app conditionally renders the component only while a thinking block exists.
  // Removing and restoring it must restore its default follow behavior.
  await panel.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  await page.locator("#toggle").click();
  await page.getByRole("region", { name: "Assistant thinking" }).waitFor({ state: "detached" });
  await page.locator("#toggle").click();
  await page.getByRole("region", { name: "Assistant thinking" }).waitFor();
  await page.locator("#append").click();
  await page.waitForFunction(() => (document.querySelector('[aria-label="Assistant thinking"]')?.textContent?.match(/Appended line/g)?.length ?? 0) === 4);
  assert.equal(await atBottom(), true, "remounting a new block should reset follow behavior");
  assert.deepEqual(errors, []);
  console.log("PASS: initial follow, scroll-up pause, bottom resume and remount reset");
} finally {
  await browser?.close();
  await server.close();
}
