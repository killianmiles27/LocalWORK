import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const root = resolve(import.meta.dirname, "../..");
const { chromium } = createRequire(resolve(root, "vendor/playwright/node_modules/playwright-core/package.json"))("playwright-core");
const [endpoint, work, workspace] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0].pages().find(p => p.url().includes("tauri.localhost"));
if (!page) throw Error("LocalWORK WebView2 page not found");
const results = [];
const invoke = (cmd, args) => page.evaluate(({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
const panel = page.getByRole("complementary", { name: "Document and visual workspace" });
const selectFile = async path => {
  await panel.locator("#workspace-file").selectOption(`file:${path}`);
  await panel.getByText("Preparing preview…", { exact: true }).waitFor({ state: "hidden", timeout: 50000 });
};
async function check(id, name, body) {
  try { await body(); results.push({ Id: id, Test: name, Status: "PASS", Detail: "Actual WebView2 UI and native commands" }); }
  catch (error) { results.push({ Id: id, Test: name, Status: "FAIL", Detail: String(error.stack ?? error) }); }
  console.log(`${results.at(-1).Status}: ${name}`);
  if (results.at(-1).Status === "FAIL") console.error(results.at(-1).Detail);
}
await page.getByText("Automation: workspace", { exact: true }).click();
await page.getByRole("button", { name: "Files & visuals", exact: true }).click();
await panel.waitFor();

await check("T-W1", "Markdown and previous-revision preview", async () => {
  await selectFile("memo.md");
  await panel.locator("article").getByRole("heading", { name: "Current memo" }).waitFor();
  const choices = panel.getByRole("combobox", { name: "Document revision" });
  await choices.locator("option").nth(1).waitFor({ state: "attached" });
  await choices.selectOption("0123456789abcdef0123456789abcdef");
  await panel.locator("article").getByRole("heading", { name: "Previous memo" }).waitFor();
});
await check("T-W2", "Word, Excel and PowerPoint render inside the actual app", async () => {
  for (const [path, text] of [["fixture.docx", "Automation Word memo"], ["fixture.xlsx", "Automation spreadsheet"], ["fixture.pptx", "Automation slide deck"]]) {
    await selectFile(path);
    const preview = panel.frameLocator("iframe");
    await preview.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor({ timeout: 50000 });
    await page.screenshot({ path: resolve(work, `${path}.png`), animations: "disabled" });
  }
});
await check("T-W3", "Recovery/export copies preserve originals and refuse overwrites", async () => {
  const before = await invoke("document_preview", { id: "workspace-fixture", path: "memo.md", revision: null });
  const destination = resolve(workspace, "recovered.md");
  await invoke("document_export", { id: "workspace-fixture", path: "memo.md", destination, revision: "0123456789abcdef0123456789abcdef" });
  assert.match(await readFile(destination, "utf8"), /Previous memo/);
  const after = await invoke("document_preview", { id: "workspace-fixture", path: "memo.md", revision: null });
  assert.equal(before.content, after.content);
  await assert.rejects(() => invoke("document_export", { id: "workspace-fixture", path: "memo.md", destination, revision: null }));
  await assert.rejects(() => invoke("document_preview", { id: "workspace-fixture", path: "../../outside.md", revision: null }));
});
await check("T-W4", "Open Intelligent UI controls, explicit follow-up and HTML export", async () => {
  await panel.locator("#workspace-file").selectOption({ label: "Interactive fixture" });
  const widget = panel.frameLocator("iframe");
  const contrast = await widget.locator("h2").evaluate(el => {
    const luminance = color => {
      const values = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(c => c / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    const foreground = luminance(getComputedStyle(el).color);
    const background = luminance(getComputedStyle(document.body).backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  assert.ok(contrast >= 4.5, `Expanded visual must remain readable (contrast ${contrast})`);
  await widget.getByRole("button", { name: "Add one", exact: true }).click();
  assert.equal(await widget.locator("#count").textContent(), "2");
  const composer = page.locator("textarea").first();
  assert.equal(await composer.inputValue(), "");
  const before = await invoke("load_messages", { id: "workspace-fixture" });
  await widget.getByRole("button", { name: "Suggest follow-up", exact: true }).click();
  await panel.getByText("Suggested follow-up", { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), "");
  await panel.getByRole("button", { name: "Add to my message", exact: true }).click();
  assert.equal(await composer.inputValue(), "Compare these assumptions");
  assert.equal((await invoke("load_messages", { id: "workspace-fixture" })).length, before.length);
  const html = await panel.locator("iframe").getAttribute("srcdoc");
  const destination = resolve(workspace, "visual-copy.html");
  await invoke("document_save_visual", { destination, html });
  assert.match(await readFile(destination, "utf8"), /Copyright \(c\) Atai Barkai/);
  await page.screenshot({ path: resolve(work, "interactive-workspace.png"), animations: "disabled" });
});
await check("T-W5", "Ask for changes fills the composer without sending", async () => {
  await selectFile("memo.md");
  const before = await invoke("load_messages", { id: "workspace-fixture" });
  await panel.getByRole("button", { name: "Ask for changes", exact: true }).click();
  assert.match(await page.locator("textarea").first().inputValue(), /Revise the current file "memo\.md"/);
  assert.equal((await invoke("load_messages", { id: "workspace-fixture" })).length, before.length);
});
// Tauri intentionally makes invoke immutable. Intercept its documented fetch IPC
// transport in the test page, preserving all non-intercepted native commands.
async function installBoundary() {
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    const nativeInvoke = window.__TAURI_INTERNALS__.invoke;
    let bypass = false;
    window.__testOriginalInvoke = (cmd, args, options) => {
      bypass = true;
      try { return nativeInvoke(cmd, args, options); } finally { bypass = false; }
    };
    window.__testMockInvoke = handler => {
      window.fetch = (url, options) => {
        if (!bypass && typeof url === "string" && url.startsWith("http://ipc.localhost/")) {
          const cmd = decodeURIComponent(new URL(url).pathname.slice(1));
          const args = JSON.parse(options.body || "{}");
          return Promise.resolve().then(() => handler(cmd, args)).then(
            value => new Response(JSON.stringify(value ?? null), { headers: { "Content-Type": "application/json", "Tauri-Response": "ok" } }),
            error => new Response(JSON.stringify(String(error)), { headers: { "Content-Type": "application/json", "Tauri-Response": "error" } }));
        }
        return originalFetch.call(window, url, options);
      };
    };
    window.__testRestoreInvoke = () => { window.fetch = originalFetch; };
  });
}
await check("T-D1", "External links use the OS command and leave the app in place", async () => {
  await installBoundary();
  const before = page.url();
  await page.evaluate(() => {
    window.__testLinks = [];
    window.__testMockInvoke((cmd, args, ...rest) => {
      if (cmd === "open_external") { window.__testLinks.push(args.url); return Promise.resolve(); }
      return window.__testOriginalInvoke(cmd, args, ...rest);
    });
  });
  try {
    await page.getByRole("link", { name: "External link", exact: true }).click();
    await page.waitForFunction(() => window.__testLinks.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__testLinks), ["https://example.com/localwork-check"]);
    assert.equal(page.url(), before);
  } finally { await page.evaluate(() => { window.__testRestoreInvoke(); }); }
  await assert.rejects(() => invoke("open_external", { url: "file:///C:/Windows/System32/cmd.exe" }));
});
await check("T-D2", "TPS is visible, configurable and persists across reload", async () => {
  await page.getByTestId("composer-tps").getByText("23.5 tok/s").waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("checkbox", { name: "Show tokens per second in composer" });
  await toggle.uncheck();
  await page.waitForFunction(() => !document.querySelector('[data-testid="composer-tps"]'));
  assert.equal(await invoke("get_setting", { key: "show_tps" }), "0");
  await page.reload();
  await page.getByRole("heading", { name: "What should we work on?" }).waitFor();
  assert.equal(await page.getByTestId("composer-tps").count(), 0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await toggle.check();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTestId("composer-tps").getByText("23.5 tok/s").waitFor({ timeout: 20000 });
});
await check("T-D3", "New chats create isolated output folders without a dialog", async () => {
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("heading", { name: "What should we work on?" }).waitFor();
  const before = await invoke("list_conversations");
  await installBoundary();
  await page.evaluate(() => {
    window.__testSends = [];
    window.__testMockInvoke((cmd, args, ...rest) => {
      if (cmd.startsWith("plugin:dialog")) throw Error("Unexpected folder dialog");
      if (cmd === "agent_send") { window.__testSends.push(args); return Promise.reject("Test stops before model inference"); }
      return window.__testOriginalInvoke(cmd, args, ...rest);
    });
  });
  try {
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Create a budget");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("Test stops before model inference", { exact: true }).waitFor();
    const after = await invoke("list_conversations");
    const fresh = after.filter(c => !before.some(old => old.id === c.id));
    assert.equal(fresh.length, 1);
    assert.equal(resolve(fresh[0].workspace), resolve(workspace, "chats", fresh[0].id));
    assert.deepEqual(await page.evaluate(() => window.__testSends.map(s => [s.id, s.text])), [[fresh[0].id, "Create a budget"]]);
    const second = await invoke("create_conversation", {});
    const all = await invoke("list_conversations");
    assert.notEqual(all.find(c => c.id === second).workspace, fresh[0].workspace);
    await invoke("attach_bytes", { id: fresh[0].id, name: "saved.md", data: [...Buffer.from("# Saved output")] });
    assert.match(await readFile(resolve(fresh[0].workspace, "attachments", "saved.md"), "utf8"), /Saved output/);
    await page.screenshot({ path: resolve(work, "new-chat.png"), animations: "disabled" });
  } finally { await page.evaluate(() => { window.__testRestoreInvoke(); }); }
});
await check("T-D4", "Integrated window and optional folder picker", async () => {
  assert.equal(await invoke("plugin:window|is_decorated", { label: "main" }), false);
  await page.getByRole("button", { name: "Maximize or restore", exact: true }).click();
  await page.getByRole("button", { name: "Maximize or restore", exact: true }).click();
  await installBoundary();
  await page.evaluate(folder => {
    window.__testMockInvoke((cmd, args, ...rest) => cmd === "plugin:dialog|open" ? Promise.resolve(folder) : window.__testOriginalInvoke(cmd, args, ...rest));
  }, workspace);
  try {
    await page.getByRole("button", { name: "Start a chat in a folder", exact: true }).click();
    await page.getByRole("button", { name: workspace.split(/[\\/]/).at(-1), exact: true }).waitFor();
    const all = await invoke("list_conversations");
    assert.ok(all.filter(c => resolve(c.workspace) === resolve(workspace)).length >= 2);
  } finally { await page.evaluate(() => { window.__testRestoreInvoke(); }); }
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.screenshot({ path: resolve(work, "home.png"), animations: "disabled" });
});
await check("T-D5", "Late chat creation and attachments cannot override navigation", async () => {
  for (const delayed of ["create_conversation", "attach_bytes"]) {
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await installBoundary();
    await page.evaluate(command => {
      window.__delayReady = false; window.__delayDone = false;
      window.__testMockInvoke((cmd, args, ...rest) => {
        if (cmd === command) return new Promise((resolve, reject) => {
          window.__delayReady = true;
          window.__releaseDelayed = () => window.__testOriginalInvoke(cmd, args, ...rest).then(value => { window.__delayDone = true; resolve(value); }, error => { window.__delayDone = true; reject(error); });
        });
        return window.__testOriginalInvoke(cmd, args, ...rest);
      });
      const data = new DataTransfer(); data.items.add(new File(["late attachment"], "late-attachment.txt", { type: "text/plain" }));
      document.querySelector("textarea").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    }, delayed);
    try {
      await page.waitForFunction(() => window.__delayReady);
      await page.getByText("Automation: workspace", { exact: true }).click();
      await page.getByRole("link", { name: "External link", exact: true }).waitFor();
      await page.evaluate(() => window.__releaseDelayed());
      await page.waitForFunction(() => window.__delayDone);
      await page.getByRole("link", { name: "External link", exact: true }).waitFor();
      assert.equal(await page.getByText("late-attachment.txt", { exact: true }).count(), 0);
      assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "");
    } finally { await page.evaluate(() => { window.__testRestoreInvoke(); }); }
  }
});
await check("T-D6", "Model start and stop remain available in Settings", async () => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Stop model", exact: true }).click();
  await page.getByRole("button", { name: "Start model", exact: true }).waitFor();
  await page.getByRole("button", { name: "Start model", exact: true }).click();
  await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke("model_status")).state === "ready", null, { timeout: 20000 });
  await page.getByRole("button", { name: "Close", exact: true }).click();
});
await writeFile(resolve(work, "workspace-results.json"), JSON.stringify(results, null, 2));
// Disconnect only. The PowerShell harness owns application lifecycle and cleanup.
await browser.close();
process.exitCode = results.some(r => r.Status === "FAIL") ? 1 : 0;
