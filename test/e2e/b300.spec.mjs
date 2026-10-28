import {test, expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {agentRequest} from '../../bin/agent-client.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tracePath = process.env.PERFETTO_B300_TRACE ?? 'D:/looplm-forb/profiles/b300-clean-source-bs4-spec2-20261028/clean-source-decode-bs4-spec2-20261028-1793182201.9781592-TP-0-DP-0-EP-0.trace.json.gz';

test('B300 rank trace locates fused_rope, sparse_mla and combine through the real agent example', async ({page}, testInfo) => {
  test.setTimeout(240_000);
  test.skip(!existsSync(tracePath), 'Set PERFETTO_B300_TRACE to a local B300 trace to run this acceptance test');
  const originalHash = createHash('sha256').update(await readFile(tracePath)).digest('hex');
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.waitFor({state: 'attached'});
  await fileInput.setInputFiles(tracePath);
  const allowButton = page.getByRole('button', {name: 'Allow agent to connect'});
  await allowButton.waitFor({state: 'visible', timeout: 120_000});
  await allowButton.click();
  const downloadButton = page.getByRole('button', {name: 'Download connection.json'});
  await downloadButton.waitFor({state: 'visible'});
  const downloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const download = await downloadPromise;
  const connection = JSON.parse(await readFile(await download.path(), 'utf8'));

  const {stdout} = await exec(process.execPath, ['examples/b300-targets.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      PERFETTO_AGENT_URL: connection.request_url,
      PERFETTO_AGENT_SESSION: connection.session,
      PERFETTO_AGENT_TOKEN: connection.token,
    },
    maxBuffer: 1024 * 1024,
  });
  const demo = JSON.parse(stdout);
  expect(demo.ok).toBe(true);
  expect(demo.results.map((result) => result.pattern)).toEqual([
    'fused_rope', 'sparse_mla', 'deep_ep::legacy::internode_ll::combine',
  ]);
  for (const result of demo.results) {
    expect(result.slice_id).toMatch(/^\d+$/);
    expect(result.track_id).toMatch(/^\d+$/);
    expect(result.ts).toMatch(/^\d+$/);
    expect(result.dur).toMatch(/^\d+$/);
    expect(result.name.length).toBeGreaterThan(20);
  }

  const state = await agentRequest(connection, 'state.get');
  for (const label of ['mRoPE', 'sparse MLA', 'combine']) {
    expect(state.result.notes.some((note) => note.text.includes(label))).toBe(true);
  }
  expect(state.result.focus.kind).toBe('track_event');
  await writeFile(testInfo.outputPath('b300-demo-result.json'), `${JSON.stringify(demo, null, 2)}\n`);
  const view = await agentRequest(connection, 'state.export');
  await writeFile(testInfo.outputPath('b300-view.json'), `${JSON.stringify(view.result, null, 2)}\n`);
  await page.screenshot({path: testInfo.outputPath('b300-targets.png'), fullPage: true});
  await page.getByRole('button', {name: 'Disconnect agent'}).click();
  expect(pageErrors).toEqual([]);
  expect(createHash('sha256').update(await readFile(tracePath)).digest('hex')).toBe(originalHash);
});
