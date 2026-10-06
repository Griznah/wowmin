import './main';
import { createHash, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { app, ipcMain } from 'electron';
import { inspectLocalLogs, readLocalLogTail } from './local-logs';

const host = process.env.WOWMIN_HOST || '127.0.0.1';
const port = Number(process.env.WOWMIN_PORT || '3000');
const username = process.env.WOWMIN_USERNAME || '';
const password = process.env.WOWMIN_PASSWORD || '';
const projectRoot = path.resolve(__dirname, '..');
const maxRequestBytes = 2 * 1024 * 1024;
const managed = Boolean(process.env.WOWMIN_SOAP_USERNAME && process.env.WOWMIN_SOAP_PASSWORD && process.env.WOWMIN_DB_PASSWORD);

function managedConfig(channel: string, args: unknown[]): unknown[] {
  if (!managed) return args;
  if (channel === 'soap:connect') return [{ host: process.env.WOWMIN_SOAP_HOST || '127.0.0.1',
    port: Number(process.env.WOWMIN_SOAP_PORT || 7878), username: process.env.WOWMIN_SOAP_USERNAME,
    password: process.env.WOWMIN_SOAP_PASSWORD }];
  if (['db:connect', 'db:testConnection', 'map:connect', 'economy:connect'].includes(channel)) {
    const database = channel === 'db:connect' || channel === 'db:testConnection'
      ? process.env.WOWMIN_WORLD_DB || 'acore_world' : process.env.WOWMIN_CHARACTERS_DB || 'acore_characters';
    return [{ host: process.env.WOWMIN_DB_HOST || '127.0.0.1', port: Number(process.env.WOWMIN_DB_PORT || 3306),
      username: process.env.WOWMIN_DB_USERNAME || 'acore', password: process.env.WOWMIN_DB_PASSWORD, database }];
  }
  return args;
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid WOWMIN_PORT: ${process.env.WOWMIN_PORT}`);
}
if (!username || !password) {
  throw new Error('WOWMIN_USERNAME and WOWMIN_PASSWORD are required.');
}

const staticFiles: Record<string, string> = {
  '/': path.join(projectRoot, 'renderer', 'index.html'),
  '/index.html': path.join(projectRoot, 'renderer', 'index.html'),
  '/styles.css': path.join(projectRoot, 'renderer', 'styles.css'),
  '/styles/output.css': path.join(projectRoot, 'renderer', 'styles', 'output.css'),
  '/dist/web-api.js': path.join(projectRoot, 'dist', 'web-api.js'),
  '/dist/renderer.js': path.join(projectRoot, 'dist', 'renderer.js'),
};

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
}

function secureEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function isAuthorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith('Basic ')) return false;

  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;
    return secureEqual(decoded.slice(0, separator), username)
      && secureEqual(decoded.slice(separator + 1), password);
  } catch {
    return false;
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxRequestBytes) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function resolveStaticFile(urlPath: string): string | null {
  const exact = staticFiles[urlPath];
  if (exact) return exact;

  for (const prefix of ['/assets/', '/renderer/']) {
    if (!urlPath.startsWith(prefix)) continue;
    const base = path.join(projectRoot, prefix.slice(1, -1));
    const candidate = path.resolve(base, urlPath.slice(prefix.length));
    if (candidate === base || !candidate.startsWith(`${base}${path.sep}`)) return null;
    return candidate;
  }
  return null;
}

function serveFile(request: IncomingMessage, response: ServerResponse, filePath: string): void {
  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stats.size,
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(filePath).pipe(response);
  });
}

function hasValidOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  setSecurityHeaders(response);
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    sendJson(response, 200, { status: 'ok', version: app.getVersion() });
    return;
  }

  if (!isAuthorized(request)) {
    response.setHeader('WWW-Authenticate', 'Basic realm="WoW Admin", charset="UTF-8"');
    sendJson(response, 401, { error: 'Authentication required' });
    return;
  }

  if (url.pathname === '/api/bootstrap') {
    sendJson(response, 200, { managed, localLogs: managed });
    return;
  }

  if (url.pathname === '/api/invoke') {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    if (!hasValidOrigin(request)) {
      sendJson(response, 403, { error: 'Invalid request origin' });
      return;
    }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      sendJson(response, 415, { error: 'Content-Type must be application/json' });
      return;
    }

    try {
      const body = await readJson(request) as { channel?: unknown; args?: unknown };
      if (typeof body.channel !== 'string' || !Array.isArray(body.args)) {
        sendJson(response, 400, { error: 'Expected channel and args.' });
        return;
      }
      if (managed && (body.channel.startsWith('config:') || body.channel.startsWith('update:'))) {
        sendJson(response, 403, { error: 'Profiles and upstream updates are disabled in managed web mode.' });
        return;
      }
      if (managed && body.channel === 'logs:inspect') {
        sendJson(response, 200, { ok: true, result: await inspectLocalLogs() });
        return;
      }
      if (managed && body.channel === 'logs:readTail') {
        sendJson(response, 200, { ok: true, result: await readLocalLogTail(String(body.args[1]), Number(body.args[2])) });
        return;
      }
      const webIpc = ipcMain as unknown as { invoke: (channel: string, args: unknown[]) => Promise<unknown> };
      const result = await webIpc.invoke(body.channel, managedConfig(body.channel, body.args));
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('API request failed:', message);
      sendJson(response, 400, { ok: false, error: message });
    }
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    sendJson(response, 400, { error: 'Invalid URL path' });
    return;
  }
  const filePath = resolveStaticFile(decodedPath);
  if (!filePath) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }
  serveFile(request, response, filePath);
});

app.whenReady().then(() => {
  server.listen(port, host, () => {
    console.log(`WoW Admin web service listening on http://${host}:${port}`);
  });
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
