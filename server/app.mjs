import http from 'node:http';
import {BridgeError, MAX_MESSAGE_BYTES, MAX_REQUEST_BYTES, secretEqual, SessionHub, validateRequest} from './session-hub.mjs';
import {commonHeaders, serveStatic} from './static-files.mjs';

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...commonHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function errorResponse(response, error, id = null) {
  const bridgeError = error instanceof BridgeError ? error :
    new BridgeError('INTERNAL_ERROR', 'Internal server error', 500);
  json(response, bridgeError.httpStatus, {
    id,
    ok: false,
    error: {code: bridgeError.code, message: bridgeError.message},
  });
}

async function readJson(request, limit) {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new BridgeError('INVALID_CONTENT_TYPE', 'Content-Type must be application/json', 415);
  }
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > limit) throw new BridgeError('MESSAGE_TOO_LARGE', 'Request body is too large', 413);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(new BridgeError('MESSAGE_TOO_LARGE', 'Request body is too large', 413));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new BridgeError('INVALID_JSON', 'Request body is not valid JSON'));
      }
    });
    request.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function bearer(request) {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return '';
  return value.slice(7);
}

export function createCollabServer({uiDir, host = '127.0.0.1', port = 19400, logger = () => {}} = {}) {
  if (!uiDir) throw new Error('uiDir is required');
  const hub = new SessionHub({logger});
  const allowedHosts = new Set([`${host}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  function validateHost(request) {
    const requestHost = request.headers.host;
    if (typeof requestHost !== 'string' || !allowedHosts.has(requestHost.toLowerCase())) {
      throw new BridgeError('INVALID_HOST', 'Host header is not an allowed loopback address', 403);
    }
  }

  function validateOrigin(request, required = false) {
    const origin = request.headers.origin;
    if (!origin) {
      if (required) throw new BridgeError('INVALID_ORIGIN', 'A same-origin browser Origin is required', 403);
      return undefined;
    }
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new BridgeError('INVALID_ORIGIN', 'Origin is invalid', 403);
    }
    if (parsed.protocol !== 'http:' || !allowedHosts.has(parsed.host.toLowerCase())) {
      throw new BridgeError('INVALID_ORIGIN', 'Cross-origin requests are not allowed', 403);
    }
    return parsed.origin;
  }

  const server = http.createServer({maxHeaderSize: 16 * 1024}, async (request, response) => {
    let requestId = null;
    try {
      validateHost(request);
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/health' && request.method === 'GET') {
        json(response, 200, {ok: true, service: 'perfetto-local-collab', version: 1});
        return;
      }
      if (url.pathname === '/api/browser/sessions' && request.method === 'POST') {
        const origin = validateOrigin(request, true);
        const body = await readJson(request, 16 * 1024);
        const session = hub.create(body, origin);
        json(response, 201, {
          ok: true,
          session: session.id,
          token: session.token,
          request_url: `http://${request.headers.host}/api/agent/request`,
          websocket_path: `/ws/browser?session=${encodeURIComponent(session.id)}`,
          created_at: session.createdAt,
        });
        return;
      }
      const browserMatch = /^\/api\/browser\/sessions\/([\w-]+)$/.exec(url.pathname);
      if (browserMatch && request.method === 'DELETE') {
        const origin = validateOrigin(request, true);
        const session = hub.authorize(browserMatch[1], bearer(request));
        if (origin !== session.origin) throw new BridgeError('INVALID_ORIGIN', 'Session belongs to a different origin', 403);
        hub.revoke(session.id);
        json(response, 200, {ok: true});
        return;
      }
      if (url.pathname === '/api/agent/request' && request.method === 'POST') {
        validateOrigin(request);
        const body = await readJson(request, MAX_REQUEST_BYTES);
        requestId = typeof body?.id === 'string' ? body.id : null;
        const session = hub.authorize(body?.session, bearer(request));
        const command = validateRequest(body, session.id);
        const result = await hub.forward(session, command);
        json(response, result.ok ? 200 : 409, result);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        throw new BridgeError('NOT_FOUND', 'API endpoint not found', 404);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new BridgeError('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      }
      await serveStatic(uiDir, request, response);
    } catch (error) {
      if (!response.headersSent) errorResponse(response, error, requestId);
      else response.destroy();
      if (!(error instanceof BridgeError)) logger({event: 'server_error', message: error.message});
    }
  });

  const webSockets = new WebSocketServer({noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false});
  server.on('upgrade', (request, socket, head) => {
    const reject = (status, message) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`);
      socket.destroy();
    };
    try {
      validateHost(request);
      const origin = validateOrigin(request, true);
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname !== '/ws/browser') throw new BridgeError('NOT_FOUND', 'WebSocket endpoint not found', 404);
      const session = hub.authorize(url.searchParams.get('session'), url.searchParams.get('token'));
      if (origin !== session.origin) throw new BridgeError('INVALID_ORIGIN', 'Session belongs to a different origin', 403);
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSockets.emit('connection', webSocket, request);
        hub.attachBrowser(session, webSocket);
      });
    } catch (error) {
      const status = error instanceof BridgeError ? error.httpStatus : 500;
      reject(status, error.message);
    }
  });

  const heartbeat = setInterval(() => {
    for (const client of webSockets.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 30_000);
  heartbeat.unref();
  webSockets.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
  });
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const id of [...hub.sessions.keys()]) hub.revoke(id, 'SERVER_STOPPED', 'Local service stopped');
    webSockets.close();
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 70_000;
  return {server, hub, allowedHosts};
}

// Imported separately to keep the HTTP-only unit tests from opening a WS listener.
import {WebSocketServer} from 'ws';
