import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createElement, Fragment } from "react";
import ts from "typescript";

const transpile = (source, jsx = false) => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: jsx ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.React, jsxFactory: "createElement",
} }).outputText;
const js = transpile(readFileSync(new URL("../../src/documentChanges.ts", import.meta.url), "utf8"));
const { applyDocumentChange, lineDiff, linePreview } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
// Execute the real pane and handlers with controlled hooks/IPC, as in task-templates.test.mjs.
const paneSource = readFileSync(new URL("../../src/DocumentChanges.tsx", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
function paneHarness(kind = "md") {
  const slots = [], calls = [], saved = []; let cursor = 0, effects = [], tree;
  let current = "a\nnew\nb\nlast\n", old = "a\nold\nb\nend\n", refresh = 0, fail = false, pendingWrite;
  const path = `fixture.${kind}`, format = ["docx", "xlsx", "pptx"].includes(kind) ? "html" : kind === "pdf" ? "pdf" : "text";
  const OfficeFrame = () => null, SandboxedUi = () => null, Pdf = () => null;
  const scope = {
    createElement, React: { Fragment }, OfficeFrame, SandboxedUi, lineDiff, linePreview, applyDocumentChange,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(fn) { return fn(); },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((v, j) => !Object.is(v, slots[i][j]))) { slots[i] = deps; effects.push(fn); } },
    async invoke(cmd, args) {
      calls.push([cmd, JSON.parse(JSON.stringify(args))]);
      if (cmd === "document_preview") return { path, kind, format, content: args.revision ? old : current };
      if (pendingWrite) await pendingWrite;
      if (fail) throw Error("Fixture file is locked");
      if (cmd === "document_restore") { current = old; return; }
      if (cmd === "document_save") { assert.equal(args.expected, current); current = args.content; return; }
      throw Error(`Unexpected IPC ${cmd}`);
    },
    exports: {},
  };
  vm.runInNewContext(transpile(paneSource, true), scope);
  function render() {
    cursor = 0;
    tree = scope.exports.default({ id: "chat", path, revision: "selected", refresh, Pdf, onSaved: p => { saved.push(p); refresh++; } });
    for (const fn of effects.splice(0)) fn();
  }
  function nodes(node) {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(n => nodes(n));
    if (typeof node.type === "function" && ![OfficeFrame, SandboxedUi, Pdf].includes(node.type)) return nodes(node.type(node.props));
    return [node, ...nodes(node.props?.children)];
  }
  const text = n => typeof n === "string" ? n : typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(text).join("")
    : n?.type && typeof n.type === "function" && ![OfficeFrame, SandboxedUi, Pdf].includes(n.type) ? text(n.type(n.props)) : text(n?.props?.children ?? "");
  function find(type, name) { const node = nodes(tree).find(n => n.type === type && (n.props["aria-label"] === name || text(n) === name)); assert.ok(node, `${type}: ${name}`); return node; }
  async function settle() { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } }
  return { render, settle, nodes: () => nodes(tree), text: () => text(tree), find, calls, saved, OfficeFrame, SandboxedUi, Pdf,
    fail: value => { fail = value; }, current: () => current, pending: promise => { pendingWrite = promise; } };
}

test("pane loads current and selected previews, undoes one hunk and reloads after the saved callback", async () => {
  const h = paneHarness(); h.render(); await h.settle();
  assert.deepEqual(h.calls, [
    ["document_preview", { id: "chat", path: "fixture.md", revision: null }],
    ["document_preview", { id: "chat", path: "fixture.md", revision: "selected" }],
  ]);
  assert.equal(h.nodes().filter(n => n.type === h.SandboxedUi).length, 2);
  await h.find("button", "Undo this change").props.onClick(); await h.settle();
  assert.equal(h.current(), "a\nold\nb\nlast\n");
  assert.deepEqual(h.saved, ["fixture.md"]);
  assert.equal(h.calls.filter(([cmd]) => cmd === "document_preview").length, 4);
});
test("Office restore requires confirmation; failure leaves previews and retry usable", async () => {
  const h = paneHarness("docx"); h.render(); await h.settle();
  const frames = h.nodes().filter(n => n.type === h.OfficeFrame);
  assert.equal(frames.length, 2); assert.equal(frames.every(n => n.props.editing === false), true);
  assert.match(h.text(), /cannot safely be undone per region/);
  assert.equal(h.nodes().some(n => n.type === "button" && n.props.children === "Undo this change"), false);
  h.find("button", "Restore this version").props.onClick(); h.render();
  assert.equal(h.calls.filter(([cmd]) => cmd === "document_restore").length, 0);
  h.find("button", "Cancel").props.onClick(); h.render();
  assert.equal(h.calls.filter(([cmd]) => cmd === "document_restore").length, 0);
  h.find("button", "Restore this version").props.onClick(); h.render(); h.fail(true);
  await h.find("button", "Confirm restore").props.onClick(); await h.settle();
  assert.match(h.text(), /Fixture file is locked/);
  assert.equal(h.nodes().filter(n => n.type === h.OfficeFrame).length, 2);
  assert.equal(h.find("button", "Restore this version").props.disabled, false);
  assert.equal(h.saved.length, 0); assert.equal(h.current(), "a\nnew\nb\nlast\n");
  h.fail(false); h.find("button", "Restore this version").props.onClick(); h.render();
  await h.find("button", "Confirm restore").props.onClick(); await h.settle();
  assert.equal(h.current(), "a\nold\nb\nend\n"); assert.deepEqual(h.saved, ["fixture.docx"]);
});
test("Office extracted text yields summary and highlights; PDF states visual-only", async () => {
  const h = paneHarness("xlsx"); h.render(); await h.settle();
  const frames = h.nodes().filter(n => n.type === h.OfficeFrame);
  frames[0].props.onTexts({ "/Sheet1/A1": "26" }); frames[1].props.onTexts({ "/Sheet1/A1": "24" }); h.render();
  assert.match(h.text(), /1 changed region/);
  const updated = h.nodes().filter(n => n.type === h.OfficeFrame);
  assert.equal(updated[0].props.comparison["/Sheet1/A1"], "24");
  const pdf = paneHarness("pdf"); pdf.render(); await pdf.settle();
  assert.equal(pdf.nodes().filter(n => n.type === pdf.Pdf).length, 2);
  assert.match(pdf.text(), /Only a visual comparison is available/);
});
test("empty Office text reports do not claim a usable extracted-text comparison", async () => {
  const h = paneHarness("docx"); h.render(); await h.settle();
  const frames = h.nodes().filter(n => n.type === h.OfficeFrame);
  frames[0].props.onTexts({ "/body/p[1]": "  " }); frames[1].props.onTexts({ "/body/p[1]": "" }); h.render();
  assert.match(h.text(), /Only a visual comparison is available/);
  assert.doesNotMatch(h.text(), /1 changed region/);
});
test("rapid double confirmation dispatches only one restore while the write is pending", async () => {
  const h = paneHarness("docx"); h.render(); await h.settle();
  let release; h.pending(new Promise(resolve => { release = resolve; }));
  h.find("button", "Restore this version").props.onClick(); h.render();
  const confirm = h.find("button", "Confirm restore").props.onClick;
  const first = confirm(), second = confirm();
  const count = h.calls.filter(([cmd]) => cmd === "document_restore").length;
  release(); await first; await second; await h.settle();
  assert.equal(count, 1);
});
