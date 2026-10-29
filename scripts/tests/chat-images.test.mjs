// Chat images: a reply must not touch the internet on its own. These tests run the real image gate and the real
// placeholder component out of src/Md.tsx, then check the CSP that backs them up.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../..");
const source = readFileSync(resolve(root, "src/Md.tsx"), "utf8");

// Take the image gate and the placeholder component straight out of the renderer: they are plain TSX with no
// imports of their own, so they run as a module once React's hooks and the icon are supplied.
const wanted = new Set(["LOCAL_SCHEMES", "LOCAL_HOSTS", "holdImage", "HeldImageView"]);
const picked = ts.createSourceFile("Md.tsx", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX).statements
  .filter(s => wanted.has(s.name?.text) || (s.declarationList?.declarations ?? []).some(d => wanted.has(d.name.text)))
  .map(s => s.getText());
assert.deepEqual(picked.length, 4, "Md.tsx still declares the image gate and its placeholder");

// Each load gets its own module instance, so the hook can be React's real one or a stub the test can drive.
let loads = 0;
async function loadImageModule(hooks) {
  const nonce = ++loads;
  const code = `const { createElement, useState, ImageOff } = globalThis.__mdImageDeps[${nonce}];\n${picked.join("\n")}\nexport { holdImage, HeldImageView };\n`;
  (globalThis.__mdImageDeps ??= {})[nonce] = hooks;
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: "createElement" } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}
const { holdImage, HeldImageView } = await loadImageModule({ createElement, useState, ImageOff: () => null });
const render = props => renderToStaticMarkup(createElement(HeldImageView, { alt: "", offline: false, ...props }));

test("a remote image is described by its host and never by its path or query", () => {
  const leak = "https://tracker.example/pixel.png?reply=" + encodeURIComponent("quarterly numbers");
  assert.deepEqual(holdImage(leak, false), { host: "tracker.example", action: "load" });
  assert.deepEqual(holdImage(leak, true), { host: "tracker.example", action: "offline" });
  assert.equal(JSON.stringify(holdImage(leak, false)).includes("numbers"), false);
  // Ports stay, so a look-alike service is not hidden behind the bare host.
  assert.equal(holdImage("https://example.com:8443/a.png", false).host, "example.com:8443");
  // A protocol-relative source is remote, and so is the backslash spelling browsers read as slashes.
  assert.equal(holdImage("//cdn.example/a.png", false).host, "cdn.example");
  assert.equal(holdImage("\\\\cdn.example\\a.png", false).host, "cdn.example");
  // Anything that is not a URL at all is still held, with something readable to show.
  assert.deepEqual(holdImage("file:///etc/passwd", false), { host: "an address that cannot be read", action: "load" });
  assert.equal(holdImage("javascript:alert(1)", false).action, "load");
});

test("images the app serves itself keep loading", () => {
  for (const src of [
    "blob:http://localhost/2f2f0e1c", // BrowserLive screenshots
    "data:image/png;base64,iVBORw0KGgo=", // inline previews and the UI runtime
    "asset://localhost/home/me/shot.png", // Tauri asset protocol
    "http://asset.localhost/home/me/shot.png",
    "tauri://localhost/icon.png",
    "ipc://localhost/icon.png",
    "img/logo.png", // a path in the app bundle
    "/logo.png",
    "",
    undefined,
  ]) assert.equal(holdImage(src, false), null, `expected ${String(src)} to load directly`);
});

test("the placeholder shows the host, the alt text and a Load image button", () => {
  const html = render({ src: "https://tracker.example/pixel.png?reply=secret", alt: "Revenue chart" });
  assert.match(html, /tracker\.example/);
  assert.match(html, /Revenue chart/);
  assert.match(html, /Load image/);
  assert.doesNotMatch(html, /<img/, "nothing may be requested before the click");
  assert.doesNotMatch(html, /pixel\.png|reply=secret/);
});

test("offline chats offer no way to fetch a remote image", () => {
  const html = render({ src: "https://tracker.example/pixel.png", alt: "Chart", offline: true });
  assert.match(html, /tracker\.example/);
  assert.doesNotMatch(html, /Load image/);
  assert.match(html, /Offline/);
  assert.doesNotMatch(html, /<img/);
});

test("local images and approved remote images render as plain images without a referrer", () => {
  const shot = render({ src: "blob:http://localhost/2f2f0e1c", alt: "Browser: example" });
  assert.match(shot, /<img src="blob:http:\/\/localhost\/2f2f0e1c"/);
  assert.match(shot, /referrerpolicy="no-referrer"/i);
  assert.doesNotMatch(shot, /Load image/);
});

test("approving one image does not approve whatever URL arrives next in the same message", async () => {
  const state = { value: null };
  const stub = await loadImageModule({ createElement, useState: () => [state.value, v => { state.value = v; }], ImageOff: () => null });
  const button = node => {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) return node.map(button).find(Boolean) ?? null;
    if (node.type === "button") return node;
    return button(node.props?.children);
  };
  const view = src => stub.HeldImageView({ src, alt: "Chart", offline: false });
  const first = view("https://example.com/1.png");
  assert.equal(first.type, "span", "a held image is a placeholder, not an img");
  button(first).props.onClick();
  assert.equal(state.value, "https://example.com/1.png");
  assert.equal(view("https://example.com/1.png").type, "img", "the approved URL loads");
  // Streaming replaces the message body in place, so the approval must be bound to the URL and not to the position.
  assert.equal(view("https://tracker.example/2.png?reply=secret").type, "span");
});

test("the chat renderer holds images and passes offline mode down to it", () => {
  const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");
  assert.match(app, /<Md embeds images=\{\{ offline \}\}>/);
  assert.match(app, /<Assistant offline=\{offline\.global \|\| offline\.chat\}>/);
  assert.match(app, /offline=\{offline\.global \|\| offline\.chat\}/);
  // The document pane keeps its own text-only image rule, so it must win over the chat one.
  assert.match(readFileSync(resolve(root, "src/Workspace.tsx"), "utf8"), /components=\{\{ img: \(/);
});

test("the app CSP allows local images and state IPC, and nothing else remote", () => {
  const conf = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
  const csp = conf.app.security.csp;
  const directives = Object.fromEntries(csp.split(";").map(d => d.trim()).filter(Boolean)
    .map(d => { const [name, ...values] = d.split(/\s+/); return [name, values]; }));
  assert.deepEqual(directives["img-src"].sort(), ["'self'", "asset:", "blob:", "data:", "http://asset.localhost"].sort());
  for (const source of ["ipc:", "http://ipc.localhost", "ws://localhost:1420", "http://localhost:1420"]) {
    assert.ok(directives["connect-src"].includes(source), `connect-src needs ${source}`);
  }
  for (const remote of ["*", "https:", "http:", "//*"]) {
    assert.equal(directives["img-src"].includes(remote), false, `img-src must not allow ${remote}`);
    assert.equal(directives["connect-src"].includes(remote), false, `connect-src must not allow ${remote}`);
  }
  // The embeds and the sandboxed document frames keep the rules they already had.
  assert.deepEqual(directives["frame-src"], ["'self'", "about:", "blob:", "data:", "https://www.youtube-nocookie.com", "https://www.openstreetmap.org"]);
  assert.deepEqual(directives["object-src"], ["'none'"]);
  assert.deepEqual(directives["base-uri"], ["'self'"]);
});
