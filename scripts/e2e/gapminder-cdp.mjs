// Live acceptance probe. No model responses, tools, browser actions or approvals are mocked.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = resolve(import.meta.dirname, '../..');
const { chromium } = createRequire(resolve(root, 'vendor/playwright/node_modules/playwright-core/package.json'))('playwright-core');
const [endpoint, work] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0].pages().find(p => p.url().includes('tauri.localhost'));
if (!page) throw Error('LocalWORK page not found');
const invoke = (cmd, args) => page.evaluate(({cmd, args}) => window.__TAURI_INTERNALS__.invoke(cmd, args), {cmd, args});
let id, detail, success = false;
try {
  const outputs = resolve(work, 'gapminder-output');
  await mkdir(outputs, {recursive: true});
  await invoke('set_setting', {key: 'wizard_done', value: '1'});
  await invoke('set_setting', {key: 'projects_folder', value: outputs});
  await page.reload();
  await page.getByRole('textbox', {name: 'Message', exact: true}).waitFor();
  await page.evaluate(async () => {
    window.__gapEvents = [];
    await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
      event: 'agent-event', target: {kind: 'Any'},
      handler: window.__TAURI_INTERNALS__.transformCallback(e => window.__gapEvents.push(e.payload))
    });
    await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
      event: 'approval-request', target: {kind: 'Any'},
      handler: window.__TAURI_INTERNALS__.transformCallback(e => window.__gapEvents.push({approval: e.payload}))
    });
  });
  const prompt = await readFile(resolve(import.meta.dirname, 'gapminder-prompt.txt'), 'utf8');
  await page.getByRole('textbox', {name: 'Message', exact: true}).fill(prompt);
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  const start = Date.now();
  let lastProgress = 0;
  while (Date.now() - start < 25 * 60 * 1000) {
    const convs = await invoke('list_conversations');
    id ??= convs.find(c => c.workspace.startsWith(outputs))?.id;
    const events = await page.evaluate(() => window.__gapEvents);
    const approvals = events.filter(e => e.approval);
    const messages = id ? await invoke('load_messages', {id}) : [];
    if (Date.now() - lastProgress > 30000) {
      lastProgress = Date.now();
      console.log(`Live Gapminder: ${Math.round((Date.now()-start)/1000)}s, ${messages.filter(m=>m.role==='tool').length} tools, ${approvals.length} approvals`);
      await writeFile(resolve(work, 'gapminder-transcript.json'), JSON.stringify({id, events, messages}, null, 2));
      await page.screenshot({path: resolve(work, 'gapminder-progress.png')});
    }
    if (approvals.length) { detail = 'Live agent stopped for approval: ' + JSON.stringify(approvals.at(-1).approval); break; }
    if (events.some(e => e.conv === id && e.ev?.type === 'agent_exit')) { detail = 'Agent exited before presenting the assignment; inspect the transcript.'; break; }
    if (messages.some(m => m.role === 'error')) { detail = 'Live agent error: ' + JSON.stringify(messages.filter(m => m.role === 'error')); break; }
    const ended = events.some(e => e.conv === id && e.ev?.type === 'stream_end' && e.ev?.msg_id !== 'ctx-refresh');
    if (ended && await page.getByRole('button', {name: 'Send', exact: true}).count()) {
      const tools = messages.filter(m => m.role === 'tool');
      const shown = tools.some(m => /show_document$/.test(m.body?.request?.name || '') && m.body?.status !== 'error');
      success = shown;
      detail = shown ? 'Live agent presented a deliverable; inspect transcript, document and trajectory screenshot for assignment quality.' : 'Live turn ended without presenting the required document. See transcript.';
      await writeFile(resolve(work, 'gapminder-transcript.json'), JSON.stringify({id, events, messages}, null, 2));
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  detail ??= 'Live agent exceeded the 25-minute acceptance deadline.';
  if (id) await invoke('agent_stop', {id});
  await page.screenshot({path: resolve(work, 'gapminder-final.png')});
} catch (error) { detail = String(error.stack ?? error); }
finally {
  await writeFile(resolve(work, 'gapminder-results.json'), JSON.stringify([{Id: 'T-G1', Test: 'Live Gapminder assignment', Status: success ? 'PASS' : 'FAIL', Detail: detail}], null, 2));
  console.log(detail);
  await browser.close();
}
process.exitCode = success ? 0 : 1;
