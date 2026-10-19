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
const runtimeUrl = moduleUrl(readFileSync(resolve(root, "src/ui-runtime.ts"), "utf8"));
const code = readFileSync(resolve(root, "src/intelligent-ui.ts"), "utf8").replace('"./ui-runtime"', JSON.stringify(runtimeUrl)).replace('"./vendor/open-intelligent-ui/design-system"', JSON.stringify(design)).replace('"./vendor/open-intelligent-ui/LICENSE?raw"', JSON.stringify(license));
const { assembleDocument, frameMessage, assembleSpec, specFragment } = await import(moduleUrl(code));
const { UI_RUNTIME_JS } = await import(runtimeUrl);
const loadRuntime = () => new Function(`${UI_RUNTIME_JS}; return LW;`)();

// Minimal DOM: just enough for the runtime's createElement/textContent/addEventListener use.
class Node_ {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.handlers = {}; this.className = ""; this.hidden = false; this.value = ""; this.checked = false; this.parentNode = null; this.style = { setProperty() {} }; this._text = ""; }
  get firstChild() { return this.children[0] ?? null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; }
  insertBefore(c) { return this.appendChild(c); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(t, f) { (this.handlers[t] ??= []).push(f); }
  fire(t) { for (const f of this.handlers[t] ?? []) f({ preventDefault() {} }); }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  all() { return [this, ...this.children.flatMap(c => c.all?.() ?? [])]; }
  select() {}
}
class TextNode_ { constructor(t) { this.data = t; this.parentNode = null; } get textContent() { return this.data; } }
const fakeDoc = () => ({ activeElement: null, body: new Node_("body"), execCommand: () => false,
  createElement: t => new Node_(t), createElementNS: (_, t) => new Node_(t), createTextNode: t => new TextNode_(t) });
const mountSpec = (spec, state) => { const doc = fakeDoc(), root = new Node_("div"), LW = loadRuntime(); LW.mount(spec, state, root, doc); return { LW, root, all: root.all(), text: root.textContent }; };
const byTag = (m, tag) => m.root.all().filter(n => n.tagName === tag.toUpperCase());

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

test("expression evaluator works without eval or Function", () => {
  const LW = loadRuntime();
  const { eval: e, Function: F } = globalThis;
  globalThis.eval = () => { throw new Error("eval used"); };
  globalThis.Function = function () { throw new Error("Function used"); };
  try {
    const v = { a: 3, b: 4, rows: [{ n: "x", q: 2 }, { n: "y", q: 5 }], o: { k: [10, 20] } };
    const ev = s => LW.evaluate(s, v);
    assert.equal(ev("$a*$b+2"), 14);
    assert.equal(ev("($a+$b)*2 % 5"), 4);
    assert.equal(ev("$a>2 && $b<5 ? 'yes' : 'no'"), "yes");
    assert.equal(ev("!($a==3)"), false);
    assert.equal(ev("sum(map($rows,'q'))"), 7);
    assert.equal(ev("max(1,9,4)"), 9);
    assert.equal(ev("avg(1,2,3)"), 2);
    assert.equal(ev("fixed(3.14159,2)"), "3.14");
    assert.equal(ev("$o.k[1]"), 20);
    assert.equal(ev("$rows[0].n"), "x");
    assert.equal(ev("len(filter($rows,'q',5))"), 1);
    assert.equal(ev("join(map(sort($rows,'q','desc'),'n'),'-')"), "y-x");
    assert.equal(ev("clamp(15,0,10)"), 10);
    assert.equal(ev("upper('ab')+lower('CD')"), "ABcd");
    assert.equal(ev("sum(range(5))"), 10);
    assert.equal(ev("round(pmt(0.05/12,360,200000),2)"), 1073.64);
    assert.equal(ev("format(0.256,'percent')"), "25.6%");
    assert.equal(ev("$a/0"), null);
    assert.equal(ev("$missing"), null);
    assert.equal(ev("'a'+1"), "a1");
  } finally { globalThis.eval = e; globalThis.Function = F; }
});

test("expression evaluator rejects prototype access and unknown calls", () => {
  const LW = loadRuntime();
  assert.equal(LW.evaluate("$o.constructor", { o: {} }), null);
  assert.equal(LW.evaluate("$o.__proto__", { o: {} }), null);
  assert.equal(LW.evaluate("$s['constructor']", { s: "x" }), null);
  assert.equal(LW.evaluate("$o.hasOwnProperty", { o: {} }), null);
  assert.throws(() => LW.evaluate("constructor('return 1')()", {}));
  assert.throws(() => LW.evaluate("alert(1)", {}));
  assert.throws(() => LW.evaluate("$a.b(1)", { a: {} }));
  assert.throws(() => LW.evaluate("1 +", {}));
});

test("runtime source has no dynamic code paths and is script-embeddable", () => {
  for (const bad of ["eval(", "new Function", "innerHTML", "outerHTML", "document.write", "</script", "<!--", "import("])
    assert.ok(!UI_RUNTIME_JS.includes(bad), bad);
  const frag = specFragment({ t: "Text", text: "</script><img src=x onerror=alert(1)>" }, { a: "<!--" });
  assert.equal(frag.split("</script").length, 2);
  assert.ok(frag.includes("\\u003c/script"));
});

