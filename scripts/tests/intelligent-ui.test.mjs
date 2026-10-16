import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../..");
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString("base64")}`;
const design = moduleUrl(readFileSync(resolve(root, "src/vendor/open-intelligent-ui/design-system.ts"), "utf8"));
const license = moduleUrl(`export default ${JSON.stringify(readFileSync(resolve(root, "src/vendor/open-intelligent-ui/LICENSE"), "utf8"))};`);
const code = readFileSync(resolve(root, "src/intelligent-ui.ts"), "utf8").replace('"./vendor/open-intelligent-ui/design-system"', JSON.stringify(design)).replace('"./vendor/open-intelligent-ui/LICENSE?raw"', JSON.stringify(license));
const { assembleDocument, frameMessage } = await import(moduleUrl(code));

test("upstream design system is bundled with offline assembly", () => {
  const html = assembleDocument('<button id="go">Calculate</button>');
  assert.ok(html.includes("--color-background-primary"));
  assert.ok(html.includes("svg .c-teal"));
  assert.ok(html.includes("Copyright (c) Atai Barkai"));
  assert.ok(html.includes('<button id="go">Calculate</button>'));
  assert.ok(html.includes("connect-src 'none'"));
  assert.ok(!/https?:\/\//.test(html));
});

test("bridge rejects malformed requests and bounds prompts/heights", () => {
  for (const value of [null, "text", { type: "send-prompt", text: " " }, { type: "send-prompt", text: "x".repeat(4001) }, { type: "open-link", url: "file:///secret" }, { type: "widget-resize", height: Infinity }])
    assert.equal(frameMessage(value), null);
  assert.deepEqual(frameMessage({ type: "send-prompt", text: "  Compare the options  " }), { text: "Compare the options" });
  assert.deepEqual(frameMessage({ type: "widget-resize", height: 1000000 }), { height: 800 });
});

test("sandbox runs controls but blocks host access, remote fetch and frame navigation", async t => {
  const playwrightPath = resolve(root, "vendor/playwright/node_modules/playwright-core/package.json");
  const browsers = resolve(root, "vendor/browsers");
  if (!existsSync(playwrightPath) || !existsSync(browsers)) return t.skip("Fetch pinned browser vendor files first");
  const version = readdirSync(browsers).find(n => n.startsWith("chromium_headless_shell-"));
  const executablePath = resolve(browsers, version ?? "missing", "chrome-headless-shell-win64/chrome-headless-shell.exe");
  if (!existsSync(executablePath)) return t.skip("Pinned Windows headless browser not available");
  const { chromium } = createRequire(playwrightPath)("playwright-core");
  const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
  assert.deepEqual(config.app.security.dangerousDisableAssetCspModification, ["script-src", "style-src"]);
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    let outbound = 0;
    await page.route("https://example.invalid/**", route => { outbound++; return route.abort(); });
    await page.setContent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${config.app.security.csp}"><title>Isolated sandbox fixture</title>`);
    await page.evaluate(html => {
      window.received = [];
      addEventListener("message", e => { if (e.data.type === "send-prompt") window.received.push(e.data.text); });
      const frame = document.createElement("iframe");
      frame.sandbox = "allow-scripts";
      frame.srcdoc = html;
      document.body.append(frame);
    }, assembleDocument(`<button id="count" onclick="this.textContent=Number(this.textContent)+1">0</button>
      <button id="follow" onclick="sendPrompt('Use these assumptions')">Follow up</button>
      <script>
        try { parent.document.body.dataset.leaked = 'true'; } catch(e) { document.body.dataset.isolated='true'; }
        fetch('https://example.invalid/fetch').catch(()=>{});
      </script>`));
    const frame = page.frameLocator("iframe");
    await frame.locator("#count").click();
    assert.equal(await frame.locator("#count").textContent(), "1");
    assert.equal(await frame.locator("body").getAttribute("data-isolated"), "true");
    await frame.locator("#follow").click();
    await page.waitForFunction(() => window.received.length === 1);
    assert.deepEqual(await page.evaluate(() => window.received), ["Use these assumptions"]);
    assert.equal(await page.locator("body").getAttribute("data-leaked"), null);
    // CSP on the parent, unlike connect-src in the child, also blocks self-navigation.
    await frame.locator("body").evaluate(() => { location.href = "https://example.invalid/navigation"; });
    await page.waitForTimeout(250);
    assert.equal(outbound, 0);
  } finally {
    await browser.close();
  }
});
