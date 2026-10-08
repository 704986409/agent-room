import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type {
  VercelApiHandler,
  VercelRequest,
  VercelRequestQuery,
  VercelResponse,
} from '@vercel/node';
import { createClient } from '@agent-room/upstash-client';
import deleteRoomBlobsHandler from '../../api/delete-room-blobs.js';
import installHandler from '../../api/install.js';
import mcpHandler from '../../api/mcp.js';
import reportOgHandler from '../../api/report-og.js';
import reportPageHandler from '../../api/report-page.js';
import roomHandler from '../../api/room.js';
import uploadHandler from '../../api/upload.js';

const PORT = parsePort(process.env.PORT);
const HOST = process.env.HOST?.trim() || '0.0.0.0';
const WEB_ROOT = resolve(process.env.WEB_ROOT?.trim() || resolve(process.cwd(), 'apps/web/dist'));
const MCP_REQUEST_TIMEOUT_MS = 320_000;
const API_BODY_LIMIT_BYTES = 20 * 1024 * 1024;
const REDIS_PROXY_BODY_LIMIT_BYTES = 1024 * 1024;
const MAX_PIPELINE_COMMANDS = 100;

const API_HANDLERS: Readonly<Record<string, VercelApiHandler>> = {
  'delete-room-blobs': deleteRoomBlobsHandler,
  install: installHandler,
  mcp: mcpHandler,
  'report-og': reportOgHandler,
  'report-page': reportPageHandler,
  room: roomHandler,
  upload: uploadHandler,
};

const REDIS_COMMANDS = new Set([
  'GET', 'SET', 'DEL', 'RPUSH', 'INCR', 'LTRIM', 'LRANGE', 'LLEN',
  'EXPIRE', 'EXPIREAT', 'SADD', 'SISMEMBER', 'SMEMBERS', 'SREM', 'EVAL', 'PING', 'TTL',
]);
const REDIS_DENY_COMMANDS = new Set([
  'FLUSHALL', 'FLUSHDB', 'KEYS', 'SCAN', 'CONFIG', 'ACL', 'MODULE', 'SHUTDOWN',
  'MONITOR', 'DEBUG', 'MIGRATE', 'REPLICAOF', 'SLAVEOF',
]);

class RequestBodyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'RequestBodyError';
  }
}

function parsePort(value: string | undefined): number {
  const port = value ? Number(value) : 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  return port;
}

function parseQuery(url: URL): VercelRequestQuery {
  const query: VercelRequestQuery = {};
  for (const [key, value] of url.searchParams) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }
  return query;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function vercelResponse(response: ServerResponse): VercelResponse {
  const result = response as VercelResponse;
  result.status = (statusCode: number) => {
    response.statusCode = statusCode;
    return result;
  };
  result.json = (body: unknown) => {
    if (!response.headersSent && !response.hasHeader('Content-Type')) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    response.end(JSON.stringify(body));
    return result;
  };
  result.send = (body: unknown) => {
    if (body === null || body === undefined) {
      response.end();
    } else if (typeof body === 'string' || Buffer.isBuffer(body)) {
      if (typeof body === 'string' && !response.headersSent && !response.hasHeader('Content-Type')) {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
      }
      response.end(body);
    } else {
      result.json(body);
    }
    return result;
  };
  result.redirect = (statusOrUrl: string | number, maybeUrl?: string) => {
    const statusCode = typeof statusOrUrl === 'number' ? statusOrUrl : 302;
    const destination = typeof statusOrUrl === 'string' ? statusOrUrl : maybeUrl;
    if (!destination) throw new Error('Redirect destination is required.');
    response.statusCode = statusCode;
    response.setHeader('Location', destination);
    response.end();
    return result;
  };
  return result;
}

async function readRequestBody(request: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > limitBytes) {
    throw new RequestBodyError('Request body is too large.', 413);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += data.length;
    if (total > limitBytes) {
      throw new RequestBodyError('Request body is too large.', 413);
    }
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

async function attachJsonBody(request: VercelRequest, pathname: string): Promise<void> {
  // api/upload.ts consumes multipart bodies itself. Leave the request stream
  // untouched so its existing boundary parser sees every byte.
  if (pathname === '/api/upload') return;
  const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') return;

  const body = await readRequestBody(request, API_BODY_LIMIT_BYTES);
  if (body.length === 0) {
    request.body = undefined;
    return;
  }
  try {
    request.body = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new RequestBodyError('Request body must contain valid JSON.', 400);
  }
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded) return;
  response.statusCode = statusCode;
  if (!response.hasHeader('Content-Type')) response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

function applyRedisCors(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Max-Age', '86400');
  response.setHeader('Cache-Control', 'no-store');
}

function hasProxyToken(request: IncomingMessage, expected: string): boolean {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return false;
  const provided = Buffer.from(match[1]!);
  const configured = Buffer.from(expected);
  return provided.length === configured.length && timingSafeEqual(provided, configured);
}

function redisCommandName(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== 'string') return null;
  return value[0].trim().toUpperCase();
}

