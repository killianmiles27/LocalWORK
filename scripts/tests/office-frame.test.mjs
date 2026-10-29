import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../../src/OfficeFrame.tsx', import.meta.url), 'utf8');
// Evaluate the literal as JavaScript first, as the TS bundle does (including regex escapes).
const bridge = vm.runInNewContext(source.match(/const BRIDGE = (`[\s\S]*?`);/)[1]);
function harness() {
  const events = {}, messages = [];
  const classes = new Set();
  const node = { tagName: 'TD', innerText: '24', classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } }, attrs: { 'data-path': '/Sheet1/B4' },
    get textContent() { return this.innerText; }, set textContent(v) { this.innerText = v; },
    getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    querySelector() { return null; }, closest() { return this; }, blur() { fire('focusout', { target: this }); } };
  const parent = { postMessage(m) { messages.push(m); } };
  const window = { addEventListener(name, cb) { events[name] = cb; }, scrollTo() {}, scrollY: 0 };
  const document = { readyState: 'complete', body: { style: {} }, documentElement: { classList: { toggle() {} } },
    querySelectorAll() { return [node]; }, addEventListener: window.addEventListener };
  const selection = { rangeCount: 1, anchorNode: { nodeType: 1, closest() { return node; } }, toString() { return '24'; },
    getRangeAt() { return { getBoundingClientRect() { return { top: 1, left: 2, bottom: 3 }; } }; } };
  function fire(type, event = {}) { events[type]?.(event); }
  vm.runInNewContext(bridge, { window, document, parent, getSelection: () => selection, setTimeout: cb => { cb(); return 1; }, clearTimeout() {}, CSS: { escape: s => s } });
  function command(data) { fire('message', { source: parent, data }); }
  return { node, messages, document, fire, command };
}

test('editable Office text can still be selected for an AI note and emits the actual edit', () => {
  const h = harness();
  h.command({ type: 'lw-edit-mode', on: true });
  assert.equal(h.node.attrs.contenteditable, 'plaintext-only');
  h.fire('focusin', { target: h.node });
  h.fire('mouseup');
  assert.equal(h.messages.find(m => m.type === 'lw-select').text, '24');
  h.node.innerText = '26';
  h.fire('focusout', { target: h.node });
  const edit = h.messages.find(m => m.type === 'lw-edit');
  assert.equal(edit.path, '/Sheet1/B4'); assert.equal(edit.before, '24'); assert.equal(edit.after, '26');
  assert.equal(h.messages.at(-1).active, false);
  h.command({ type: 'lw-edit-mode', on: false });
  assert.equal(h.node.attrs.contenteditable, undefined);
});

test('comparison persistently marks changed visible Office elements without enabling edits', () => {
  const h = harness();
  h.command({ type: 'lw-compare', texts: { '/Sheet1/B4': '22' } });
  assert.equal(h.node.classList.contains('lw-compared'), true);
  assert.equal(h.node.attrs.contenteditable, undefined);
  h.command({ type: 'lw-compare', texts: { '/Sheet1/B4': '24' } });
  assert.equal(h.node.classList.contains('lw-compared'), false);
  h.command({ type: 'lw-compare', texts: {} });
  assert.equal(h.node.classList.contains('lw-compared'), true, 'added or removed elements must be marked');
});

test('formula focus and Escape restore displayed value without saving an unintended change', () => {
  const h = harness(); h.node.attrs['data-formula'] = '=SUM(B1:B3)';
  h.fire('focusin', { target: h.node }); assert.equal(h.node.innerText, '=SUM(B1:B3)');
  h.fire('focusout', { target: h.node }); assert.equal(h.node.innerText, '24');
  assert.equal(h.messages.some(m => m.type === 'lw-edit'), false);
  h.fire('focusin', { target: h.node }); h.node.innerText = 'oops'; h.node.isContentEditable = true;
  h.fire('keydown', { target: h.node, key: 'Escape', stopImmediatePropagation() {} });
  assert.equal(h.node.innerText, '24'); assert.equal(h.messages.some(m => m.type === 'lw-edit'), false);
});

