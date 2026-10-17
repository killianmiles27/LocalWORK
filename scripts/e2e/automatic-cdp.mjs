import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

const root = resolve(import.meta.dirname, "../..");
const { chromium } = createRequire(resolve(root, "vendor/playwright/node_modules/playwright-core/package.json"))("playwright-core");
const [endpoint, work] = process.argv.slice(2);
if (!endpoint || !work) throw new Error("Usage: node scripts/e2e/automatic-cdp.mjs <WebView2-CDP-endpoint> <work-directory>");
const report = resolve(work, "automatic-results.json");

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0].pages().find(p => p.url().includes("tauri.localhost"));
if (!page) throw Error("LocalWORK WebView2 page not found");
const results = [];
const invoke = (cmd, args) => page.evaluate(({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
async function check(id, name, body) {
  try { await body(); results.push({ Id: id, Test: name, Status: "PASS", Detail: "Verified through the LocalWORK WebView2 UI and Tauri settings" }); }
  catch (error) { results.push({ Id: id, Test: name, Status: "FAIL", Detail: String(error.stack ?? error) }); }
  console.log(`${results.at(-1).Status}: ${name}`);
  if (results.at(-1).Status === "FAIL") console.error(results.at(-1).Detail);
}
const modeButton = () => page.getByRole("button", { name: /^Automatic mode (on|off)$/ });

await check("T-A1", "Automatic mode persists, applies to new chats, and survives reload", async () => {
  await invoke("set_setting", { key: "wizard_done", value: "1" });
  await page.reload();
  await page.getByRole("heading", { name: "What should we work on?" }).waitFor();
  if (await invoke("get_setting", { key: "auto_edit" }) === null) {
    assert.equal(await modeButton().getAttribute("aria-label"), "Automatic mode on", "a fresh profile defaults to Automatic mode");
  }
  // Start on, then verify each toggle in both directions survives a reload.
  if (await modeButton().getAttribute("aria-label") === "Automatic mode off") await modeButton().click();
  await page.waitForFunction(async () => await window.__TAURI_INTERNALS__.invoke("get_setting", { key: "auto_edit" }) === "1");
  await modeButton().click();
  await page.waitForFunction(async () => await window.__TAURI_INTERNALS__.invoke("get_setting", { key: "auto_edit" }) === "0");
  await page.reload();
  await page.getByRole("heading", { name: "What should we work on?" }).waitFor();
  assert.equal(await modeButton().getAttribute("aria-label"), "Automatic mode off");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  assert.equal(await modeButton().getAttribute("aria-label"), "Automatic mode off");
  await modeButton().click();
  await page.waitForFunction(async () => await window.__TAURI_INTERNALS__.invoke("get_setting", { key: "auto_edit" }) === "1");
  await page.reload();
  await page.getByRole("heading", { name: "What should we work on?" }).waitFor();
  assert.equal(await modeButton().getAttribute("aria-label"), "Automatic mode on");
  assert.equal(await invoke("get_setting", { key: "auto_edit" }), "1");
});

await writeFile(report, JSON.stringify(results, null, 2));
await browser.close();
process.exitCode = results.some(r => r.Status === "FAIL") ? 1 : 0;
