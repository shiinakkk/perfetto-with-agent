import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';

const MIME_TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.pftrace': 'application/octet-stream',
  '.perfetto-trace': 'application/octet-stream',
}));

export function commonHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-eval' 'sha256-fpCOJFxk6nwV2pw6MFCno3BCmBG6dLMbGVVOe9tikuo='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob: http://127.0.0.1:* http://localhost:* http://[::1]:* ws://127.0.0.1:* ws://localhost:* ws://[::1]:*; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'", 
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

export async function serveStatic(root, request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400, commonHeaders());
    response.end('Invalid URL');
    return;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) {
    response.writeHead(400, commonHeaders());
    response.end('Invalid path');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const rootPath = path.resolve(root);
  const filePath = path.resolve(rootPath, `.${pathname}`);
  if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${path.sep}`)) {
    response.writeHead(403, commonHeaders());
    response.end('Forbidden');
    return;
  }
  let info;
  try {
    info = await stat(filePath);
  } catch {
    response.writeHead(404, commonHeaders());
    response.end('Not found');
    return;
  }
  if (!info.isFile()) {
    response.writeHead(404, commonHeaders());
    response.end('Not found');
    return;
  }
  const headers = {
    ...commonHeaders(),
    'Content-Type': MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': filePath.endsWith('.html') || path.basename(filePath).startsWith('collab') ? 'no-cache' : 'public, max-age=300',
  };
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  await pipeline(createReadStream(filePath), response);
}
