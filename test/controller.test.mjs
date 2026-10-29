import assert from 'node:assert/strict';
import test from 'node:test';
import {CollabController} from '../plugin/bridge.ts';

class FakeWebSocket {
  static OPEN = 1;
}

function setup(t, overrides = {}) {
  const storage = new Map();
  globalThis.WebSocket = FakeWebSocket;
  globalThis.window = {
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
  };
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  const data = {
    viewport: {start: '0', end: '10000'},
    focus: null,
    area: null,
    notes: [],
    aliases: [],
    layout: [{track_uri: 'gpu/7', collapsed: false, pinned: false}],
    tracks: [{uri: 'gpu/7', name: 'GPU stream 7', track_ids: ['7']}],
  };
  const adapter = {
    cancelled: 0,
    isReady: () => true,
    traceName: () => 'demo.json',
    snapshot: () => JSON.parse(JSON.stringify(data)),
    applyView(view) {
      for (const key of ['viewport', 'focus', 'area', 'notes', 'aliases', 'layout']) data[key] = JSON.parse(JSON.stringify(view[key]));
    },
    setViewport(start, end) { data.viewport = {start, end}; },
    center() {},
    zoomToSelection() {
      if (!data.focus) throw new Error('No selection');
      data.viewport = {start: '90', end: '210'};
    },
    async showCpuTracks() {
      data.layout[0].collapsed = false;
      data.tracks[0].is_cpu = true;
      data.tracks[0].visible = true;
      return {available: 1, visible: 1, expanded: 1, track_ids: ['7'], track_uris: ['gpu/7']};
    },
    async renameSelected() {},
    async setAlias(sliceId, alias) {
      const entry = {slice_id: sliceId, track_uri: 'gpu/7', start: '100', end: '200', original_name: 'w8a16', alias, depth: 0};
      data.aliases = [entry];
      return entry;
    },
    removeAlias(sliceId) {
      data.aliases = data.aliases.filter((entry) => entry.slice_id !== sliceId);
      return {removed: sliceId};
    },
    clearAliases() {
      const removed = data.aliases.length;
      data.aliases = [];
      return {removed};
    },
    selectSlices(ids) {
      if (ids.some((id) => !['1', '2'].includes(id))) throw new Error(`Slice ${ids[0]} does not exist`);
      data.focus = {kind: 'track_event', event_id: ids[0], track_uri: 'gpu/7'};
    },
    clearSelection() { data.focus = null; },
    setArea(start, end, trackUris) { data.area = {start, end, track_uris: trackUris}; },
    clearArea() { data.area = null; },
    setLayout(uri, action) {
      const track = data.layout.find((entry) => entry.track_uri === uri);
      if (!track) throw new Error('Unknown track');
      if (action === 'collapse') track.collapsed = true;
      if (action === 'expand') track.collapsed = false;
      if (action === 'pin') track.pinned = true;
      if (action === 'unpin') track.pinned = false;
    },
    resetLayout() { data.layout = data.layout.map((entry) => ({...entry, collapsed: false, pinned: false})); },
    addNote(note) {
      const saved = {...note, id: `note-${data.notes.length + 1}`};
      data.notes.push(saved);
      return saved;
    },
    updateNote(id, update) {
      const index = data.notes.findIndex((note) => note.id === id);
      if (index < 0) throw new Error('Unknown note');
      data.notes[index] = {...data.notes[index], ...update};
      return data.notes[index];
    },
    removeNote(id) {
      const index = data.notes.findIndex((note) => note.id === id);
      if (index < 0) throw new Error('Unknown note');
      data.notes.splice(index, 1);
    },
    query: overrides.query ?? (async () => ({columns: ['id', 'ts'], rows: [[1n, 90071992547409931234n]]})),
    cancelQuery() { this.cancelled++; },
  };
  const controller = new CollabController({adapter, fingerprint: 'a'.repeat(64), parserVersion: 'test'});
  const messages = [];
  controller.connection = {session: 'session-1', token: 'secret', request_url: 'http://local'};
  controller.socket = {readyState: 1, send: (message) => messages.push(JSON.parse(message)), close: () => {}};
  t.after(() => {
    controller.connection = undefined;
    controller.socket = undefined;
    controller.destroy();
  });
  async function request(kind, args = {}, expectedVersion, id = crypto.randomUUID()) {
    await controller.receive(JSON.stringify({id, kind, session: 'session-1', args, ...(expectedVersion === undefined ? {} : {expected_version: expectedVersion})}));
    return messages.at(-1);
  }
  return {controller, adapter, data, request, messages};
}

test('agent write, int64 query, persistence and one-step undo form a closed loop', async (t) => {
  const {controller, request} = await setup(t);
  const selected = await request('selection.set', {slice_ids: ['1']}, 0);
  assert.equal(selected.ok, true);
  assert.equal(selected.version, 1);
  const query = await request('query', {sql: 'SELECT id, ts FROM slice'});
  assert.equal(query.result.rows[0][1], '90071992547409931234');
  const noted = await request('notes.add', {start: '100', end: '200', text: 'investigate'}, 1);
  assert.equal(noted.version, 2);
  assert.equal(controller.canUndo(), true);
  const undone = await request('history.undo', {}, 2);
  assert.equal(undone.ok, true);
  assert.equal(undone.result.undone, true);
  assert.equal(controller.state().focus.event_id, '1');
  assert.equal(controller.state().notes.length, 0);
  assert.equal(controller.canUndo(), false);
  assert.ok([...globalThis.localStorage.getItem('perfetto-collab:v1:test:' + 'a'.repeat(64) + ':auto')].length > 0);
  const queryLog = controller.operationLogs().find((entry) => entry.kind === 'query');
  assert.equal(queryLog.row_count, 1);
  assert.ok(!JSON.stringify(controller.operationLogs()).includes('SELECT id'));
});

