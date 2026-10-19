import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  VercelApiHandler,
  VercelRequest,
  VercelRequestQuery,
  VercelResponse,
} from '@vercel/node';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { createClient } from '@agent-room/upstash-client';
import { createMcpServer } from '../../api/_mcpServer.js';
import { createRemoteRoomClient } from '../../api/_mcpRoomClient.js';
import { detectHarness } from '../../api/_mcpHarness.js';
import type { McpProfile } from '../../api/_mcpTools.js';
import {
  adminDisableHandler,
  adminEnableHandler,
  adminResetPasswordHandler,
  adminRevokeSessionsHandler,
  adminSessionsHandler,
  adminUsersHandler,
} from '../../api/admin-users.js';
import {
  devicesHandler,
  loginHandler,
  logoutHandler,
  meHandler,
  passwordHandler,
  revokeOtherSessionsHandler,
  revokeSessionHandler,
  sessionsHandler,
} from '../../api/account.js';
import {
  deviceSelfHandler,
  pairCompleteHandler,
  pairStartHandler,
  revokeDeviceHandler,
} from '../../api/device.js';
import deleteRoomBlobsHandler from '../../api/delete-room-blobs.js';
import elevenlabsTtsHandler from '../../api/elevenlabs-tts.js';
import installHandler from '../../api/install.js';
import interviewReplyHandler from '../../api/interview-reply.js';
import memoryReviewHandler from '../../api/memory-review.js';
import mcpHandler from '../../api/mcp.js';
import reportOgHandler from '../../api/report-og.js';
import reportPageHandler from '../../api/report-page.js';
import roomHandler from '../../api/room.js';
import sttHandler from '../../api/stt.js';
import uploadHandler from '../../api/upload.js';
import wakeHandler from '../../api/wake.js';
import { installWakeSendHook } from '../../api/_wakeSend.js';
import { startWakePatrol } from '../../api/_wakeService.js';
import {
  chatSendHandler,
  deliverHandler,
  hostHandler,
  inviteAcceptHandler,
  inviteCreateHandler,
  inviteRevokeHandler,
  joinHandler,
  presenceHandler,
  roomCreateHandler,
  taskHandler,
  typingHandler,
  whoamiHandler,
} from '../../api/web-writes.js';
import { canReadRoom } from '../../api/_roomAccess.js';
import { serverRedis } from '../../api/_redisEnv.js';
import { GUEST_COOKIE, SESSION_COOKIE } from '../../api/_httpAuth.js';
import { REDIS_READ_COMMANDS, commandExposesSensitiveKey, redisCommandKeys, roomCodeFromRedisKey } from './redisProxyPolicy.js';

const HOST = process.env.HOST?.trim() || '0.0.0.0';
const WEB_ROOT = resolve(process.env.WEB_ROOT?.trim() || resolve(process.cwd(), 'apps/web/dist'));
const MCP_REQUEST_TIMEOUT_MS = 320_000;
const API_BODY_LIMIT_BYTES = 20 * 1024 * 1024;
const SSE_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 25_000;
const MAX_SSE_SESSIONS = 64;
const REDIS_PROXY_BODY_LIMIT_BYTES = 1024 * 1024;
const MAX_PIPELINE_COMMANDS = 100;

interface SseSession {
  transport: SSEServerTransport;
  mcpServer: McpServer;
  heartbeat?: NodeJS.Timeout;
  closed: boolean;
  close(): void;
}

export interface VpsServerOptions {
  host?: string;
  /** Port 0 asks the OS for an available local test port. */
  port?: number;
  webRoot?: string;
  sseHeartbeatMs?: number;
  maxSseSessions?: number;
}

export interface VpsApp {
  server: HttpServer;
  getSseSessionCount(): number;
  close(): Promise<void>;
}

