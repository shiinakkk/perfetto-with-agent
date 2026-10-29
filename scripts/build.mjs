import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(root, 'upstream', 'perfetto');
const revision = JSON.parse(readFileSync(path.join(root, 'upstream-revision.json'), 'utf8'));
const pluginId = 'dev.perfetto.LocalCollab';
const args = process.argv.slice(2);
const skipDeps = args.includes('--skip-deps') || process.env.PERFETTO_SKIP_BUILD_DEPS === '1';

if (!existsSync(path.join(upstream, 'ui', 'build'))) {
  console.error(`Official Perfetto source is not available at ${upstream}`);
  process.exit(1);
}

const pluginSource = path.join(root, 'plugin');
const pluginTarget = path.join(upstream, 'ui', 'src', 'plugins', pluginId);
mkdirSync(pluginTarget, {recursive: true});
for (const name of [
  'index.ts', 'bridge.ts', 'core.ts', 'fingerprint.ts', 'panel.ts',
  'perfetto_adapter.ts', 'aliases.ts', 'trace_utils.ts', 'upstream_version.ts',
]) {
  copyFileSync(path.join(pluginSource, name), path.join(pluginTarget, name));
}
writeFileSync(path.join(pluginTarget, 'upstream_version.ts'), `export const UPSTREAM_PARSER_VERSION = 'perfetto-${revision.commit}';\n`);

const frontendFile = path.join(upstream, 'ui', 'src', 'frontend', 'index.ts');
let frontend = readFileSync(frontendFile, 'utf8').replaceAll('\r\n', '\n');
const patches = [
  {
    from: 'pluginManager.activatePlugins(app, overrides);',
    to: `pluginManager.activatePlugins(app, [...overrides, '${pluginId}']);`,
  },
  {
    from: "      'https://www.googletagmanager.com',\n",
    to: '      // Local collaboration: remote scripts are disabled.\n',
  },
  {
    from: "      'https:', // Allow any HTTPS; service worker firewall adds granular filtering.\n",
    to: '      // Local collaboration: remote HTTPS connections are disabled.\n',
  },
  {
    from: "      'https://*.google-analytics.com',\n      'https://www.googletagmanager.com',\n      'https://*.googleapis.com',\n",
    to: '      // Local collaboration: remote images are disabled.\n',
  },
  {
    from: '    defaultValue: true,\n    requiresReload: true,',
    to: '    defaultValue: false, // Local collaboration: telemetry defaults off.\n    requiresReload: true,',
  },
  {
    from: '  app.analytics.initialize();',
    to: '  // Local collaboration: telemetry is never initialized.',
  },
  {
    from: '  AppImpl.instance.serviceWorkerController.install();',
    to: '  // Local collaboration: no service worker or remote update channel.',
  },
];
for (const patch of patches) {
  if (frontend.includes(patch.to)) continue;
  if (!frontend.includes(patch.from)) {
    console.error(`Could not apply a required local patch in ${frontendFile}:\n${patch.from}`);
    process.exit(1);
  }
  frontend = frontend.replace(patch.from, patch.to);
}
writeFileSync(frontendFile, frontend);

function run(command, commandArgs, options = {}) {
  console.log(`\n+ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {cwd: upstream, stdio: 'inherit', ...options});
  return result.status === 0;
}

function nativeBuild() {
  console.log('Trying the official native Windows UI build...');
  if (!skipDeps && !run('python', ['tools/install-build-deps', '--ui'])) return false;
  return run('bash', ['ui/build']);
}

function wslBuild() {
  if (process.platform !== 'win32') return false;
  const distro = process.env.PERFETTO_WSL_DISTRO ?? 'Ubuntu-22.04';
  const drivePath = /^([A-Za-z]):[\\/](.*)$/.exec(upstream);
  if (!drivePath) {
    console.error(`Cannot map the workspace to a WSL path: ${upstream}`);
    return false;
  }
  const wslPath = `/mnt/${drivePath[1].toLowerCase()}/${drivePath[2].replaceAll('\\', '/')}`;
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const commands = [`cd ${quote(wslPath)}`];
  if (!skipDeps) commands.push('python3 tools/install-build-deps --ui');
  commands.push('./ui/build');
  console.log(`Trying the official UI build in WSL2 (${distro})...`);
  return run('wsl.exe', ['-d', distro, '--', 'bash', '-lc', commands.join(' && ')]);
}

let buildHost;
if (!args.includes('--wsl-only') && nativeBuild()) buildHost = 'windows-native';
if (!buildHost && !args.includes('--native-only') && wslBuild()) buildHost = 'wsl2';
if (!buildHost) {
  console.error('Perfetto UI build failed on the available build paths. See the compiler output above.');
  process.exit(1);
}

const candidates = [
  path.join(upstream, 'out', 'ui', 'ui', 'dist'),
  path.join(upstream, 'ui', 'out', 'dist'),
];
const uiDir = candidates.find((candidate) => existsSync(path.join(candidate, 'index.html')));
if (!uiDir) {
  console.error('The build command returned success but no UI index.html was found.');
  process.exit(1);
}
const manifest = {
  upstream: revision.repository,
  commit: revision.commit,
  plugin: pluginId,
  buildHost,
  builtAt: new Date().toISOString(),
  uiDir,
  node: process.version,
};
writeFileSync(path.join(root, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nLocal Perfetto UI built successfully: ${uiDir}`);
console.log('Start it with .\\start.ps1 or npm start.');
