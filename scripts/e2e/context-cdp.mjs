import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

const root = resolve(import.meta.dirname, "../..");
const { chromium } = createRequire(resolve(root, "vendor/playwright/node_modules/playwright-core/package.json"))("playwright-core");
const [endpoint, work] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0].pages().find(p => p.url().includes("tauri.localhost"));
const results = [];
const invoke = (cmd, args) => page.evaluate(({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
async function check(id, name, body) {
  try { await body(); results.push({ Id: id, Test: name, Status: "PASS", Detail: "Actual WebView2 context UI using synthetic agent events; no model reasoning claim" }); }
  catch (error) { results.push({ Id: id, Test: name, Status: "FAIL", Detail: String(error.stack ?? error) }); }
  console.log(`${results.at(-1).Status}: ${name}`);
}
await check("T-C1", "Context unknown, percentage, and post-compaction refresh", async () => {
  await invoke("set_setting", { key: "wizard_done", value: "1" });
  const id = await invoke("create_conversation", { workspace: work });
  await page.reload();
  await page.getByTitle(work, { exact: true }).click();
  const ring = page.getByTestId("context-ring");
  await ring.waitFor();
  assert.match(await ring.getAttribute("aria-label"), /unavailable/);
  await ring.click();
  await page.getByText("Not measured yet", { exact: true }).waitFor();
  const emit = ev => invoke("plugin:event|emit", { event: "agent-event", payload: { conv: id, ev } });
  await emit({ type: "context_usage", used: 8192, window: 32768 });
  await page.waitForFunction(() => document.querySelector('[data-testid="context-ring"]').getAttribute("aria-label").includes("25 percent"));
  assert.match(await page.getByTestId("context-popover").textContent(), /25%/);
  await emit({ type: "text_delta", text: "Working" });
  await emit({ type: "context_usage", used: 4096, window: 32768 });
  await page.waitForFunction(() => document.querySelector('[data-testid="context-ring"]').getAttribute("aria-label").includes("13 percent"));
  await page.getByText("Live: the size of the request the model is reading now.", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Compact now", exact: true }).isDisabled(), true);
  await emit({ type: "stream_end", msg_id: "fixture-finished", usage: { input_tokens: 0, output_tokens: 0 } });
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "Compact now")?.disabled);
  await page.screenshot({ path: resolve(work, "context-ring.png"), animations: "disabled" });
  await invoke("delete_conversation", { id });
});
await writeFile(resolve(work, "context-results.json"), JSON.stringify(results, null, 2));
await browser.close();
process.exitCode = results.some(r => r.Status === "FAIL") ? 1 : 0;
