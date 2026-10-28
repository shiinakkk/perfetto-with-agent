import {test, expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AgentError, agentRequest} from '../../bin/agent-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tracePath = path.join(root, 'examples', 'demo-trace.json');

async function expectAgentError(promise, code) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected agent request to fail with ${code}`);
}

test('official local Perfetto completes the authorized agent workflow without remote requests', async ({page}, testInfo) => {
  const originalHash = createHash('sha256').update(await readFile(tracePath)).digest('hex');
  const remoteRequests = [];
  const pageErrors = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
      remoteRequests.push(request.url());
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.waitFor({state: 'attached'});
  await fileInput.setInputFiles(tracePath);
  const allowButton = page.getByRole('button', {name: 'Allow agent to connect'});
  await allowButton.waitFor({state: 'visible', timeout: 90_000});
  await expect(page.locator('#perfetto-collab-panel')).toContainText('not authorized');

  const downloadPromise = page.waitForEvent('download');
  await allowButton.click();
  const downloadButton = page.getByRole('button', {name: 'Download connection.json'});
  await downloadButton.waitFor({state: 'visible'});
  await downloadButton.click();
  const download = await downloadPromise;
  const connection = JSON.parse(await readFile(await download.path(), 'utf8'));

  let state = await agentRequest(connection, 'state.get');
  expect(state.result.trace.fingerprint).toBe(originalHash);
  expect(state.result.trace.name).toContain('demo-trace.json');
  expect(state.result.agent_connected).toBe(true);

  const precise = await agentRequest(connection, 'query', {sql: 'SELECT 9007199254740993 AS ts', max_rows: 1});
  expect(precise.result.rows[0][0]).toBe('9007199254740993');

  const limited = await agentRequest(connection, 'query', {
    sql: 'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n < 100) SELECT n FROM x',
    max_rows: 10,
  });
  expect(limited.result.rows).toHaveLength(10);
  expect(limited.result.truncated).toBe(true);

  const overlapSql = (sameTrack) => `SELECT a.id AS a_id, a.track_id AS a_track, b.id AS b_id, b.track_id AS b_track
    FROM slice a JOIN slice b ON a.id < b.id AND a.track_id ${sameTrack ? '=' : '<>'} b.track_id
      AND a.ts < b.ts + b.dur AND b.ts < a.ts + a.dur
    WHERE a.dur > 0 AND b.dur > 0
      AND INSTR(lower(COALESCE(a.category, '')), 'kernel') > 0
      AND INSTR(lower(COALESCE(b.category, '')), 'kernel') > 0 LIMIT 5`;
  const crossTrackOverlap = await agentRequest(connection, 'query', {sql: overlapSql(false), max_rows: 5});
  expect(crossTrackOverlap.result.rows.length).toBeGreaterThan(0);
  expect(crossTrackOverlap.result.rows[0][1]).not.toBe(crossTrackOverlap.result.rows[0][3]);
  const sameTrackOverlap = await agentRequest(connection, 'query', {sql: overlapSql(true), max_rows: 5});
  expect(sameTrackOverlap.result.rows).toHaveLength(0);

  const query = await agentRequest(connection, 'query', {
    sql: "SELECT id, ts, dur, name, track_id FROM slice WHERE dur > 0 AND INSTR(lower(COALESCE(category, '')), 'kernel') > 0 ORDER BY dur DESC LIMIT 1",
    max_rows: 1,
  });
  expect(query.result.rows).toHaveLength(1);
  const [sliceId, tsValue, durValue, name] = query.result.rows[0].map(String);
  expect(name).toBe('sparse MLA');
  const ts = BigInt(tsValue);
  const dur = BigInt(durValue);

  const write = async (kind, args = {}) => {
    const current = await agentRequest(connection, 'state.get');
    return agentRequest(connection, kind, args, {expectedVersion: current.result.state_version});
  };

  const selected = await write('selection.set', {slice_ids: [sliceId]});
  expect(selected.result.slice_ids).toEqual([sliceId]);
  state = await agentRequest(connection, 'state.get');
  expect(state.result.focus.kind).toBe('track_event');
  const trackUri = state.result.focus.track_uri;
  expect(trackUri).toBeTruthy();

  const padding = dur / 5n > 0n ? dur / 5n : 1n;
  const viewport = {
    start: (ts > padding ? ts - padding : 0n).toString(),
    end: (ts + dur + padding).toString(),
  };
  await write('viewport.set', viewport);
  state = await agentRequest(connection, 'state.get');
  expect(state.result.viewport).toEqual(viewport);

  const noteText = 'E2E: longest sparse MLA kernel';
  const noted = await write('notes.add', {
    start: ts.toString(),
    end: (ts + dur).toString(),
    text: noteText,
    color: '#f9ab00',
  });
  const noteId = noted.result.id;
  expect(noteId).toBeTruthy();
  const exported = await agentRequest(connection, 'state.export');
  expect(exported.result.notes.some((note) => note.id === noteId && note.text === noteText)).toBe(true);

  await write('area.set', {...viewport, track_uris: [trackUri]});
  state = await agentRequest(connection, 'state.get');
  expect(state.result.area.track_uris).toEqual([trackUri]);

  await write('layout.set', {track_uri: trackUri, action: 'pin'});
  state = await agentRequest(connection, 'state.get');
  expect(state.result.layout.find((entry) => entry.track_uri === trackUri)?.pinned).toBe(true);

  await write('notes.update', {id: noteId, text: 'updated by agent'});
  await write('history.undo');
  state = await agentRequest(connection, 'state.get');
  expect(state.result.notes.find((note) => note.id === noteId)?.text).toBe(noteText);

  await page.getByRole('button', {name: 'Save', exact: true}).click();
  const savedViewport = state.result.viewport;
  await write('viewport.set', {start: '0', end: '1000000'});
  await page.getByRole('button', {name: 'Restore saved'}).click();
  await expect(page.locator('#perfetto-collab-panel')).toContainText('Saved view restored.');
  state = await agentRequest(connection, 'state.get');
  expect(state.result.viewport).toEqual(savedViewport);

  await write('state.import', {view: exported.result});
  state = await agentRequest(connection, 'state.get');
  expect(state.result.focus.kind).toBe('track_event');
  expect(state.result.focus.track_uri).toBe(trackUri);
  expect(state.result.notes.find((note) => note.id === noteId)?.text).toBe(noteText);

  const currentVersion = state.result.state_version;
  await expectAgentError(agentRequest(connection, 'viewport.set', {start: '0', end: '10'}, {expectedVersion: currentVersion - 1}), 'VERSION_CONFLICT');
  await expectAgentError(agentRequest(connection, 'selection.set', {slice_ids: ['999999999']}), 'SLICE_NOT_FOUND');
  await expectAgentError(agentRequest(connection, 'query', {sql: 'SELECT 1; SELECT 2'}), 'SQL_NOT_ALLOWED');
  await expectAgentError(agentRequest(connection, 'query', {sql: 'SELECT * FROM table_that_does_not_exist'}), 'QUERY_FAILED');

  await page.screenshot({path: testInfo.outputPath('agent-selected-annotated.png'), fullPage: true});

  await page.mouse.move(550, 420);
  await page.keyboard.press('d');
  await page.waitForTimeout(800);
  await page.mouse.wheel(400, 0);
  await page.waitForTimeout(800);
  const afterUser = await agentRequest(connection, 'state.get');
  expect(afterUser.result.state_version).toBeGreaterThan(currentVersion);
  await expectAgentError(agentRequest(connection, 'history.undo'), 'UNDO_CONFLICT');

  const logs = await agentRequest(connection, 'history.list');
  expect(logs.result.length).toBeGreaterThan(3);
  expect(JSON.stringify(logs.result)).not.toContain('SELECT id, ts');

  await page.getByRole('button', {name: 'Disconnect agent'}).click();
  await expectAgentError(agentRequest(connection, 'state.get'), 'UNAUTHORIZED');

  await allowButton.click();
  await downloadButton.waitFor({state: 'visible'});
  const secondDownloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const secondDownload = await secondDownloadPromise;
  const secondConnection = JSON.parse(await readFile(await secondDownload.path(), 'utf8'));
  const otherTracePath = testInfo.outputPath('other-demo-trace.json');
  await writeFile(otherTracePath, await readFile(tracePath));
  await fileInput.setInputFiles(otherTracePath);
  await expect.poll(async () => {
    try {
      await agentRequest(secondConnection, 'state.get');
      return 'STILL_CONNECTED';
    } catch (error) {
      return error.code;
    }
  }).toBe('UNAUTHORIZED');
  await allowButton.waitFor({state: 'visible', timeout: 90_000});

  expect(remoteRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(createHash('sha256').update(await readFile(tracePath)).digest('hex')).toBe(originalHash);
});
