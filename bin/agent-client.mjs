import {randomUUID} from 'node:crypto';

export class AgentError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.details = details;
  }
}

async function limitedResponseText(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AgentError('RESPONSE_TOO_LARGE', 'Bridge response exceeds 4 MiB.');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function agentRequest(connection, kind, args = {}, options = {}) {
  const url = connection.url ?? process.env.PERFETTO_AGENT_URL ?? 'http://127.0.0.1:19400/api/agent/request';
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new AgentError('INVALID_URL', 'The agent bridge URL is invalid.');
  }
  if (parsedUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsedUrl.hostname)) {
    throw new AgentError('INVALID_URL', 'The agent bridge must use HTTP on a loopback address.');
  }
  const session = connection.session ?? process.env.PERFETTO_AGENT_SESSION;
  const token = connection.token ?? process.env.PERFETTO_AGENT_TOKEN;
  if (!session || !token) {
    throw new AgentError('NO_CONNECTION', 'Set PERFETTO_AGENT_SESSION and PERFETTO_AGENT_TOKEN from the browser collaboration panel.');
  }
  const timeout = kind === 'query' ? Math.min((args.timeout_ms ?? 30_000) + 10_000, 70_000) : 40_000;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: options.id ?? randomUUID(),
        kind,
        session,
        ...(options.expectedVersion === undefined ? {} : {expected_version: options.expectedVersion}),
        args,
      }),
      signal: AbortSignal.timeout(timeout),
      redirect: 'error',
    });
  } catch (error) {
    throw new AgentError('NETWORK_ERROR', `Could not reach the local Perfetto bridge: ${error.message}`);
  }
  const text = await limitedResponseText(response, 4 * 1024 * 1024);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AgentError('INVALID_RESPONSE', `Bridge returned HTTP ${response.status} with a non-JSON response.`);
  }
  if (!body.ok) {
    throw new AgentError(body.error?.code ?? `HTTP_${response.status}`, body.error?.message ?? 'Agent request failed.', body.error?.details);
  }
  return body;
}