function validateRedisPayload(pathname: string, body: unknown): { ok: true; body: unknown } | { ok: false; status: number; error: string } {
  const pipeline = pathname === '/redis/pipeline';
  const commands = pipeline
    ? (Array.isArray(body) ? body : null)
    : (Array.isArray(body) && (body.length === 0 || !Array.isArray(body[0])) ? [body] : null);

  if (!commands || commands.length === 0) {
    return { ok: false, status: 400, error: 'invalid_redis_command' };
  }
  if (pipeline && commands.length > MAX_PIPELINE_COMMANDS) {
    return { ok: false, status: 413, error: 'pipeline_limit_exceeded' };
  }

  for (const command of commands) {
    const name = redisCommandName(command);
    if (!name || REDIS_DENY_COMMANDS.has(name) || !REDIS_COMMANDS.has(name)) {
      return { ok: false, status: 403, error: 'redis_command_not_allowed' };
    }
    if (!command.every((argument: unknown) => typeof argument === 'string' || typeof argument === 'number')) {
      return { ok: false, status: 400, error: 'invalid_redis_command' };
    }
  }
  return { ok: true, body };
}

async function handleRedisProxy(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  applyRedisCors(response);
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'method_not_allowed' });
    return;
  }

  const proxyToken = process.env.WEB_PROXY_TOKEN;
  const upstreamUrl = process.env.SRH_WEB_URL;
  const upstreamToken = process.env.SRH_WEB_TOKEN;
  if (!proxyToken || !upstreamUrl || !upstreamToken) {
    writeJson(response, 503, { error: 'redis_proxy_not_configured' });
    return;
  }
  if (!hasProxyToken(request, proxyToken)) {
    writeJson(response, 401, { error: 'unauthorized' });
    return;
  }

  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (pathname !== '/redis' && pathname !== '/redis/pipeline') {
    writeJson(response, 404, { error: 'not_found' });
    return;
  }

  let body: unknown;
  try {
    const raw = await readRequestBody(request, REDIS_PROXY_BODY_LIMIT_BYTES);
    body = raw.length ? JSON.parse(raw.toString('utf8')) as unknown : undefined;
  } catch (error) {
    const statusCode = error instanceof RequestBodyError ? error.status : 400;
    writeJson(response, statusCode, { error: statusCode === 413 ? 'body_too_large' : 'invalid_json' });
    return;
  }

  const checked = validateRedisPayload(pathname, body);
  if (!checked.ok) {
    writeJson(response, checked.status, { error: checked.error });
    return;
  }

  const upstreamPath = pathname === '/redis/pipeline' ? '/pipeline' : '/';
  try {
    const upstream = await fetch(new URL(upstreamPath, upstreamUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upstreamToken}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
      body: JSON.stringify(checked.body),
      cache: 'no-store',
    });
    if (!upstream.ok) {
      writeJson(response, 502, { error: 'redis_upstream_unavailable' });
      return;
    }
    response.statusCode = upstream.status;
    response.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    writeJson(response, 502, { error: 'redis_upstream_unavailable' });
  }
}

function sendHealth(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

async function handleReady(response: ServerResponse): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    sendHealth(response, 503, { ready: false });
    return;
  }
  try {
    const result = await createClient({ url, token }).command<string>(['PING']);
    if (result !== 'PONG') {
      sendHealth(response, 503, { ready: false });
      return;
    }
    sendHealth(response, 200, { ready: true });
  } catch {
    sendHealth(response, 503, { ready: false });
  }
}

