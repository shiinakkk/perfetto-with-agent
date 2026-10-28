import assert from 'node:assert/strict';
import test from 'node:test';
import {agentRequest} from '../bin/agent-client.mjs';

test('agent client refuses to send credentials to a remote URL', async () => {
  await assert.rejects(
    agentRequest({url: 'https://example.com/api', session: 'session', token: 'secret'}, 'state.get'),
    (error) => error.code === 'INVALID_URL' && !error.message.includes('secret'),
  );
});

test('agent client requires an explicitly authorized session and token', async () => {
  await assert.rejects(agentRequest({url: 'http://127.0.0.1:19400/api/agent/request', session: '', token: ''}, 'state.get'), /PERFETTO_AGENT_SESSION/);
});
