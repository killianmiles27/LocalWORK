// Isolated Tauri + real agent/router integration against a loopback fake cloud. No account or weights.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
const root = resolve(import.meta.dirname, "../..");
const { chromium } = createRequire(resolve(root, "vendor/playwright/node_modules/playwright-core/package.json"))("playwright-core");
const [endpoint, work] = process.argv.slice(2);
const server = createServer(async (req, res) => {
  if (req.url === "/v1/models") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "fixture-cloud" }] })); }
  if (req.url !== "/v1/chat/completions") { res.writeHead(404); return res.end(); }
  let body = ""; for await (const part of req) body += part;
  const request = JSON.parse(body); requests.push(request);
  res.setHeader("Content-Type", "text/event-stream");
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "CLOUD_FIXTURE_OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});
const requests = [];
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0].pages().find(p => p.url().includes("tauri.localhost"));
const invoke = (cmd, args) => page.evaluate(({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
const results = []; let provider; let conv;
async function sendAndExpect(expected) {
  const previous = (await invoke("load_messages", { id: conv, after: 0 })).at(-1)?.id ?? 0;
  await invoke("agent_send", { id: conv, text: "Reply briefly for this isolated routing test." });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const rows = await invoke("load_messages", { id: conv, after: previous });
    if (rows.some(m => m.role === "assistant" && String(m.body?.text).includes(expected))) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`No ${expected} reply: ${JSON.stringify(await invoke("load_messages", { id: conv, after: previous }))}`);
}
try {
  assert.equal((await invoke("cloud_get")).routing, "local");
  provider = await invoke("cloud_provider_save", { provider: { name: "Isolated routing fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [] }, key: null });
  assert.deepEqual(await invoke("cloud_models", { id: provider.id }), ["fixture-cloud"]);
  await invoke("route_mode_set", { mode: "manual" });
  conv = await invoke("create_conversation", { workspace: work });
  await invoke("chat_route_set", { conv, model: `cloud:${provider.id}:fixture-cloud` });
  await invoke("model_stop");
  assert.equal(await invoke("cloud_available", { conv }), true);
  await sendAndExpect("CLOUD_FIXTURE_OK");
  assert.equal(requests.length, 1); assert.equal(requests[0].model, "fixture-cloud");
  assert.equal((await invoke("route_last_sent", { conv })).sent.request.model, "fixture-cloud");
  await invoke("model_start");
  await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke("model_status")).state === "ready", undefined, { timeout: 20000 });
  await invoke("cloud_set", { key: "privacyGate", value: "on" });
  await sendAndExpect("Fixture reply");
  assert.equal(requests.length, 1, "missing privacy helper must keep Manual cloud requests local");
  await assert.rejects(invoke("route_mode_set", { mode: "auto" }));
  await invoke("cloud_set", { key: "privacyGate", value: "off" });
  await invoke("route_mode_set", { mode: "local" });
  await sendAndExpect("Fixture reply");
  assert.equal(requests.length, 1, "Local only must override a saved cloud pin");
  results.push({ Id: "T-R1", Test: "Cloud routing and privacy fallback", Status: "PASS", Detail: "Real agent/proxy against loopback fake provider: fetched models, cloud with local stopped, exact payload viewer, missing-filter local fallback, auto guard and Local-only override" });
} catch (error) { results.push({ Id: "T-R1", Test: "Cloud routing and privacy fallback", Status: "FAIL", Detail: String(error.stack ?? error) }); }
finally {
  await invoke("cloud_set", { key: "privacyGate", value: "off" }).catch(() => {});
  await invoke("route_mode_set", { mode: "local" }).catch(() => {});
  if (conv) await invoke("delete_conversation", { id: conv }).catch(() => {});
  if (provider) await invoke("cloud_provider_remove", { id: provider.id }).catch(() => {});
  await writeFile(resolve(work, "routing-results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results)); await browser.close(); await new Promise(resolve => server.close(resolve));
}
process.exitCode = results.some(r => r.Status === "FAIL") ? 1 : 0;
