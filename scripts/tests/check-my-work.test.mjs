import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Exercise the production handler and prompt builder, with only Tauri IPC and React state at the boundary.
const appSource = ts.createSourceFile("App.tsx", readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
const app = appSource.statements.find(s => s.name?.text === "App");
const handler = app.body.statements.find(s => s.name?.text === "checkMyWork");
const workspaceSource = ts.createSourceFile("Workspace.tsx", readFileSync(new URL("../../src/Workspace.tsx", import.meta.url), "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
const touched = workspaceSource.statements.find(s => s.name?.text === "touchedFile");
const transpile = s => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const fixtures = [
  { id: 1, role: "user", body: { text: "Create a budget using source.xlsx" } },
  { id: 2, role: "assistant", body: { text: "private reasoning" } },
  { id: 3, role: "tool", body: { status: "success", request: { name: "mcp__workbench__office_recipe", args: { action: "table", target: "budget.xlsx", source: "source.xlsx" } } } },
  { id: 4, role: "tool", body: { status: "success", request: { name: "Write", args: { file_path: "notes.md" } } } },
  { id: 5, role: "assistant", body: { text: "Done" } },
];
function harness(messages = fixtures, fail = false) {
  assert.ok(handler, "App must expose a check-my-work action");
  const scope = { exports: {} };
  vm.runInNewContext(transpile(touched.getText()), scope);
  const helper = readFileSync(new URL("../../src/checkMyWork.ts", import.meta.url), "utf8");
  const touchedFile = scope.exports.touchedFile;
  scope.require = name => { assert.equal(name, "./Workspace"); return { touchedFile }; };
  scope.exports = {};
  vm.runInNewContext(transpile(helper), scope);
  const state = { cur: "old", input: "draft", files: ["draft.txt"], msgs: messages, error: "", queue: [] };
  const calls = [], navigation = { current: 0 }, curRef = { current: "old" };
  Object.assign(scope, scope.exports, {
    msgs: messages, curRef, navigation, curConv: { id: "old", workspace: "C:\\Work\\Budget" },
    live: { busy: false }, queue: [], modelReady: true, offline: { chat: false, global: false }, checkingWork: { current: false }, creating: { current: null }, applyingTemplate: { current: false },
    createdHere: { current: null }, stick: { current: false }, modeKey: { current: "default" }, ttftEstimate: () => null,
    invoke: async (cmd, args) => { calls.push({ cmd, args }); if (cmd === "create_conversation") { if (fail) throw Error("Cannot create chat"); return "new"; } },
    selectConversation: id => { navigation.current++; curRef.current = id; state.cur = id; },
    refreshConvs: async () => {}, reload: async () => {}, refreshOffline: () => {},
  });
  for (const [setter, key] of Object.entries({ setInput: "input", setFiles: "files", setMsgs: "msgs", setQueue: "queue", setErr: "error", setLive: "live", setEditing: "editing", setWorkspaceRequest: "request", setWorkspaceOpen: "workspaceOpen", setCtx: "ctx", setFirstWait: "firstWait", setCheckingWork: "checking" })) {
    scope[setter] = value => { state[key] = typeof value === "function" ? value(state[key] ?? {}) : value; };
  }
  vm.runInNewContext(transpile(handler.getText()), scope);
  return { state, calls, scope, run: () => scope.checkMyWork() };
}

test("a new chat in the same folder gets only the request and produced paths, not the original conversation", async () => {
  const before = JSON.stringify(fixtures), h = harness(); await h.run();
  assert.equal(h.state.cur, "new");
  assert.equal(h.calls[0].cmd, "create_conversation"); assert.equal(h.calls[0].args.workspace, "C:\\Work\\Budget");
  const send = h.calls.find(c => c.cmd === "agent_send"); assert.equal(send.args.id, "new");
  assert.match(send.args.text, /Create a budget using source.xlsx/); assert.match(send.args.text, /budget.xlsx/); assert.match(send.args.text, /notes.md/);
  assert.doesNotMatch(send.args.text, /private reasoning|Done/);
  assert.match(send.args.text, /only change.*explicitly asks/i); assert.match(send.args.text, /could not.*read|cannot.*read/i);
  assert.equal(JSON.stringify(fixtures), before);
});

test("no produced file means no new chat or agent send; failed and read-only tools do not count", async () => {
  const messages = [fixtures[0], { id: 2, role: "tool", body: { status: "error", request: { name: "Write", args: { file_path: "failed.md" } } } }, { id: 3, role: "tool", body: { status: "success", request: { name: "officecli", args: { args: ["view", "source.docx"] } } } }, fixtures[4]];
  const h = harness(messages); await h.run(); assert.equal(h.calls.length, 0); assert.equal(h.state.cur, "old");
});

test("creation failure leaves the current chat and draft usable and shows an error", async () => {
  const h = harness(fixtures, true); await h.run();
  assert.equal(h.state.cur, "old"); assert.equal(h.state.input, "draft"); assert.deepEqual(h.state.files, ["draft.txt"]);
  assert.equal(h.state.msgs, fixtures); assert.match(h.state.error, /Cannot create chat/); assert.equal(h.calls.some(c => c.cmd === "agent_send"), false);
});

test("absolute and relative paths outside the workspace do not trigger a check", async () => {
  const messages = [fixtures[0], ...["C:\\Elsewhere\\other.md", "../other.md", "/tmp/other.md"].map((file_path, i) => ({ id: i + 2, role: "tool", body: { status: "success", request: { name: "Write", args: { file_path } } } })), fixtures[4]];
  const h = harness(messages); await h.run(); assert.equal(h.calls.length, 0);
});

test("a filesystem root workspace accepts absolute files on Linux and Windows", async () => {
  for (const [root, path, expected] of [["/", "/report.md", "report.md"], ["C:\\", "c:\\report.md", "report.md"]]) {
    const messages = [fixtures[0], { id: 2, role: "tool", body: { status: "success", request: { name: "Write", args: { file_path: path } } } }, fixtures[4]];
    const h = harness(messages); h.scope.curConv.workspace = root; await h.run();
    const send = h.calls.find(c => c.cmd === "agent_send"); assert.ok(send); assert.match(send.args.text, new RegExp(expected));
  }
});

test("a chat kept offline stays offline in the new check before sending", async () => {
  const h = harness(); h.scope.offline.chat = true; await h.run();
  const offline = h.calls.findIndex(c => c.cmd === "chat_offline_set"), send = h.calls.findIndex(c => c.cmd === "agent_send");
  assert.ok(offline >= 0 && offline < send); assert.equal(h.calls[offline].args.conv, "new"); assert.equal(h.calls[offline].args.on, true);
});

test("navigating away during creation never sends into or replaces the selected chat", async () => {
  const h = harness(); let finish;
  h.scope.invoke = (cmd, args) => { h.calls.push({ cmd, args }); return new Promise(resolve => { finish = resolve; }); };
  const pending = h.run(); h.scope.selectConversation("other"); finish("new"); await pending;
  assert.equal(h.state.cur, "other"); assert.equal(h.state.input, "draft"); assert.equal(h.calls.some(c => c.cmd === "agent_send"), false);
});

test("a send failure leaves the verification prompt available in the new chat", async () => {
  const h = harness();
  h.scope.invoke = async (cmd, args) => { h.calls.push({ cmd, args }); if (cmd === "create_conversation") return "new"; if (cmd === "agent_send") throw Error("Model unavailable"); };
  await h.run(); assert.equal(h.state.cur, "new"); assert.match(h.state.input, /Create a budget/); assert.match(h.state.error, /Model unavailable/); assert.equal(h.state.live.busy, false);
});

test("only the latest user turn's successful changes are used", async () => {
  const messages = [...fixtures, { id: 6, role: "user", body: { text: "Polish the report" } }, { id: 7, role: "tool", body: { status: "success", request: { name: "officecli", args: { args: ["set", "C:\\Work\\Budget\\report.docx"] } } } }, { id: 8, role: "assistant", body: { text: "Finished" } }];
  const h = harness(messages); await h.run(); const prompt = h.calls.find(c => c.cmd === "agent_send").args.text;
  assert.match(prompt, /Polish the report/); assert.match(prompt, /report.docx/); assert.doesNotMatch(prompt, /budget.xlsx|notes.md|Create a budget/);
});
