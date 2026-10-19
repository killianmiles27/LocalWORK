import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../..");
const source = readFileSync(resolve(root, "src/chatDates.ts"), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { groupOf, groupChats } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

const now = new Date(2026, 9, 19, 15, 0).getTime();
const at = (d, h = 12) => new Date(2026, 9, d, h).getTime();

test("chats fall into calendar-day groups", () => {
  assert.equal(groupOf({ updated: new Date(2026, 9, 19, 0, 1).getTime() }, now), "Today");
  assert.equal(groupOf({ updated: new Date(2026, 9, 18, 23, 59).getTime() }, now), "Yesterday");
  assert.equal(groupOf({ updated: at(13) }, now), "Previous 7 days");
  assert.equal(groupOf({ updated: at(1) }, now), "Previous 30 days");
  assert.equal(groupOf({ updated: new Date(2026, 5, 1).getTime() }, now), "Older");
  assert.equal(groupOf({ updated: at(19), pinned: true }, now), "Pinned");
});

test("groups keep list order and drop empty groups", () => {
  const list = [{ id: "p", updated: at(1), pinned: true }, { id: "a", updated: at(19) }, { id: "b", updated: at(19, 9) }, { id: "o", updated: 0 }];
  const out = groupChats(list, now);
  assert.deepEqual(out.map(g => g.label), ["Pinned", "Today", "Older"]);
  assert.deepEqual(out[1].items.map(c => c.id), ["a", "b"]);
});
