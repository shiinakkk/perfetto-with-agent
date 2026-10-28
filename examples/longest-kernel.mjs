import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {agentRequest} from '../bin/agent-client.mjs';

const args = process.argv.slice(2);
const connectionIndex = args.indexOf('--connection');
const connection = connectionIndex >= 0 ? JSON.parse(await readFile(path.resolve(args[connectionIndex + 1]), 'utf8')) : {};

let state = await agentRequest(connection, 'state.get');
let version = state.result.state_version;
const query = await agentRequest(connection, 'query', {
  sql: `SELECT id, ts, dur, name, track_id
        FROM slice
        WHERE dur > 0 AND INSTR(lower(COALESCE(category, '')), 'kernel') > 0
        ORDER BY dur DESC
        LIMIT 1`,
  max_rows: 1,
  timeout_ms: 30_000,
});
const row = query.result.rows[0];
if (!row) throw new Error('No kernel slice was found. Open the demo trace or adjust the kernel category query.');
const [idValue, tsValue, durValue, name] = row;
const id = String(idValue);
const ts = BigInt(tsValue);
const dur = BigInt(durValue);

state = await agentRequest(connection, 'state.get');
version = state.result.state_version;
const selected = await agentRequest(connection, 'selection.set', {slice_ids: [id]}, {expectedVersion: version});
version = selected.version;

const padding = dur / 5n > 0n ? dur / 5n : 1n;
const start = ts > padding ? ts - padding : 0n;
const end = ts + dur + padding;
const zoomed = await agentRequest(connection, 'viewport.set', {
  start: start.toString(),
  end: end.toString(),
}, {expectedVersion: version});
version = zoomed.version;

const noted = await agentRequest(connection, 'notes.add', {
  start: ts.toString(),
  end: (ts + dur).toString(),
  text: `Agent demo: longest kernel ${name} (${dur.toString()} ns)`,
  color: '#f9ab00',
}, {expectedVersion: version});

console.log(JSON.stringify({
  ok: true,
  kernel: {id, name, ts: ts.toString(), dur: dur.toString()},
  viewport: {start: start.toString(), end: end.toString()},
  note: noted.result,
  final_version: noted.version,
  undo: 'npm run agent -- undo',
}, null, 2));
