import assert from 'node:assert/strict';
import test from 'node:test';
import {isTrackVisible, resolveAliasEntry, showCpuTracks, validateAliasTargets} from '../plugin/trace_utils.ts';

function result(columns, rows) {
  let index = 0;
  return {
    columns: () => columns,
    iter: () => ({
      valid: () => index < rows.length,
      next: () => { index++; },
      get: (column) => rows[index][columns.indexOf(column)],
    }),
  };
}

test('CPU track expansion reveals the matching slice tracks and collapsed parents', async () => {
  const parent = {
    uri: '/thread_5', collapsed: true,
    reveal() { this.collapsed = false; },
    expand() { this.collapsed = false; },
  };
  const cpu = {
    uri: '/slice_2', collapsed: true, parent,
    reveal() { this.collapsed = false; parent.collapsed = false; },
    expand() { this.collapsed = false; },
  };
  parent.children = [cpu];
  const gpu = {uri: '/slice_9', collapsed: false, parent: undefined, reveal() {}, expand() {}};
  const trace = {
    currentWorkspace: {flatTracksOrdered: [parent, cpu, gpu]},
    tracks: {
      getTrack: (uri) => ({tags: {trackIds: uri === '/slice_2' ? [2] : [9]}}),
    },
    engine: {
      query: async () => result(['track_id'], [[2n], [3n], [4n], [5n], [8n]]),
    },
  };
  assert.equal(isTrackVisible(cpu), false);
  const visible = await showCpuTracks(trace);
  assert.equal(visible.available, 1);
  assert.equal(visible.visible, 1);
  assert.deepEqual(visible.track_uris, ['/slice_2']);
  assert.equal(parent.collapsed, false);
  assert.equal(cpu.collapsed, false);
  assert.equal(isTrackVisible(cpu), true);
});

test('alias resolution keeps raw name and timing while allowing a display alias', async () => {
  const trace = {
    selection: {resolveSqlEvents: async (_table, ids) => ids[0] === 3 ? [{trackUri: '/slice_2', eventId: 3}] : []},
    tracks: {getTrack: () => ({tags: {trackIds: [2]}})},
    engine: {
      query: async (sql) => result(
        ['id', 'track_id', 'ts', 'dur', 'name', 'depth'],
        sql.includes('id = 999') ? [] : [[3n, 2n, 100n, 20n, 'w8a16_kernel', 0n]],
      ),
    },
  };
  const entry = await resolveAliasEntry(trace, '3', 'FFN L1');
  assert.equal(entry.original_name, 'w8a16_kernel');
  assert.equal(entry.alias, 'FFN L1');
  assert.equal(entry.start, '100');
  assert.equal(entry.end, '120');
  await assert.doesNotReject(validateAliasTargets(trace, [entry]));
  await assert.rejects(validateAliasTargets(trace, [{...entry, original_name: 'wrong'}]), /metadata does not match/);
  await assert.rejects(resolveAliasEntry(trace, '999'), (error) => error.code === 'SLICE_NOT_FOUND');
});
