import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { UpstashClient } from '@agent-room/upstash-client';
import {
  SESSION_TTL_SECONDS,
  AccountError,
  type PublicUser,
  type UserRecord,
  publicUser,
  readSession,
  touchSession,
} from './_accounts.js';
import { GUEST_COOKIE, GUEST_TTL_MS } from './_roomAccess.js';
import { serverRedis } from './_redisEnv.js';

export const SESSION_COOKIE = 'ar_session';
export { GUEST_COOKIE };

export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw === 'string' && raw.trim()) return raw.split(',')[0]!.trim().slice(0, 80);
  return (req.socket.remoteAddress ?? 'unknown').slice(0, 80);
}

export function clientUa(req: IncomingMessage): string {
  const ua = req.headers['user-agent'];
  return (Array.isArray(ua) ? ua[0] : ua ?? '').slice(0, 200);
}

export function jsonBody(req: VercelRequest): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return {};
  return req.body as Record<string, unknown>;
}

export function sendJson(res: VercelResponse | ServerResponse, status: number, body: unknown): void {
  const response = res as VercelResponse;
  if (typeof response.status === 'function') {
    response.status(status).json(body);
    return;
  }
  const raw = res as ServerResponse;
  raw.statusCode = status;
  raw.setHeader('Content-Type', 'application/json; charset=utf-8');
  raw.setHeader('Cache-Control', 'no-store');
  raw.end(JSON.stringify(body));
}

export function sessionCookie(token: string, maxAge = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function guestCookie(token: string): string {
  const maxAge = Math.ceil(GUEST_TTL_MS / 1000);
  return `${GUEST_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function readCookie(req: VercelRequest, name: string): string {
  return req.cookies?.[name] ?? '';
}

export interface AuthContext {
  redis: UpstashClient;
  token: string;
  hash: string;
  user: UserRecord;
}

export async function requireUser(req: VercelRequest, redis = serverRedis()): Promise<AuthContext> {
  const token = readCookie(req, SESSION_COOKIE);
  const found = await readSession(redis, token);
  if (!found) throw new AccountError('Authentication required.', 401, 'unauthenticated');
  await touchSession(redis, found.hash, found.session);
  return { redis, token, hash: found.hash, user: found.user };
}

export async function requireAdmin(req: VercelRequest, redis = serverRedis()): Promise<AuthContext> {
  const auth = await requireUser(req, redis);
  if (auth.user.role !== 'admin') throw new AccountError('Admin only.', 403, 'forbidden');
  return auth;
}

export function sendAccountError(res: VercelResponse, error: unknown): void {
  if (error instanceof AccountError) {
    sendJson(res, error.status, { error: error.code, message: error.message });
    return;
  }
  if (error instanceof Error && error.name === 'RedisNotConfiguredError') {
    sendJson(res, 503, { error: 'not_configured', message: 'Account storage is not configured.' });
    return;
  }
  console.error('[account] request failed', error instanceof Error ? error.name : 'Error');
  sendJson(res, 500, { error: 'internal_server_error', message: 'Request failed.' });
}

export function userPayload(user: UserRecord): { user: PublicUser } {
  return { user: publicUser(user) };
}
