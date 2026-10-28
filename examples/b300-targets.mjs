import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {agentRequest} from '../bin/agent-client.mjs';

const args = process.argv.slice(2);
const connectionIndex = args.indexOf('--connection');
const connection = connectionIndex >= 0 ? JSON.parse(await readFile(path.resolve(args[connectionIndex + 1]), 'utf8')) : {};
const targets = [
  {label: 'mRoPE implementation (fused_rope)', pattern: 'fused_rope', color: '#1a73e8'},
  {label: 'sparse MLA', pattern: 'sparse_mla', color: '#188038'},
  {label: 'combine', pattern: 'deep_ep::legacy::internode_ll::combine', color: '#f9ab00'},
];

async function write(kind, args) {
  const state = await agentRequest(connection, 'state.get');
  return agentRequest(connection, kind, args, {expectedVersion: state.result.state_version});
}

const results = [];
for (const target of targets) {
  const pattern = target.pattern.toLowerCase();
  const query = await agentRequest(connection, 'query', {
    sql: `SELECT id, ts, dur, name, track_id FROM slice
          WHERE dur > 0 AND INSTR(lower(name), '${pattern}') > 0
          ORDER BY dur DESC LIMIT 1`,
    max_rows: 1,
  });
  const row = query.result.rows[0];
  if (!row) throw new Error(`No slice matched ${target.pattern}`);
  const [idValue, tsValue, durValue, name, trackId] = row;
  const id = String(idValue);
  const ts = BigInt(tsValue);
  const dur = BigInt(durValue);
  const padding = dur / 2n > 0n ? dur / 2n : 1000n;
  const start = ts > padding ? ts - padding : 0n;
  const end = ts + dur + padding;

  await write('selection.set', {slice_ids: [id]});
  await write('viewport.set', {start: start.toString(), end: end.toString()});
  const noted = await write('notes.add', {
    start: ts.toString(),
    end: (ts + dur).toString(),
    text: `B300 target: ${target.label}\n${name}`,
    color: target.color,
  });
  results.push({
    target: target.label,
    pattern: target.pattern,
    slice_id: id,
    track_id: String(trackId),
    ts: ts.toString(),
    dur: dur.toString(),
    name,
    note_id: noted.result.id,
    final_version: noted.version,
  });
}

console.log(JSON.stringify({ok: true, results, undo: 'Only the most recent agent write can be undone with agent.ps1 undo'}, null, 2));
