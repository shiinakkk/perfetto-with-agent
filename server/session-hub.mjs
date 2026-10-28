import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {WebSocket} from 'ws';

export const MAX_MESSAGE_BYTES = 3 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 3 * 1024 * 1024;

const COMMAND_KINDS = new Set([
  'state.get',
  'state.export',
  'state.import',
  'viewport.set',
  'viewport.center',
  'viewport.zoomToSelection',
  'selection.set',
  'selection.clear',
  'area.set',
  'area.clear',
  'layout.set',
  'layout.reset',
  'notes.add',
  'notes.update',
  'notes.remove',
  'query',
  'query.cancel',
  'history.undo',
  'history.list',
]);

export class BridgeError extends Error {
  constructor(code, message, httpStatus = 400, details = undefined) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function secretEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = createHash('sha256').update(actual).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function validateMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new BridgeError('INVALID_SESSION', 'Session metadata must be an object');
  }
  const clean = {};
  for (const key of ['traceName', 'traceFingerprint', 'parserVersion']) {
    const value = meta[key];
    if (value !== undefined && typeof value !== 'string') {
      throw new BridgeError('INVALID_SESSION', `${key} must be a string`);
    }
    if (value !== undefined) clean[key] = value.slice(0, 512);
  }
  return clean;
}

export function validateRequest(body, sessionId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BridgeError('INVALID_REQUEST', 'Request body must be a JSON object');
  }
  const {id, kind, session, expected_version: expectedVersion, args = {}} = body;
  if (typeof id !== 'string' || !/^[\w.:-]{1,128}$/.test(id)) {
    throw new BridgeError('INVALID_REQUEST', 'id must be 1-128 safe characters');
  }
  if (!COMMAND_KINDS.has(kind)) {
    throw new BridgeError('UNKNOWN_COMMAND', `Unsupported command: ${String(kind)}`);
  }
  if (session !== sessionId) {
    throw new BridgeError('SESSION_MISMATCH', 'Request session does not match the authorized session', 409);
  }
  if (expectedVersion !== undefined &&
      (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) {
    throw new BridgeError('INVALID_REQUEST', 'expected_version must be a non-negative safe integer');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new BridgeError('INVALID_REQUEST', 'args must be an object');
  }
  const request = {id, kind, session, args};
  if (expectedVersion !== undefined) request.expected_version = expectedVersion;
  if (kind === 'query') {
    if (typeof args.sql !== 'string' || args.sql.length === 0 || args.sql.length > 100_000) {
      throw new BridgeError('INVALID_QUERY', 'sql must be a non-empty string of at most 100000 characters');
    }
    if (args.max_rows !== undefined &&
        (!Number.isSafeInteger(args.max_rows) || args.max_rows < 1 || args.max_rows > 1000)) {
      throw new BridgeError('INVALID_QUERY', 'max_rows must be an integer between 1 and 1000');
    }
    if (args.timeout_ms !== undefined &&
        (!Number.isSafeInteger(args.timeout_ms) || args.timeout_ms < 100 || args.timeout_ms > 60_000)) {
      throw new BridgeError('INVALID_QUERY', 'timeout_ms must be between 100 and 60000');
    }
  }
  return request;
}

export class SessionHub {
  constructor({logger = () => {}} = {}) {
    this.sessions = new Map();
    this.logger = logger;
  }

