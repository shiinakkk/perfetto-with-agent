import {access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCollabServer} from './app.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argument(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const host = argument('--host', process.env.PERFETTO_HOST ?? '127.0.0.1');
const port = Number(argument('--port', process.env.PERFETTO_PORT ?? '19400'));
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error('Refusing a non-loopback host. Use 127.0.0.1, localhost, or ::1.');
  process.exit(2);
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  console.error('Invalid port.');
  process.exit(2);
}
const uiDir = path.resolve(argument('--ui', process.env.PERFETTO_UI_DIR ??
  path.join(projectRoot, 'ui-dist')));
try {
  await access(path.join(uiDir, 'index.html'));
} catch {
  console.error(`Perfetto UI was not found at:\n  ${uiDir}\n\nRun npm run build first, or pass --ui <directory>.`);
  process.exit(1);
}

const {server} = createCollabServer({
  uiDir,
  host,
  port,
  logger(event) {
    console.log(JSON.stringify({time: new Date().toISOString(), ...event}));
  },
});
server.listen(port, host, () => {
  console.log(`Perfetto local collaboration is ready: http://${host === '::1' ? '[::1]' : host}:${port}/`);
  console.log('Trace files are opened only through the browser file picker.');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
