import {test, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AgentError, agentRequest} from '../../bin/agent-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tracePath = path.join(root, 'examples', 'demo-trace.json');

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected ${code}`);
}

test('a real engine query reports timeout, remains busy, and is revoked by tab close', async ({page}, testInfo) => {
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

  const timeout = await expectCode(agentRequest(connection, 'query', {
    sql: 'WITH RECURSIVE x(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM x WHERE n < 100000000) SELECT count(*) FROM x',
    max_rows: 1,
    timeout_ms: 100,
  }), 'QUERY_TIMEOUT');
  expect(timeout.details.cancel_requested).toBe(false);
  expect(timeout.details.underlying_query_may_run).toBe(true);
  await expectCode(agentRequest(connection, 'query', {sql: 'SELECT 1', timeout_ms: 1000}), 'QUERY_BUSY');
  await page.screenshot({path: testInfo.outputPath('query-timeout.png'), fullPage: true});
  expect(pageErrors).toEqual([]);

  await page.close();
  await expect.poll(async () => {
    try {
      await agentRequest(connection, 'state.get');
      return 'STILL_CONNECTED';
    } catch (error) {
      return error.code;
    }
  }).toBe('UNAUTHORIZED');
});