  create(meta, origin) {
    if (this.sessions.size >= 32) {
      throw new BridgeError('SESSION_LIMIT', 'Too many authorized or pending sessions', 429);
    }
    const session = {
      id: randomUUID(),
      token: randomBytes(32).toString('base64url'),
      origin,
      meta: validateMeta(meta),
      browser: null,
      pending: new Map(),
      activeQueries: 0,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    session.creationTimer = setTimeout(() => {
      if (!session.browser) this.revoke(session.id, 'AUTHORIZATION_TIMEOUT', 'Browser did not connect after authorization');
    }, 60_000);
    session.creationTimer.unref();
    return session;
  }

  authorize(id, token) {
    const session = this.sessions.get(id);
    if (!session || !secretEqual(token, session.token)) {
      throw new BridgeError('UNAUTHORIZED', 'Invalid or expired agent credentials', 401);
    }
    return session;
  }

  attachBrowser(session, socket) {
    clearTimeout(session.creationTimer);
    if (session.browser && session.browser.readyState === WebSocket.OPEN) {
      this.revoke(session.id, 'BROWSER_REPLACED', 'Authorized browser was replaced');
      throw new BridgeError('SESSION_REPLACED', 'A browser is already attached to this session', 409);
    }
    session.browser = socket;
    socket.on('message', (data, isBinary) => {
      if (isBinary || data.length > MAX_MESSAGE_BYTES) {
        socket.close(1009, 'Message too large or binary');
        return;
      }
      let message;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        socket.close(1007, 'Invalid JSON');
        return;
      }
      this.onBrowserMessage(session, message);
    });
    socket.on('close', () => {
      if (this.sessions.get(session.id) === session && session.browser === socket) {
        this.revoke(session.id, 'BROWSER_DISCONNECTED', 'Authorized browser disconnected');
      }
    });
    socket.on('error', () => {});
    this.logger({event: 'browser_connected', session: session.id});
  }

  onBrowserMessage(session, message) {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') return;
    const pending = session.pending.get(message.id);
    if (!pending) return;
    session.pending.delete(message.id);
    clearTimeout(pending.timer);
    const response = {
      id: message.id,
      ok: message.ok === true,
      version: Number.isSafeInteger(message.version) ? message.version : 0,
    };
    if (message.ok === true) response.result = message.result ?? null;
    else {
      response.error = {
        code: typeof message.error?.code === 'string' ? message.error.code.slice(0, 100) : 'BROWSER_ERROR',
        message: typeof message.error?.message === 'string' ? message.error.message.slice(0, 2000) : 'Browser command failed',
      };
      if (message.error?.details !== undefined) response.error.details = message.error.details;
    }
    if (message.changed !== undefined) response.changed = message.changed;
    pending.resolve(response);
  }

  async forward(session, request) {
    if (!session.browser || session.browser.readyState !== WebSocket.OPEN) {
      throw new BridgeError('BROWSER_DISCONNECTED', 'The authorized browser tab is not connected', 409);
    }
    if (session.pending.has(request.id)) {
      throw new BridgeError('DUPLICATE_REQUEST', 'A request with this id is already running', 409);
    }
    if (request.kind === 'query' && session.activeQueries >= 1) {
      throw new BridgeError('QUERY_BUSY', 'Only one query may run per session', 429);
    }
    if (request.kind === 'query') session.activeQueries++;
    try {
      return await new Promise((resolve, reject) => {
        const queryTimeout = request.kind === 'query' ? (request.args.timeout_ms ?? 30_000) : 30_000;
        const timer = setTimeout(() => {
          session.pending.delete(request.id);
          if (request.kind === 'query') {
            this.send(session, {
              id: `cancel-${request.id}`.slice(0, 128),
              kind: 'query.cancel',
              session: session.id,
              args: {query_id: request.id},
            });
          }
          reject(new BridgeError('BRIDGE_TIMEOUT', 'Browser did not respond before the bridge deadline', 504));
        }, queryTimeout + 5000);
        session.pending.set(request.id, {resolve, reject, timer});
        try {
          this.send(session, request);
        } catch (error) {
          clearTimeout(timer);
          session.pending.delete(request.id);
          reject(error);
        }
      });
    } finally {
      if (request.kind === 'query') session.activeQueries--;
    }
  }

  send(session, value) {
    if (!session.browser || session.browser.readyState !== WebSocket.OPEN) {
      throw new BridgeError('BROWSER_DISCONNECTED', 'The authorized browser tab is not connected', 409);
    }
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) {
      throw new BridgeError('MESSAGE_TOO_LARGE', 'Request exceeds the message size limit', 413);
    }
    session.browser.send(encoded);
  }

  revoke(id, code = 'SESSION_REVOKED', reason = 'Authorization revoked') {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.creationTimer);
    this.sessions.delete(id);
    for (const [requestId, pending] of session.pending) {
      clearTimeout(pending.timer);
      pending.resolve({
        id: requestId,
        ok: false,
        version: 0,
        error: {code, message: reason},
      });
    }
    session.pending.clear();
    if (session.browser) {
      session.browser.close(1000, 'Authorization revoked');
      session.browser = null;
    }
    this.logger({event: 'session_revoked', session: id, reason: code});
  }
}
