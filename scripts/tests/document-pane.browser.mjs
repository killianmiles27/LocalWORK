// Real React/iframe interactions with a synthetic IPC boundary; no model or user files.
// Run: node scripts/tests/document-pane.browser.mjs (requires bundled Chromium).
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
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.addInitScript(() => {
    let callbackId = 0;
    const callbacks = {}, events = {};
    window.fixture = { sends: [], saves: [], content: "Participants: 24", failSend: false };
    window.emitFixture = (event, payload) => (events[event] ?? []).forEach(id => callbacks[id]?.({ event, payload }));
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback(fn) { callbacks[++callbackId] = fn; return callbackId; },
      unregisterCallback(id) { delete callbacks[id]; },
      async invoke(cmd, args = {}) {
        if (cmd === "plugin:event|listen") { (events[args.event] ??= []).push(args.handler); return args.handler; }
        if (cmd === "plugin:event|unlisten") return;
        if (cmd === "list_conversations") return ["a", "b"].map(id => ({ id, title: `Project ${id}`, workspace: `/fixture/${id}`, updated: Date.now(), pinned: false }));
        if (cmd === "get_setting") return args.key === "wizard_done" ? "1" : null;
        if (cmd === "model_status") return { state: "ready", port: 1, model: "fixture", detail: "" };
        if (cmd === "modes_list") return { modes: [], effort: { options: [] } };
        if (cmd === "status_items" || cmd === "load_messages") return [];
        if (cmd === "document_revisions") return [{ id: "0123456789abcdef0123456789abcdef", created: 1, size: 100 }];
        if (cmd === "model_telemetry") return {};
        if (cmd === "context_usage") return { used: 0, window: 32768 };
        if (cmd === "chat_offline_get") return { chat: false, global: false };
        if (cmd === "documents_list") return [{ path: "brief.docx", kind: "docx", name: "brief.docx", size: 100, modified: 1 }];
        if (cmd === "document_preview") return { path: "brief.docx", kind: "docx", format: "html", content: `<p data-path="/body/p[1]">${window.fixture.content}</p>` };
        if (cmd === "document_office_edit") { window.fixture.saves.push(args); window.fixture.content = args.after; return; }
        if (cmd === "agent_send") { window.fixture.sends.push(args); if (window.fixture.failSend) throw Error("Fixture model unavailable"); return; }
        if (cmd.startsWith("plugin:")) return;
        return null;
      }
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByText("Project a", { exact: true }).click();
  await page.getByRole("button", { name: "Files & visuals", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Document and visual workspace" });
  const frame = panel.frameLocator("iframe");
  const field = frame.locator('[data-path="/body/p[1]"]');
  await field.waitFor();
  assert.equal(await field.getAttribute("contenteditable"), "plaintext-only");
  assert.equal(await panel.getByRole("button", { name: "Edit", exact: true }).count(), 0);
  const revisions = panel.getByRole("combobox", { name: "Document revision" });
  await revisions.selectOption("0123456789abcdef0123456789abcdef");
  await panel.getByText("Earlier version · Save a copy to recover it", { exact: true }).waitFor();
  assert.equal(await field.getAttribute("contenteditable"), null);
  await revisions.selectOption("");
  await page.waitForFunction(() => !document.body.textContent.includes("Earlier version · Save a copy to recover it"));
  await field.waitFor();
  await page.locator("textarea").first().fill("Keep this draft");
  await field.fill("Participants: 26");
  await panel.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.waitForFunction(() => window.fixture.sends.length === 1);
  const sent = await page.evaluate(() => window.fixture.sends[0]);
  assert.equal(sent.id, "a");
  assert.match(sent.text, /Participants: 26/);
  assert.match(sent.text, /automatically update clear dependencies/);
  assert.equal(await page.locator("textarea").first().inputValue(), "Keep this draft");
  assert.equal(await frame.locator("body").evaluate(el => el.style.zoom), "1.1");
  await field.press("Control+0");
  await page.waitForFunction(() => document.querySelector('button[aria-label="Reset document zoom"]')?.textContent === "100%");
  await field.evaluate(el => {
    const range = el.ownerDocument.createRange(); range.selectNodeContents(el);
    const selection = el.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await panel.getByRole("dialog", { name: "Comment for the assistant" }).waitFor();
  await page.evaluate(() => window.emitFixture("agent-event", { conv: "a", ev: { type: "stream_end" } }));
  await page.evaluate(() => window.emitFixture("model-status", { state: "stopped", port: 1, model: "fixture", detail: "" }));
  await field.fill("Participants: 27");
  await panel.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.waitForFunction(() => window.fixture.saves.length === 2);
  await page.getByText("Project b", { exact: true }).click();
  await page.evaluate(() => window.emitFixture("model-status", { state: "ready", port: 1, model: "fixture", detail: "" }));
  await page.waitForTimeout(2000);
  assert.equal(await page.evaluate(() => window.fixture.sends.length), 1, "must not send project a edits in project b");
  await page.getByText("Project a", { exact: true }).click();
  await page.waitForFunction(() => window.fixture.sends.length === 2);
  assert.equal(await page.evaluate(() => window.fixture.sends[1].id), "a");
  await page.evaluate(() => {
    window.fixture.failSend = true;
    window.emitFixture("agent-event", { conv: "a", ev: { type: "stream_end" } });
  });
  await field.fill("Participants: 28");
  await panel.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.waitForFunction(() => window.fixture.sends.length === 3);
  await page.waitForTimeout(2200);
  assert.equal(await page.evaluate(() => window.fixture.sends.length), 3, "failed sync must not loop");
  await page.evaluate(() => window.emitFixture("model-status", { state: "stopped", port: 1, model: "fixture", detail: "" }));
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    window.fixture.failSend = false;
    window.emitFixture("model-status", { state: "ready", port: 1, model: "fixture", detail: "" });
  });
  await page.waitForFunction(() => window.fixture.sends.length === 4);
  assert.deepEqual(errors, []);
  console.log("PASS: direct typing, dependency turn, composer preservation, zoom, AI notes, chat isolation and bounded failure recovery");
} finally {
  await browser?.close();
  await server.close();
}
