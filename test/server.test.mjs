import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {WebSocket} from 'ws';
import {createCollabServer} from '../server/app.mjs';
import {SessionHub, secretEqual, validateRequest} from '../server/session-hub.mjs';

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const {port} = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function fixture(t) {
  const port = await freePort();
  const uiDir = await mkdtemp(path.join(os.tmpdir(), 'perfetto-collab-test-'));
  await writeFile(path.join(uiDir, 'index.html'), '<!doctype html><title>Perfetto test</title>');
  const {server, hub} = createCollabServer({uiDir, port});
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    for (const id of [...hub.sessions.keys()]) hub.revoke(id);
    await new Promise((resolve) => server.close(resolve));
    await rm(uiDir, {recursive: true, force: true});
  });
  return {port, origin, hub};
}

async function createSession(origin, meta = {traceName: 'test.pftrace', traceFingerprint: 'abc123'}) {
  const response = await fetch(`${origin}/api/browser/sessions`, {
    method: 'POST',
    headers: {Origin: origin, 'Content-Type': 'application/json'},
    body: JSON.stringify(meta),
  });
  assert.equal(response.status, 201);
  return response.json();
}

function connectBrowser(origin, session) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/ws/browser?session=${session.session}&token=${encodeURIComponent(session.token)}`, {origin});
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function agent(origin, session, kind = 'state.get', args = {}, token = session.token) {
  const response = await fetch(`${origin}/api/agent/request`, {
    method: 'POST',
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({id: crypto.randomUUID(), kind, session: session.session, args}),
  });
  return {status: response.status, body: await response.json()};
}

test('serves the local UI with isolation headers and validates Host', async (t) => {
  const {origin} = await fixture(t);
  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Perfetto test/);
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = http.request(`${origin}/api/health`, {headers: {Host: 'example.com'}}, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(badHostStatus, 403);
});

test('requires same-origin authorization and rejects credentials before browser connection', async (t) => {
  const {origin} = await fixture(t);
  const crossOrigin = await fetch(`${origin}/api/browser/sessions`, {
    method: 'POST',
    headers: {Origin: 'https://example.com', 'Content-Type': 'application/json'},
    body: '{}',
  });
  assert.equal(crossOrigin.status, 403);
  const session = await createSession(origin);
  assert.ok(session.token.length >= 43);
  const disconnected = await agent(origin, session);
  assert.equal(disconnected.status, 409);
  assert.equal(disconnected.body.error.code, 'BROWSER_DISCONNECTED');
  const denied = await agent(origin, session, 'state.get', {}, 'wrong-token');
  assert.equal(denied.status, 401);
});

test('forwards structured commands and preserves int64 strings', async (t) => {
  const {origin} = await fixture(t);
  const session = await createSession(origin);
  const socket = await connectBrowser(origin, session);
  t.after(() => socket.close());
  socket.on('message', (data) => {
    const request = JSON.parse(data.toString());
    socket.send(JSON.stringify({
      id: request.id,
      ok: true,
      version: 7,
      result: request.kind === 'state.get' ? {trace: {id: 'abc123'}, version: 7} : {
        columns: ['id', 'ts', 'dur'],
        rows: [['1', '90071992547409931234', '18446744073709551615']],
        truncated: false,
      },
    }));
  });
  const state = await agent(origin, session);
  assert.equal(state.body.ok, true);
  assert.equal(state.body.version, 7);
  const query = await agent(origin, session, 'query', {sql: 'SELECT id, ts, dur FROM slice', max_rows: 10});
  assert.equal(query.body.result.rows[0][1], '90071992547409931234');
  assert.equal(query.body.result.rows[0][2], '18446744073709551615');
  const rejected = await agent(origin, session, 'eval', {code: 'alert(1)'});
  assert.equal(rejected.body.error.code, 'UNKNOWN_COMMAND');
});

test('revokes credentials immediately when the authorized tab disconnects', async (t) => {
  const {origin, hub} = await fixture(t);
  const session = await createSession(origin);
  const socket = await connectBrowser(origin, session);
  assert.equal(hub.sessions.size, 1);
  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hub.sessions.size, 0);
  const denied = await agent(origin, session);
  assert.equal(denied.status, 401);
});

test('isolates multiple authorized tabs and revokes only the disconnected one', async (t) => {
  const {origin} = await fixture(t);
  const first = await createSession(origin, {traceName: 'first', traceFingerprint: 'a'.repeat(64)});
  const second = await createSession(origin, {traceName: 'second', traceFingerprint: 'b'.repeat(64)});
  const firstSocket = await connectBrowser(origin, first);
  const secondSocket = await connectBrowser(origin, second);
  firstSocket.on('message', (data) => {
    const request = JSON.parse(data.toString());
    firstSocket.send(JSON.stringify({id: request.id, ok: true, version: 1, result: {trace: 'first'}}));
  });
  const mixed = await agent(origin, first, 'state.get', {}, second.token);
  assert.equal(mixed.status, 401);
  secondSocket.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const remaining = await agent(origin, first);
  assert.equal(remaining.body.ok, true);
  assert.equal(remaining.body.result.trace, 'first');
  firstSocket.close();
});

test('validates requests and compares credentials using fixed-size digests', () => {
  assert.equal(secretEqual('abc', 'abc'), true);
  assert.equal(secretEqual('abc', 'abd'), false);
  assert.equal(secretEqual(undefined, 'abc'), false);
  const session = new SessionHub().create({}, 'http://127.0.0.1:19400');
  assert.throws(() => validateRequest({id: '1', kind: 'query', session: session.id, args: {sql: 'select 1', max_rows: 10000}}, session.id), /max_rows/);
  assert.throws(() => validateRequest({id: '1', kind: 'state.get', session: 'stale', args: {}}, session.id), /does not match/);
});