const loan = { t: "Card", title: "Loan", c: [
  { t: "Slider", bind: "$amt", label: "Amount", min: 1000, max: 500000, step: 1000 },
  { t: "Slider", bind: "$rate", label: "Rate %", min: 1, max: 15, step: 0.1 },
  { t: "Slider", bind: "$yrs", label: "Years", min: 1, max: 40 },
  { t: "Stat", label: "Monthly payment", value: "=format(pmt($rate/1200,$yrs*12,$amt),'currency')" },
  { t: "Button", label: "Reset", action: { reset: ["$amt", "$rate", "$yrs"] } },
  { t: "Button", label: "Ask", action: { toAssistant: "Explain {$amt} at {$rate}%" } },
  { t: "Button", label: "Bump", action: { set: { "$amt": "=$amt+1000" } } },
] };

test("loan calculator renders, reacts to input, resets and routes toAssistant", () => {
  const sent = [];
  globalThis.window = { sendPrompt: t => sent.push(t) };
  try {
    const m = mountSpec(loan, { amt: 200000, rate: 6, yrs: 30 });
    assert.equal(byTag(m, "input").length, 3);
    assert.ok(m.text.includes("1,199.10"), m.text);
    const amt = byTag(m, "input")[0];
    amt.value = "100000"; amt.fire("input");
    assert.ok(m.root.textContent.includes("599.55"), m.root.textContent);
    const [reset, ask, bump] = byTag(m, "button");
    bump.fire("click");
    assert.equal(m.LW.state().amt, 101000);
    reset.fire("click");
    assert.equal(m.LW.state().amt, 200000);
    ask.fire("click");
    assert.deepEqual(sent, ["Explain 200000 at 6%"]);
  } finally { delete globalThis.window; }
});

test("comparison dashboard with tabs, chart, table and bad spec handling", () => {
  const data = [{ m: "Jan", a: 3, b: 5 }, { m: "Feb", a: 4, b: 2 }, { m: "Mar", a: 6, b: 6 }];
  const spec = { t: "Col", c: [
    { t: "Title", text: "Plans" },
    { t: "Grid", cols: 2, c: [{ t: "Stat", label: "A total", value: "=sum(map($d,'a'))", delta: "-2%" }, { t: "Badge", tone: "success", text: "ok" }] },
    { t: "Tabs", items: [
      { label: "Chart", c: [{ t: "Chart", kind: "bar", data: "=$d", x: "m", y: ["a", "b"] }, { t: "Chart", kind: "donut", data: "=$d", x: "m", y: ["a"] }, { t: "Chart", kind: "line", data: "=$d", x: "m", y: ["a"] }] },
      { label: "Table", c: [{ t: "Table", columns: ["m", "a"], rows: "=$d", sortable: true }, { t: "Markdown", text: "**bold** and `code`\n- one\n- two" }] },
    ] },
    { t: "Svg", w: 100, h: 50, c: [{ t: "Rect", x: 1, y: 1, w: 20, h: 10, fill: "javascript:x" }, { t: "Text", x: 5, y: 40, text: "hi" }] },
    "plain string",
    { t: "Nope" },
  ] };
  const m = mountSpec(spec, { d: data });
  assert.ok(byTag(m, "svg").length >= 4);
  assert.ok(m.text.includes("Plans") && m.text.includes("plain string") && m.text.includes("Unknown component: Nope"));
  byTag(m, "button")[1].fire("click");
  assert.equal(byTag(m, "table").length, 1);
  const th = byTag(m, "th")[1];
  th.fire("click"); th.fire("click");
  assert.ok(m.root.textContent.includes("\u25BC"));
  assert.ok(byTag(m, "strong").length === 1 && byTag(m, "li").length === 2);
  assert.ok(byTag(m, "rect").every(r => r.attrs.fill !== "javascript:x"));
  assert.doesNotThrow(() => mountSpec({ t: "Text", text: "=1 +" }, {}));
  assert.ok(mountSpec({ t: "Text", text: "=1 +" }, {}).text.includes("Spec problem"));
});

test("assembleSpec produces a CSP-safe document with the shared bridge", () => {
  const html = assembleSpec("T", { t: "Text", text: "hi" }, {});
  assert.ok(html.includes("--color-background-primary") && html.includes("window.sendPrompt") && html.includes("LW.mount"));
  assert.ok(html.includes("connect-src 'none'"));
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

test("links: only http(s) becomes an anchor, and open-url is validated", () => {
  const m = mountSpec({ t: "Col", c: [
    { t: "Link", href: "https://example.org/a?b=1", text: "Example" },
    { t: "Link", href: "javascript:alert(1)", text: "Bad" },
    { t: "Markdown", text: "See [docs](https://example.com/d) or [x](file:///c:/secret)" },
  ] }, {});
  const anchors = byTag(m, "a");
  assert.deepEqual(anchors.map(a => a.href), ["https://example.org/a?b=1", "https://example.com/d"]);
  assert.match(m.text, /Bad/); assert.match(m.text, /x/);
  assert.deepEqual(frameMessage({ type: "open-url", url: "https://example.org/" }), { url: "https://example.org/" });
  assert.equal(frameMessage({ type: "open-url", url: "javascript:alert(1)" }), null);
  assert.equal(frameMessage({ type: "open-url", url: "file:///c:/x" }), null);
  assert.equal(frameMessage({ type: "open-url", url: "https://e.org/" + "a".repeat(2001) }), null);
});