test('frame zoom shortcuts prevent browser zoom and work while typing', () => {
  const h = harness(); let prevented = 0;
  const event = { target: { isContentEditable: true }, ctrlKey: true, preventDefault() { prevented++; }, stopImmediatePropagation() {} };
  h.fire('wheel', { ...event, deltaY: -1 });
  h.fire('keydown', { ...event, key: '-' }); h.fire('keydown', { ...event, key: '0' });
  assert.equal(prevented, 3);
  assert.deepEqual(h.messages.filter(m => m.type === 'lw-zoom-request').map(m => m.direction), [1, -1, 0]);
  h.command({ type: 'lw-zoom', zoom: 150 }); assert.equal(h.document.body.style.zoom, '1.5');
});

test('editing a formula updates its next focus origin and converting to a value removes the formula', () => {
  const h = harness(); h.node.attrs['data-formula'] = '=SUM(B1:B3)';
  h.fire('focusin', { target: h.node }); h.node.innerText = '=SUM(B1:B4)'; h.fire('focusout', { target: h.node });
  assert.equal(h.node.attrs['data-formula'], '=SUM(B1:B4)');
  h.fire('focusin', { target: h.node }); assert.equal(h.node.innerText, '=SUM(B1:B4)');
  h.node.innerText = '30'; h.fire('focusout', { target: h.node });
  assert.equal(h.node.attrs['data-formula'], undefined);
  h.fire('focusin', { target: h.node }); assert.equal(h.node.innerText, '30');
  h.node.innerText = '31'; h.fire('focusout', { target: h.node });
  const edits = h.messages.filter(m => m.type === 'lw-edit');
  assert.deepEqual(edits.map(m => [m.before, m.after]), [['=SUM(B1:B3)', '=SUM(B1:B4)'], ['=SUM(B1:B4)', '30'], ['30', '31']]);
});

// Run the actual deferred preview request from Workspace against controllable edit/save state.
const workspaceSource = readFileSync(new URL('../../src/Workspace.tsx', import.meta.url), 'utf8');
const previewRequest = workspaceSource.match(/const requestGeneration = officeEditGeneration.current;[\s\S]*?\.finally\(\(\) => \{ if \(active\) setLoading\(false\); \}\);/)[0].replace('invoke<Preview>', 'invoke');
function previewHarness() {
  let resolvePreview, applied = false, stale = false;
  const officeInteraction = { current: false }, pendingOfficeEdits = { current: 0 }, officeEditGeneration = { current: 0 };
  const scope = { officeInteraction, pendingOfficeEdits, officeEditGeneration, active: true, revision: '', id: 'chat', selectedFile: 'budget.xlsx',
    invoke: () => new Promise(resolve => { resolvePreview = resolve; }), seen: { current: new Map() },
    setStale: value => { stale = value; }, setPreview: () => { applied = true; }, setPrevious() {}, setError() {}, setLoading() {} };
  const finished = vm.runInNewContext(previewRequest, scope);
  return { officeInteraction, pendingOfficeEdits, officeEditGeneration, finished,
    resolve: () => resolvePreview({ path: 'budget.xlsx', format: 'html', content: 'old' }), state: () => ({ applied, stale }) };
}

test('preview started before blur cannot replace the page while a save is queued', async () => {
  const h = previewHarness(); h.pendingOfficeEdits.current = 1; h.resolve(); await h.finished;
  assert.deepEqual(h.state(), { applied: false, stale: true });
});

test('preview started before an edit cannot replace it even after that save finishes', async () => {
  const h = previewHarness(); h.officeEditGeneration.current++; h.pendingOfficeEdits.current = 0; h.resolve(); await h.finished;
  assert.deepEqual(h.state(), { applied: false, stale: true });
  const fresh = previewHarness(); fresh.resolve(); await fresh.finished;
  assert.deepEqual(fresh.state(), { applied: true, stale: false });
});