test('CPU expansion and operator aliases are versioned and undoable independently', async (t) => {
  const {controller, data, request} = setup(t);
  const cpu = await request('tracks.showCpu', {}, 0);
  assert.equal(cpu.result.visible, 1);
  assert.equal(cpu.version, 1);
  const aliased = await request('aliases.set', {slice_id: '3', alias: 'FFN L1'}, 1);
  assert.equal(aliased.result.original_name, 'w8a16');
  assert.equal(aliased.result.alias, 'FFN L1');
  assert.equal(aliased.version, 2);
  assert.equal(controller.state().cpu.visible, 1);
  const undone = await request('history.undo', {}, 2);
  assert.equal(undone.ok, true);
  assert.equal(data.aliases.length, 0);
  assert.equal(data.tracks[0].is_cpu, true);
});

test('concurrent view commands are rejected while an async write is in progress', async (t) => {
  const {controller, adapter, data, request} = setup(t);
  let finish;
  adapter.addNote = (note) => new Promise((resolve) => {
    finish = () => {
      const saved = {...note, id: 'note-async'};
      data.notes.push(saved);
      resolve(saved);
    };
  });
  const pending = request('notes.add', {start: '1', text: 'async'}, 0);
  await new Promise((resolve) => setImmediate(resolve));
  const busy = await request('viewport.set', {start: '0', end: '20'});
  assert.equal(busy.error.code, 'VIEW_BUSY');
  const busyState = await request('state.get');
  assert.equal(busyState.error.code, 'VIEW_BUSY');
  assert.equal(controller.saveLocal(true), false);
  finish();
  const completed = await pending;
  assert.equal(completed.ok, true);
  assert.equal(data.notes[0].id, 'note-async');
});

test('manual save is not overwritten by later automatic view saves', async (t) => {
  const {controller, data, request} = setup(t);
  await request('viewport.set', {start: '0', end: '200'}, 0);
  assert.equal(controller.saveLocal(true), true);
  await request('viewport.set', {start: '0', end: '300'});
  assert.equal(data.viewport.end, '300');
  await controller.restoreLocal();
  assert.deepEqual(data.viewport, {start: '0', end: '200'});
});

test('stale expected_version and user edits prevent blind overwrites', async (t) => {
  const {controller, data, request} = setup(t);
  assert.equal((await request('notes.add', {start: '1', text: 'agent'}, 0)).ok, true);
  data.notes[0].text = 'user edit';
  controller.refreshFromUser();
  assert.equal(controller.stateVersion(), 2);
  const undo = await request('history.undo', {}, 2);
  assert.equal(undo.ok, false);
  assert.equal(undo.error.code, 'UNDO_CONFLICT');
  assert.equal(data.notes[0].text, 'user edit');
  const stale = await request('viewport.set', {start: '0', end: '20'}, 0);
  assert.equal(stale.error.code, 'VERSION_CONFLICT');
  assert.deepEqual(data.viewport, {start: '0', end: '10000'});
});

test('invalid slices and write SQL return explicit errors without changing state', async (t) => {
  const {data, request} = setup(t);
  const missing = await request('selection.set', {slice_ids: ['999']}, 0);
  assert.equal(missing.ok, false);
  assert.equal(data.focus, null);
  const sql = await request('query', {sql: 'SELECT 1; SELECT 2'});
  assert.equal(sql.error.code, 'SQL_NOT_ALLOWED');
  const evalRequest = await request('eval', {code: 'alert(1)'});
  assert.equal(evalRequest.error.code, 'UNKNOWN_COMMAND');
});

test('query timeout requests cancellation and discards the late result', async (t) => {
  const {adapter, request} = setup(t, {query: () => new Promise(() => {})});
  const response = await request('query', {sql: 'SELECT 1', timeout_ms: 100});
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'QUERY_TIMEOUT');
  assert.equal(response.error.details.cancel_requested, true);
  assert.equal(adapter.cancelled, 1);
});

test('unsupported cancellation is explicit and a timed-out engine remains busy', async (t) => {
  const {adapter, request} = setup(t, {query: () => new Promise(() => {})});
  adapter.cancelQuery = undefined;
  const response = await request('query', {sql: 'SELECT 1', timeout_ms: 100});
  assert.equal(response.error.code, 'QUERY_TIMEOUT');
  assert.equal(response.error.details.cancel_requested, false);
  assert.equal(response.error.details.underlying_query_may_run, true);
  const busy = await request('query', {sql: 'SELECT 1', timeout_ms: 100});
  assert.equal(busy.error.code, 'QUERY_BUSY');
});