function mimeType(pathname: string): string {
  switch (extname(pathname).toLowerCase()) {
    case '.css': return 'text/css; charset=utf-8';
    case '.html': return 'text/html; charset=utf-8';
    case '.ico': return 'image/x-icon';
    case '.jpeg':
    case '.jpg': return 'image/jpeg';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.json':
    case '.map': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    case '.svg': return 'image/svg+xml';
    case '.txt': return 'text/plain; charset=utf-8';
    case '.webmanifest': return 'application/manifest+json; charset=utf-8';
    case '.webp': return 'image/webp';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

async function serveStaticFile(
  response: ServerResponse,
  pathname: string,
  headOnly: boolean,
): Promise<boolean> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendHealth(response, 400, { error: 'invalid_path' });
    return true;
  }
  const filePath = resolve(WEB_ROOT, `.${decodedPath === '/' ? '/index.html' : decodedPath}`);
  const relativePath = relative(WEB_ROOT, filePath);
  if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
    sendHealth(response, 400, { error: 'invalid_path' });
    return true;
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
    if (!fileStat.isFile()) return false;
  } catch {
    return false;
  }

  response.statusCode = 200;
  response.setHeader('Content-Type', mimeType(filePath));
  response.setHeader('Content-Length', fileStat.size);
  response.setHeader(
    'Cache-Control',
    relativePath.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
  );
  if (relativePath === 'index.html') response.setHeader('Cache-Control', 'no-store');
  if (headOnly) {
    response.end();
    return true;
  }
  createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
  return true;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://agent-room.local');
  } catch {
    writeJson(response, 400, { error: 'invalid_url' });
    return;
  }

  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (pathname === '/healthz') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeJson(response, 405, { error: 'method_not_allowed' });
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok' }));
    return;
  }
  if (pathname === '/readyz') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeJson(response, 405, { error: 'method_not_allowed' });
      return;
    }
    await handleReady(response);
    return;
  }
  if (pathname === '/redis' || pathname === '/redis/pipeline' || pathname.startsWith('/redis/')) {
    await handleRedisProxy(request, response, url);
    return;
  }

  const botReportMatch = /^\/r\/([^/]+)\/report\/?$/.exec(url.pathname);
  const userAgent = String(request.headers['user-agent'] ?? '');
  const isReportBot = /(?:bot|crawler|spider|facebookexternalhit|Twitterbot|Slackbot|LinkedInBot|Discordbot|WhatsApp|TelegramBot)/i.test(userAgent);
  const rewriteToReportPage = Boolean(botReportMatch && isReportBot);
  let handlerName: string | undefined;
  let query = parseQuery(url);

  if (pathname === '/mcp') handlerName = 'mcp';
  else if (pathname === '/install') handlerName = 'install';
  else if (rewriteToReportPage) {
    handlerName = 'report-page';
    query = { ...query, code: decodeURIComponent(botReportMatch![1]!) };
  } else if (pathname.startsWith('/api/')) {
    handlerName = pathname.slice('/api/'.length);
  }

  if (handlerName) {
    const handler = API_HANDLERS[handlerName];
    if (!handler) {
      writeJson(response, 404, { error: 'not_found' });
      return;
    }

    const apiRequest = request as VercelRequest;
    apiRequest.query = query;
    apiRequest.cookies = parseCookies(request.headers.cookie);
    apiRequest.body = undefined;
    try {
      await attachJsonBody(apiRequest, pathname);
      await handler(apiRequest, vercelResponse(response));
    } catch (error) {
      if (response.writableEnded) return;
      if (error instanceof RequestBodyError) {
        writeJson(response, error.status, { error: error.status === 413 ? 'body_too_large' : 'invalid_json', message: error.message });
      } else {
        writeJson(response, 500, { error: 'internal_server_error' });
      }
    }
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    writeJson(response, 404, { error: 'not_found' });
    return;
  }

  const headOnly = request.method === 'HEAD';
  if (await serveStaticFile(response, pathname, headOnly)) return;
  if (extname(pathname)) {
    writeJson(response, 404, { error: 'not_found' });
    return;
  }
  if (await serveStaticFile(response, '/index.html', headOnly)) return;
  writeJson(response, 500, { error: 'web_assets_unavailable' });
}

const server = createServer((request, response) => {
  void handleRequest(request, response);
});
server.requestTimeout = MCP_REQUEST_TIMEOUT_MS;
server.headersTimeout = MCP_REQUEST_TIMEOUT_MS;
server.setTimeout(MCP_REQUEST_TIMEOUT_MS);
server.keepAliveTimeout = 65_000;

server.listen(PORT, HOST, () => {
  process.stdout.write(`Agent Room listening on ${HOST}:${PORT}\n`);
});
