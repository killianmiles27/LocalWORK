import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createElement, Fragment } from "react";

// Run App's real template handler with only IPC and React setters replaced.
const source = ts.createSourceFile("App.tsx", readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
const app = source.statements.find(s => s.name?.text === "App");
const handler = app.body.statements.find(s => s.name?.text === "applyTaskTemplate");
function harness() {
  assert.ok(handler, "App must apply saved task templates");
  let resolve, reject;
  const state = { cur: "old", input: "Old draft", files: ["old.txt"], msgs: ["old message"], queue: ["queued"], error: "" };
  const navigation = { current: 0 }, curRef = { current: "old" }, createdHere = { current: null }, applyingTemplate = { current: false };
  const calls = [];
  const scope = { navigation, curRef, createdHere, applyingTemplate, live: { busy: false }, creating: { current: null },
    invoke: (cmd, args) => { calls.push({ cmd, args }); return cmd === "task_template_apply" ? new Promise((a, b) => { resolve = a; reject = b; }) : Promise.resolve(); },
    selectConversation: id => { navigation.current++; curRef.current = id; state.cur = id; },
    refreshConvs() {}, reload() {}, refreshCtx() {},
    taRef: { current: { focus() {} } },
  };
  for (const [setter, key] of Object.entries({ setInput: "input", setFiles: "files", setMsgs: "msgs", setQueue: "queue", setErr: "error", setLive: "live", setEditing: "editing", setWorkspaceRequest: "request", setCtx: "ctx", setWorkspaceOpen: "workspaceOpen", setTemplateApplying: "applying" })) {
    scope[setter] = value => { state[key] = typeof value === "function" ? value(state[key] ?? {}) : value; };
  }
  const js = ts.transpileModule(handler.getText(), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, scope);
  return { scope, state, calls, navigation, createdHere, run: () => scope.applyTaskTemplate("t1"),
    resolve: () => resolve({ id: "new", prompt: "Draft a weekly report", workspace: "C:\\Work", files: ["attachments/report.docx"] }), reject: () => reject("Template file missing: C:\\source\\report.docx") };
}

test("applying a task template selects an empty chat and prefills prompt and attachments without sending", async () => {
  const h = harness(), pending = h.run();
  assert.equal(h.state.cur, "old", "do not navigate until validation and copy succeed");
  h.resolve(); await pending;
  assert.equal(h.state.cur, "new");
  assert.equal(h.scope.curRef.current, "new");
  assert.equal(h.createdHere.current, "new", "the chat-change effect must preserve the new draft");
  assert.equal(h.state.input, "Draft a weekly report");
  assert.deepEqual(h.state.files, ["attachments/report.docx"]);
  assert.equal(h.state.msgs.length, 0); assert.equal(h.state.queue.length, 0);
  assert.equal(h.state.live.busy, false);
  assert.equal(h.calls.some(c => c.cmd === "agent_send"), false);
});

test("missing template inputs leave the current chat and draft intact with a useful error", async () => {
  const h = harness(), pending = h.run(); h.reject(); await pending;
  assert.equal(h.state.cur, "old"); assert.equal(h.state.input, "Old draft");
  assert.deepEqual(h.state.files, ["old.txt"]);
  assert.match(h.state.error, /report.docx/);
});

test("late template completion cannot replace a chat selected in the meantime", async () => {
  const h = harness(), pending = h.run(); h.scope.selectConversation("other"); h.resolve(); await pending;
  assert.equal(h.state.cur, "other"); assert.equal(h.state.input, "Old draft");
});

// Exercise the real compact panel/dialog with controlled hooks and an IPC boundary,
// matching the renderer tests elsewhere in this harness (no browser dependency).
const panelSource = readFileSync(new URL("../../src/TaskTemplates.tsx", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
function panelHarness() {
  const slots = []; let cursor = 0, effects = [], tree;
  let stored = [{ id: "t1", name: "Weekly", prompt: "Draft report", workspace: "/work", document: null }];
  const deps = {
    createElement, React: { Fragment }, BookmarkPlus: () => null, Pencil: () => null, Trash2: () => null, X: () => null,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], v => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(fn, values) { const i = cursor++; if (!slots[i] || values.some((v, k) => !Object.is(v, slots[i][k]))) { slots[i] = values; effects.push(fn); } },
    async open(options) { return options.directory ? "/chosen-work" : "/source/report.xlsx"; },
    window: { confirm: () => true },
    async invoke(cmd, args) {
      if (cmd === "task_templates_list") return [...stored];
      if (cmd === "task_template_save") {
        assert.equal(args.prompt, "Summarize figures"); assert.equal(args.workspace, "/work");
        assert.equal(args.document, "/work/attachments/base.docx");
        stored.push({ ...args, id: "t2" }); return;
      }
      if (cmd === "task_template_rename") { stored = stored.map(t => t.id === args.id ? { ...t, name: args.title } : t); return; }
      if (cmd === "task_template_delete") { stored = stored.filter(t => t.id !== args.id); return; }
      throw Error(`Unexpected command ${cmd}`);
    },
    exports: {},
  };
  const js = ts.transpileModule(panelSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: "createElement" } }).outputText;
  vm.runInNewContext(js, deps);
  function render() { cursor = 0; tree = deps.exports.default({ prompt: "Summarize figures", workspace: "/work", attachments: ["attachments/base.docx"], disabled: false, onApply: async () => {} }); for (const effect of effects.splice(0)) effect(); return tree; }
  function nodes(node) { if (!node || typeof node !== "object") return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)]; }
  const text = n => typeof n === "string" ? n : Array.isArray(n) ? n.map(text).join("") : text(n?.props?.children ?? "");
  function find(type, label) { const n = nodes(tree).find(n => n.type === type && (n.props["aria-label"] === label || text(n) === label)); assert.ok(n, `${type}: ${label}`); return n; }
  async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); }
  return { render, settle, nodes: () => nodes(tree), find };
}

test("the template dialog saves the composer setup and optional attachment; buttons support rename and delete", async () => {
  const h = panelHarness(); h.render(); await h.settle();
  h.find("button", "Save as task template").props.onClick(); h.render();
  let name = h.nodes().find(n => n.type === "input"); name.props.onChange({ target: { value: "Budget" } }); h.render();
  h.nodes().find(n => n.type === "form").props.onSubmit({ preventDefault() {} }); await h.settle();
  assert.ok(h.find("button", "Budget"));
  h.find("button", "Rename task template Budget").props.onClick(); h.render();
  name = h.nodes().find(n => n.type === "input"); name.props.onChange({ target: { value: "Monthly budget" } }); h.render();
  h.nodes().find(n => n.type === "form").props.onSubmit({ preventDefault() {} }); await h.settle();
  assert.ok(h.find("button", "Monthly budget"));
  h.find("button", "Delete task template Monthly budget").props.onClick(); await h.settle();
  assert.equal(h.nodes().some(n => n.type === "button" && n.props["aria-label"] === "Rename task template Monthly budget"), false);
});

test("double clicks and a busy chat cannot launch concurrent template applications", async () => {
  const h = harness(), pending = h.run(); await h.run();
  assert.equal(h.calls.filter(c => c.cmd === "task_template_apply").length, 1);
  h.resolve(); await pending;
  h.scope.live.busy = true; await h.run();
  assert.equal(h.calls.filter(c => c.cmd === "task_template_apply").length, 1);
});
