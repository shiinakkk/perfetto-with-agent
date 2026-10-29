import {test, expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {agentRequest} from '../../bin/agent-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tracePath = path.join(root, 'examples', 'alias-demo-trace.json');

test('CPU tracks auto-expand and w8a16 can be renamed directly in the timeline', async ({page}, testInfo) => {
  const originalHash = createHash('sha256').update(await readFile(tracePath)).digest('hex');
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.waitFor({state: 'attached'});
  await fileInput.setInputFiles(tracePath);
  const allowButton = page.getByRole('button', {name: 'Allow agent to connect'});
  await allowButton.waitFor({state: 'visible', timeout: 90_000});
  await allowButton.click();
  const downloadButton = page.getByRole('button', {name: 'Download connection.json'});
  await downloadButton.waitFor({state: 'visible'});
  const downloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const download = await downloadPromise;
  const connection = JSON.parse(await readFile(await download.path(), 'utf8'));

  const write = async (kind, args = {}) => {
    const current = await agentRequest(connection, 'state.get');
    return agentRequest(connection, kind, args, {expectedVersion: current.result.state_version});
  };

  let state = await agentRequest(connection, 'state.get');
  expect(state.result.cpu.available).toBeGreaterThan(0);
  expect(state.result.cpu.visible).toBe(state.result.cpu.available);
  const cpuTrack = state.result.tracks.find((track) => track.is_cpu);
  expect(cpuTrack).toBeTruthy();
  const cpuLayout = state.result.layout.find((entry) => entry.track_uri === cpuTrack.uri);
  const parent = state.result.layout.find((entry) =>
    entry.track_uri !== cpuTrack.uri &&
    Array.isArray(entry.path) && Array.isArray(cpuLayout.path) &&
    entry.path.join('|') === cpuLayout.path.slice(0, -1).join('|'));
  expect(parent).toBeTruthy();
  await write('layout.set', {track_uri: parent.track_uri, action: 'collapse'});
  state = await agentRequest(connection, 'state.get');
  expect(state.result.cpu.visible).toBeLessThan(state.result.cpu.available);
  await write('tracks.showCpu');
  state = await agentRequest(connection, 'state.get');
  expect(state.result.cpu.visible).toBe(state.result.cpu.available);

  const queried = await agentRequest(connection, 'query', {
    sql: "SELECT id, ts, dur, name, track_id FROM slice WHERE INSTR(name, 'w8a16') > 0 ORDER BY id",
    max_rows: 10,
  });
  expect(queried.result.rows).toHaveLength(2);
  const [sliceId, ts, dur, originalName] = queried.result.rows[0].map(String);
  expect(originalName).toBe('w8a16_kernel/gate_up_proj');
  await write('selection.set', {slice_ids: [sliceId]});
  await write('aliases.set', {slice_id: sliceId, alias: 'FFN L1'});
  state = await agentRequest(connection, 'state.get');
  expect(state.result.aliases).toHaveLength(1);
  expect(state.result.aliases[0].original_name).toBe(originalName);
  expect(state.result.aliases[0].alias).toBe('FFN L1');
  const rawAfterAgent = await agentRequest(connection, 'query', {sql: `SELECT name FROM slice WHERE id = ${sliceId}`, max_rows: 1});
  expect(rawAfterAgent.result.rows[0][0]).toBe(originalName);

  const geometry = await page.evaluate(() => {
    const trace = window.app.trace;
    const visible = trace.timeline.visibleWindow;
    const selection = trace.selection.selection;
    const candidates = Array.from(document.querySelectorAll('canvas')).map((canvas) => ({canvas, rect: canvas.getBoundingClientRect()}))
      .filter((item) => item.rect.width > 500)
      .sort((a, b) => b.rect.width - a.rect.width);
    const shellWidth = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--track-shell-width'));
    return {
      start: visible.start.integral.toString(),
      fractional: visible.start.fractional,
      duration: visible.duration,
      selectedTs: selection.ts.toString(),
      left: candidates[0].rect.left,
      width: candidates[0].rect.width,
      shellWidth,
    };
  });
  const x = geometry.left + geometry.shellWidth +
    (Number(BigInt(geometry.selectedTs) - BigInt(geometry.start)) - geometry.fractional) /
    (geometry.duration / (geometry.width - geometry.shellWidth));
  const trackLabel = page.getByText(/GPU stream 1/).first();
  const labelBox = await trackLabel.boundingBox();
  expect(labelBox).not.toBeNull();
  const clickY = labelBox.y + labelBox.height / 2;
  await page.mouse.dblclick(x, clickY);
  const editor = page.locator('.pc-alias-editor');
  await expect(editor).toBeVisible();
  const input = editor.getByRole('textbox', {name: 'Operator display alias'});
  await expect(input).toHaveValue('FFN L1');
  await page.screenshot({path: testInfo.outputPath('alias-editor.png'), fullPage: true});
  await input.fill('FFN Layer 1');
  await input.press('Enter');
  await expect(editor).toHaveCount(0);
  state = await agentRequest(connection, 'state.get');
  expect(state.result.aliases[0].alias).toBe('FFN Layer 1');
  expect(state.result.aliases[0].original_name).toBe(originalName);

  const exported = await agentRequest(connection, 'state.export');
  await write('aliases.clear');
  state = await agentRequest(connection, 'state.get');
  expect(state.result.aliases).toHaveLength(0);
  await write('state.import', {view: exported.result});
  state = await agentRequest(connection, 'state.get');
  expect(state.result.aliases[0].alias).toBe('FFN Layer 1');

  await write('aliases.remove', {slice_id: sliceId});
  state = await agentRequest(connection, 'state.get');
  expect(state.result.aliases).toHaveLength(0);
  await write('history.undo');
  state = await agentRequest(connection, 'state.get');
  expect(state.result.aliases[0].alias).toBe('FFN Layer 1');
  const rawAtEnd = await agentRequest(connection, 'query', {sql: `SELECT name FROM slice WHERE id = ${sliceId}`, max_rows: 1});
  expect(rawAtEnd.result.rows[0][0]).toBe(originalName);
  await page.screenshot({path: testInfo.outputPath('alias-on-timeline.png'), fullPage: true});

  await page.getByRole('button', {name: 'Disconnect agent'}).click();
  expect(pageErrors).toEqual([]);
  expect(createHash('sha256').update(await readFile(tracePath)).digest('hex')).toBe(originalHash);
});
