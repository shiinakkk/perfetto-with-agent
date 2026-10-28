import {defineConfig} from '@playwright/test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: path.join(root, 'test', 'e2e'),
  timeout: 180_000,
  expect: {timeout: 30_000},
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', {outputFile: path.join(root, 'test-results', 'e2e-results.json')}]],
  use: {
    baseURL: 'http://127.0.0.1:19400',
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge',
    headless: process.env.PLAYWRIGHT_HEADED !== '1',
    viewport: {width: 1440, height: 960},
    actionTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server/index.mjs --host 127.0.0.1 --port 19400',
    cwd: root,
    url: 'http://127.0.0.1:19400/api/health',
    timeout: 30_000,
    reuseExistingServer: true,
  },
});
