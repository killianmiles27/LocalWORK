// Renders the real PlanDock in pinned Chromium without starting the app or model.
// Run: node scripts/tests/plan.browser.mjs
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
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(`${server.resolvedUrls.local[0]}scripts/tests/plan-fixture.html`);
  const plan = page.getByRole("region", { name: "Plan" });
  await plan.waitFor();

  await page.getByText("Plan paused", { exact: true }).waitFor();
  await page.getByText("The run stopped before every step was marked complete.", { exact: true }).waitFor();
  assert.equal(await plan.locator(".animate-spin").count(), 0, "idle unfinished plan must not show a spinning step");

  await page.getByRole("button", { name: "Busy", exact: true }).click();
  await page.locator(".animate-spin").waitFor();
  await page.getByText("Plan paused", { exact: true }).waitFor({ state: "detached" });
  await page.getByText("The run stopped before every step was marked complete.", { exact: true }).waitFor({ state: "detached" });

  await page.getByRole("button", { name: "New turn", exact: true }).click();
  await page.getByText("Plan paused", { exact: true }).waitFor();
  await page.getByText("The run stopped before every step was marked complete.", { exact: true }).waitFor();
  assert.equal(await plan.locator(".animate-spin").count(), 0, "a newer user turn must not make an old plan appear active");

  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByText("Plan complete", { exact: true }).waitFor();
  assert.equal(await plan.locator(".animate-spin").count(), 0, "completed plan must not spin");
  assert.deepEqual(errors, []);
  console.log("PASS: idle and older unfinished plans are paused, active plans spin, and fully marked plans complete");
} finally {
  await browser?.close();
  await server.close();
}