const API_HANDLERS: Readonly<Record<string, VercelApiHandler>> = {
  'account/login': loginHandler,
  'account/logout': logoutHandler,
  'account/me': meHandler,
  'account/sessions': sessionsHandler,
  'account/sessions/revoke': revokeSessionHandler,
  'account/sessions/revoke-others': revokeOtherSessionsHandler,
  'account/password': passwordHandler,
  'account/devices': devicesHandler,
  'account/devices/revoke': revokeDeviceHandler,
  'device/pair-start': pairStartHandler,
  'device/pair-complete': pairCompleteHandler,
  'device/self': deviceSelfHandler,
  'admin/users': adminUsersHandler,
  'admin/users/disable': adminDisableHandler,
  'admin/users/enable': adminEnableHandler,
  'admin/users/reset-password': adminResetPasswordHandler,
  'admin/users/sessions': adminSessionsHandler,
  'admin/users/revoke-sessions': adminRevokeSessionsHandler,
  'web/room-create': roomCreateHandler,
  'web/join': joinHandler,
  'web/whoami': whoamiHandler,
  'web/chat-send': chatSendHandler,
  'web/presence': presenceHandler,
  'web/typing': typingHandler,
  'web/task': taskHandler,
  'web/host': hostHandler,
  'web/deliver': deliverHandler,
  'web/invite': inviteCreateHandler,
  'web/invite-revoke': inviteRevokeHandler,
  'web/invite-accept': inviteAcceptHandler,
  'delete-room-blobs': deleteRoomBlobsHandler,
  'elevenlabs-tts': elevenlabsTtsHandler,
  install: installHandler,
  'interview-reply': interviewReplyHandler,
  'memory-review': memoryReviewHandler,
  mcp: mcpHandler,
  'report-og': reportOgHandler,
  'report-page': reportPageHandler,
  room: roomHandler,
  stt: sttHandler,
  upload: uploadHandler,
  wake: wakeHandler,
};

const REDIS_COMMANDS = REDIS_READ_COMMANDS;
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

function redisUpstreamFailureDetails(error: unknown): { errorName: string; causeCode?: string } {
  const rawName = error instanceof Error ? error.name : typeof error;
  const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,60}$/.test(rawName) ? rawName : 'Error';
  const cause = error instanceof Error ? error.cause : undefined;
  const rawCode = cause && typeof cause === 'object' && 'code' in cause
    ? (cause as { code?: unknown }).code
    : undefined;
  const causeCode = typeof rawCode === 'string' && /^[A-Z0-9_-]{1,40}$/i.test(rawCode)
    ? rawCode
    : undefined;
  return { errorName, ...(causeCode ? { causeCode } : {}) };
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
    if (commandExposesSensitiveKey(command)) {
      return { ok: false, status: 403, error: 'redis_key_not_allowed' };
    }
  }
  return { ok: true, body };
}

async function authorizeRedisRoomRead(
  request: IncomingMessage,
  pathname: string,
  body: unknown,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const commands = pathname === '/redis/pipeline' ? (body as unknown[][]) : [body as unknown[]];
  const cookies = parseCookies(request.headers.cookie);
  const allowed = new Set<string>();
  let redis: ReturnType<typeof serverRedis> | null = null;
  for (const command of commands) {
    if (redisCommandName(command) === 'PING') continue;
    const keys = redisCommandKeys(command);
    if (keys.length === 0) return { ok: false, status: 403, error: 'redis_key_not_allowed' };
    for (const key of keys) {
      const code = roomCodeFromRedisKey(key);
      if (!code) return { ok: false, status: 403, error: 'redis_key_not_allowed' };
      if (allowed.has(code)) continue;
      try {
        redis ??= serverRedis();
      } catch {
        return { ok: false, status: 503, error: 'redis_proxy_not_configured' };
      }
      const readable = await canReadRoom(redis, code, cookies[SESSION_COOKIE] ?? '', cookies[GUEST_COOKIE] ?? '');
      if (!readable) return { ok: false, status: 403, error: 'room_access_required' };
      allowed.add(code);
    }
  }
  return { ok: true };
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

  const roomAccess = await authorizeRedisRoomRead(request, pathname, checked.body);
  if (!roomAccess.ok) {
    writeJson(response, roomAccess.status, { error: roomAccess.error });
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
      console.error('[redis-proxy] upstream returned non-2xx', { status: upstream.status });
      writeJson(response, 502, { error: 'redis_upstream_unavailable' });
      return;
    }
    response.statusCode = upstream.status;
    response.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    console.error('[redis-proxy] upstream fetch failed', redisUpstreamFailureDetails(error));
    writeJson(response, 502, { error: 'redis_upstream_unavailable' });
  }
}

