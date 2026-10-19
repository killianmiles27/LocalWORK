// Timed live run of any prompt against an already running LocalWORK (CDP on the given endpoint).
// Changes no settings: the chat lands in the user's normal projects folder. Every agent event is
// timestamped so the wall time can be split into model time (prompt read + generation) and the rest.
// Approvals: allowed when every absolute path in the arguments is inside the chat folder, denied otherwise; all logged.
// Usage: node timed-run.mjs <cdp-endpoint> <prompt-file> <out-dir> [minutes]
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = resolve(import.meta.dirname, '../..');
const { chromium } = createRequire(resolve(root, 'vendor/playwright/node_modules/playwright-core/package.json'))('playwright-core');
const [endpoint, promptFile, out, minutes = '40'] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0].pages().find(p => p.url().includes('tauri.localhost'));
if (!page) throw Error('LocalWORK page not found');
const invoke = (cmd, args) => page.evaluate(({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
await page.evaluate(async () => {
  window.__ev = [];
  const keep = p => { const ev = p.ev; if (ev && typeof ev.text === 'string') return { ...p, ev: { ...ev, text: undefined, chars: ev.text.length } }; return p; };
  for (const name of ['agent-event', 'approval-request'])
    await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
      event: name, target: { kind: 'Any' },
      handler: window.__TAURI_INTERNALS__.transformCallback(e => window.__ev.push({ t: Date.now(), kind: name, p: keep(e.payload) })),
    });
});
const before = new Set((await invoke('list_conversations')).map(c => c.id));
const prompt = await readFile(promptFile, 'utf8');
await page.getByRole('button', { name: 'New chat' }).first().click().catch(() => {});
await page.getByRole('textbox', { name: 'Message', exact: true }).fill(prompt);
const t0 = Date.now();
await page.getByRole('button', { name: 'Send', exact: true }).click();
let id, conv, cursor = 0, verdict = 'timeout';
const answered = new Set(), approvals = [];
const inside = (args, ws) => {
  const paths = JSON.stringify(args ?? {}).match(/[A-Za-z]:(\\\\|\/)[^"]*/g) ?? [];
  const norm = s => s.replaceAll('\\\\', '/').replaceAll('\\', '/').toLowerCase();
  return paths.every(p => norm(p).startsWith(norm(ws)));
};
const save = async () => {
  const events = await page.evaluate(() => window.__ev);
  const messages = id ? await invoke('load_messages', { id }) : [];
  await writeFile(resolve(out, 'run.json'), JSON.stringify({ t0, id, workspace: conv?.workspace, verdict, approvals, events, messages }, null, 1));
  return { events, messages };
};
while (Date.now() - t0 < Number(minutes) * 60000) {
  await new Promise(r => setTimeout(r, 1000));
  if (!id) { conv = (await invoke('list_conversations')).find(c => !before.has(c.id)); id = conv?.id; }
  const events = await page.evaluate(n => window.__ev.slice(n), cursor);
  cursor += events.length;
  for (const e of events) {
    if (e.kind !== 'approval-request' || answered.has(e.p.call_id)) continue;
    answered.add(e.p.call_id);
    const allow = !!conv && inside(e.p.args, conv.workspace);
    approvals.push({ s: (e.t - t0) / 1000, tool: e.p.tool, class: e.p.class, allow, args: JSON.stringify(e.p.args).slice(0, 300) });
    console.log(`[${((e.t - t0) / 1000).toFixed(0)}s] approval ${e.p.tool} -> ${allow ? 'allow' : 'deny'}`);
    await invoke('agent_answer', { id: e.p.conv, callId: e.p.call_id, allow, remember: false });
  }
  for (const e of events) if (e.kind === 'agent-event' && e.p.conv === id && /tool_request|tool_result|stream_end|error|agent_exit/.test(e.p.ev?.type))
    console.log(`[${((e.t - t0) / 1000).toFixed(0)}s] ${e.p.ev.type} ${e.p.ev.tool_name ?? e.p.ev.name ?? ''}`);
  const done = events.find(e => e.kind === 'agent-event' && e.p.conv === id && (e.p.ev?.type === 'agent_exit' || (e.p.ev?.type === 'stream_end' && e.p.ev?.msg_id !== 'ctx-refresh' && e.p.ev?.msg_id !== 'ctx-initial' && e.p.ev?.msg_id !== 'ctx-after-compact')));
  if (done && (await page.getByRole('button', { name: 'Send', exact: true }).count())) { verdict = done.p.ev.type; break; }
}
await save();
await page.screenshot({ path: resolve(out, 'final.png') });
console.log(`verdict=${verdict} wall=${((Date.now() - t0) / 1000).toFixed(0)}s conv=${id}`);
await browser.close();
