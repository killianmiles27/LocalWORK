import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const url = new URL("../../src/document-diff.ts", import.meta.url);
const source = readFileSync(url, "utf8");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { lineDiff, undoHunk, linePreview, applyDocumentChange } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

for (const [name, before, after, hunks, undone] of [
  ["adds", "a\nb\n", "a\nx\nb\n", [[1, 1, 1, 2]], "a\nb\n"],
  ["removes", "a\nx\nb\n", "a\nb\n", [[1, 2, 1, 1]], "a\nx\nb\n"],
  ["replaces", "a\nold\nb\n", "a\nnew\nb\n", [[1, 2, 1, 2]], "a\nold\nb\n"],
  ["CRLF", "a\r\nold\r\nb\r\n", "a\r\nnew\r\nb\r\n", [[1, 2, 1, 2]], "a\r\nold\r\nb\r\n"],
  ["empty file", "", "new", [[0, 0, 0, 1]], ""],
  ["final newline", "a", "a\n", [[0, 1, 0, 1]], "a"],
  ["separate changes", "a\nold\nb\nend\n", "a\nnew\nb\nlast\n", [[1, 2, 1, 2], [3, 4, 3, 4]], "a\nold\nb\nlast\n"],
]) {
  test(`line mapping and undo: ${name}`, () => {
    assert.equal(typeof lineDiff, "function", "line diff must be implemented");
    const diff = lineDiff(before, after);
    assert.deepEqual(diff.hunks.map(h => [h.oldStart, h.oldEnd, h.newStart, h.newEnd]), hunks);
    assert.equal(undoHunk(diff, 0), undone);
  });
}
test("equal and repeated lines have stable mappings; large comparisons stay bounded", () => {
  assert.equal(typeof lineDiff, "function");
  assert.deepEqual(lineDiff("a\r\na\r\n", "a\r\na\r\n").hunks, []);
  const repeated = lineDiff("a\nx\na\ny\n", "a\na\nz\n");
  assert.equal(undoHunk(repeated, 0), "a\nx\na\nz\n");
  const large = lineDiff("old\n".repeat(3000), "new\n".repeat(3000));
  assert.equal(large.coarse, true);
  assert.equal(large.hunks.length, 1);
  assert.equal(undoHunk(large, 0), "old\n".repeat(3000));
});
test("line preview escapes active markup while marking only changed line ranges", () => {
  assert.equal(typeof linePreview, "function");
  const diff = lineDiff("safe\n<script>bad()</script>\n", "safe\n<img onerror=bad()>\n");
  const html = linePreview(diff, "after");
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img onerror=bad\(\)&gt;/);
  assert.equal((html.match(/class="added"/g) ?? []).length, 1);
  assert.match(linePreview(diff, "before"), /class="removed"/);
});

function harness(fail = false) {
  const calls = [], events = [];
  const state = { busy: false, error: "old error", preview: "current", refresh: 0 };
  const ui = {
    busy: b => { state.busy = b; }, error: e => { state.error = e; },
    saved: () => { events.push("saved"); state.refresh++; },
  };
  const invoke = async (cmd, args) => { calls.push([cmd, args]); if (fail) throw Error("File is locked"); events.push("write"); };
  return { state, calls, events, ui, invoke };
}
test("restore uses a revision-scoped command and refreshes only after success", async () => {
  assert.equal(typeof applyDocumentChange, "function");
  const h = harness();
  await applyDocumentChange(h.invoke, { id: "chat", path: "report.docx", revision: "abc" }, h.ui);
  assert.deepEqual(h.calls, [["document_restore", { id: "chat", path: "report.docx", revision: "abc" }]]);
  assert.deepEqual(h.events, ["write", "saved"]);
  assert.deepEqual(h.state, { busy: false, error: "", preview: "current", refresh: 1 });
});
test("hunk undo sends full current text as the conflict guard, preserving unrelated edits", async () => {
  assert.equal(typeof applyDocumentChange, "function");
  const h = harness();
  const diff = lineDiff("a\nold\nb\nend\n", "a\nnew\nb\nlast\n");
  await applyDocumentChange(h.invoke, { id: "chat", path: "notes.md", diff, hunk: 0 }, h.ui);
  assert.deepEqual(h.calls, [["document_save", { id: "chat", path: "notes.md", content: "a\nold\nb\nlast\n", expected: "a\nnew\nb\nlast\n" }]]);
  assert.equal(h.state.refresh, 1);
});
test("failed restore retains the preview, reports inline error and unlocks the pane for retry", async () => {
  assert.equal(typeof applyDocumentChange, "function");
  const h = harness(true);
  await applyDocumentChange(h.invoke, { id: "chat", path: "report.docx", revision: "abc" }, h.ui);
  assert.deepEqual(h.state, { busy: false, error: "Error: File is locked", preview: "current", refresh: 0 });
  assert.deepEqual(h.events, []);
  const retry = harness();
  await applyDocumentChange(retry.invoke, { id: "chat", path: "report.docx", revision: "abc" }, { ...h.ui, saved: () => h.state.refresh++ });
  assert.equal(h.state.busy, false);
  assert.equal(h.state.error, "");
  assert.equal(h.state.refresh, 1);
});