function sendHealth(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

async function pingRedisRest(url: string | undefined, token: string | undefined): Promise<boolean> {
  if (!url || !token) return false;
  try {
    const result = await createClient({ url, token }).command<string>(['PING']);
    return result === 'PONG';
  } catch {
    return false;
  }
}

async function handleReady(response: ServerResponse): Promise<void> {
  const [privateRedis, webRedis] = await Promise.all([
    pingRedisRest(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN),
    pingRedisRest(process.env.SRH_WEB_URL, process.env.SRH_WEB_TOKEN),
  ]);
  const ready = privateRedis && webRedis;
  sendHealth(response, ready ? 200 : 503, { ready, privateRedis, webRedis });
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
  webRoot = WEB_ROOT,
): Promise<boolean> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendHealth(response, 400, { error: 'invalid_path' });
    return true;
  }
  const filePath = resolve(webRoot, `.${decodedPath === '/' ? '/index.html' : decodedPath}`);
  const relativePath = relative(webRoot, filePath);
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

async function handleSseGet(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  sessions: Map<string, SseSession>,
  options: Required<Pick<VpsServerOptions, 'sseHeartbeatMs' | 'maxSseSessions'>>,
): Promise<void> {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    writeJson(response, 405, { error: 'method_not_allowed' });
    return;
  }
  if (sessions.size >= options.maxSseSessions) {
    writeJson(response, 503, { error: 'sse_session_limit_reached' });
    return;
  }

  const profile: McpProfile = url.searchParams.get('profile') === 'core' ? 'core' : 'full';
  let mcpServer: McpServer | undefined;
  let transport: SSEServerTransport | undefined;
  try {
    const roomClient = createRemoteRoomClient(
      typeof request.headers.host === 'string' ? request.headers.host : undefined,
    );
    mcpServer = createMcpServer(
      roomClient,
      profile,
      (server) => detectHarness(request.headers['user-agent'], server.getClientVersion()?.name),
    );
    response.setHeader('X-Accel-Buffering', 'no');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    // The process-wide socket timeout is for ordinary requests. This GET is a
    // deliberate long-lived stream and has its own heartbeat and session cap.
    request.socket.setTimeout(0);
    transport = new SSEServerTransport('/sse/messages', response);
    const sessionId = transport.sessionId;
    let session!: SseSession;
    const close = () => {
      if (session.closed) return;
      session.closed = true;
      if (session.heartbeat) clearInterval(session.heartbeat);
      sessions.delete(sessionId);
      void session.transport.close().catch(() => {});
      void session.mcpServer.close().catch(() => {});
    };
    session = { transport, mcpServer, closed: false, close };
    sessions.set(sessionId, session);
    transport.onclose = close;
    transport.onerror = close;
    response.once('close', close);
    response.once('error', close);

    await mcpServer.connect(transport);
    if (!session.closed) {
      session.heartbeat = setInterval(() => {
        if (response.destroyed || response.writableEnded) {
          close();
          return;
        }
        try {
          response.write(': ping\n\n');
        } catch {
          close();
        }
      }, options.sseHeartbeatMs);
      session.heartbeat.unref();
    }
  } catch {
    const session = transport ? sessions.get(transport.sessionId) : undefined;
    if (session) session.close();
    else {
      void transport?.close().catch(() => {});
      void mcpServer?.close().catch(() => {});
    }
    if (!response.headersSent) writeJson(response, 500, { error: 'sse_session_start_failed' });
    else response.destroy();
  }
}

