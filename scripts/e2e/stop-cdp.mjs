import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
const root = resolve(import.meta.dirname, '../..');
const { chromium } = createRequire(resolve(root, 'vendor/playwright/node_modules/playwright-core/package.json'))('playwright-core');
const [endpoint, work] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0].pages().find(p => p.url().includes('tauri.localhost'));
const invoke = (cmd, args) => page.evaluate(({cmd, args}) => window.__TAURI_INTERNALS__.invoke(cmd, args), {cmd, args});
const results = [];
let id;
try {
  await invoke('set_setting', {key: 'wizard_done', value: '1'});
  id = await invoke('create_conversation', {workspace: work});
  await page.reload();
  await page.getByTitle(work, {exact: true}).click();
  await page.evaluate(async () => {
    window.__stopEvents = [];
    await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {event: 'agent-event', target: {kind: 'Any'}, handler: window.__TAURI_INTERNALS__.transformCallback(e => window.__stopEvents.push(e.payload))});
  });
  const message = page.getByRole('textbox', {name: 'Message', exact: true});
  await message.fill('E2E_STOP_STREAM');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await page.getByText('Fixture reply', {exact: false}).first().waitFor({timeout: 15000});
  const before = Date.now();
  await page.getByRole('button', {name: 'Stop', exact: true}).click();
  await page.getByRole('button', {name: 'Send', exact: true}).waitFor({timeout: 5000});
  assert.ok(Date.now() - before < 5000, 'Stop must release the composer within five seconds');
  await message.fill('E2E_AFTER_STOP');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await page.waitForFunction(async id => (await window.__TAURI_INTERNALS__.invoke('load_messages', {id})).filter(m => m.role === 'assistant').length >= 2, id, {timeout: 15000});
  await page.getByRole('button', {name: 'Send', exact: true}).waitFor({timeout: 15000});
  results.push({Id: 'T-A2', Test: 'Stop is bounded and a new turn works', Status: 'PASS', Detail: 'Real bundled agent and MCP session with deliberately slow deterministic inference'});
} catch (error) {
  results.push({Id: 'T-A2', Test: 'Stop is bounded and a new turn works', Status: 'FAIL', Detail: String(error.stack ?? error)});
  await page.screenshot({path: resolve(work, 'stop-failure.png')});
  await writeFile(resolve(work, 'stop-events.json'), JSON.stringify(await page.evaluate(() => window.__stopEvents), null, 2));
}
finally {
  if (id) await invoke('delete_conversation', {id}).catch(() => {});
  await writeFile(resolve(work, 'stop-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  await browser.close();
}
process.exitCode = results.some(r => r.Status === 'FAIL') ? 1 : 0;