async function handleSsePost(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  sessions: Map<string, SseSession>,
): Promise<void> {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    writeJson(response, 405, { error: 'method_not_allowed' });
    return;
  }
  const ids = url.searchParams.getAll('sessionId');
  const sessionId = ids[0];
  if (ids.length !== 1 || !sessionId || sessionId.length > 128) {
    writeJson(response, 400, { error: 'invalid_session_id' });
    return;
  }
  const session = sessions.get(sessionId);
  if (!session || session.closed) {
    writeJson(response, 404, { error: 'unknown_sse_session' });
    return;
  }

  session.heartbeat?.refresh();
  const contentType = String(request.headers['content-type'] ?? '')
    .split(';', 1)[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') {
    try {
      await session.transport.handlePostMessage(request, response);
    } catch {
      session.close();
    }
    if (response.statusCode >= 400) session.close();
    return;
  }

  let body: unknown;
  try {
    const raw = await readRequestBody(request, Math.min(API_BODY_LIMIT_BYTES, SSE_BODY_LIMIT_BYTES));
    if (!raw.length) throw new RequestBodyError('Request body must contain valid JSON.', 400);
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch (error) {
    const statusCode = error instanceof RequestBodyError ? error.status : 400;
    writeJson(response, statusCode, {
      error: statusCode === 413 ? 'body_too_large' : 'invalid_json',
      message: error instanceof Error ? error.message : 'Request body must contain valid JSON.',
    });
    session.close();
    return;
  }

  try {
    await session.transport.handlePostMessage(request, response, body);
    if (response.statusCode >= 400) session.close();
  } catch {
    if (!response.headersSent) writeJson(response, 500, { error: 'sse_message_failed' });
    else response.destroy();
    session.close();
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  sessions: Map<string, SseSession>,
  webRoot: string,
  sseOptions: Required<Pick<VpsServerOptions, 'sseHeartbeatMs' | 'maxSseSessions'>>,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://agent-room.local');
  } catch {
    writeJson(response, 400, { error: 'invalid_url' });
    return;
  }

  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  // These exact protocol routes precede API mapping and static SPA fallback.
  if (pathname === '/sse') {
    await handleSseGet(request, response, url, sessions, sseOptions);
    return;
  }
  if (pathname === '/sse/messages') {
    await handleSsePost(request, response, url, sessions);
    return;
  }
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
  if (await serveStaticFile(response, pathname, headOnly, webRoot)) return;
  if (extname(pathname)) {
    writeJson(response, 404, { error: 'not_found' });
    return;
  }
  if (await serveStaticFile(response, '/index.html', headOnly, webRoot)) return;
  writeJson(response, 500, { error: 'web_assets_unavailable' });
}

export function createVpsApp(options: VpsServerOptions = {}): VpsApp {
  const host = options.host ?? HOST;
  const port = options.port ?? parsePort(process.env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('port must be an integer from 0 to 65535.');
  }
  const webRoot = resolve(options.webRoot ?? WEB_ROOT);
  const sseOptions = {
    sseHeartbeatMs: options.sseHeartbeatMs ?? SSE_HEARTBEAT_MS,
    maxSseSessions: options.maxSseSessions ?? MAX_SSE_SESSIONS,
  };
  if (!Number.isSafeInteger(sseOptions.sseHeartbeatMs) || sseOptions.sseHeartbeatMs <= 0) {
    throw new Error('sseHeartbeatMs must be a positive integer.');
  }
  if (!Number.isSafeInteger(sseOptions.maxSseSessions) || sseOptions.maxSseSessions <= 0) {
    throw new Error('maxSseSessions must be a positive integer.');
  }

  const sessions = new Map<string, SseSession>();
  const server = createHttpServer((request, response) => {
    void handleRequest(request, response, sessions, webRoot, sseOptions);
  });
  server.requestTimeout = MCP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = MCP_REQUEST_TIMEOUT_MS;
  server.setTimeout(MCP_REQUEST_TIMEOUT_MS);
  server.keepAliveTimeout = 65_000;

  return {
    server,
    getSseSessionCount: () => sessions.size,
    async close() {
      for (const session of [...sessions.values()]) session.close();
      if (!server.listening) return;
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

function startServer(): void {
  const app = createVpsApp();
  const port = parsePort(process.env.PORT);
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.VITE_UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.VITE_UPSTASH_REDIS_REST_TOKEN;
  const patrol = url && token ? startWakePatrol(createClient({ url, token })) : undefined;
  if (url && token) installWakeSendHook(createClient({ url, token }));
  app.server.listen(port, HOST, () => {
    process.stdout.write(`Agent Room listening on ${HOST}:${port}\n`);
  });
  const close = () => {
    patrol?.stop();
    void app.close().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startServer();
}
