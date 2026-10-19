// Account store (design §4.1). Redis only, server-side. Passwords are scrypt
// hashes with a per-user salt; sessions store the SHA-256 of the token.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { UpstashClient } from '@agent-room/upstash-client';

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;
export const SESSION_TTL_MS = 15 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
export const USERNAME_FAIL_LIMIT = 5;
export const USERNAME_WINDOW_MS = 15 * 60 * 1000;
export const USERNAME_LOCK_MS = 15 * 60 * 1000;
export const IP_ATTEMPT_LIMIT = 30;
export const IP_WINDOW_MS = 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export const INVALID_LOGIN_MESSAGE = 'Invalid username or password.';
export const RATE_LIMIT_MESSAGE = 'Too many attempts. Try again later.';

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;

export type UserRole = 'admin' | 'user';

export interface PasswordRecord {
  algo: 'scrypt';
  salt: string;
  hash: string;
  params: { N: number; r: number; p: number; keylen: number };
}

export interface UserRecord {
  id: string;
  username: string;
  email?: string;
  role: UserRole;
  disabled: boolean;
  password: PasswordRecord;
  createdAt: number;
  updatedAt: number;
}

export interface PublicUser {
  id: string;
  username: string;
  email: string | null;
  role: UserRole;
  disabled: boolean;
  createdAt: number;
}

export interface SessionRecord {
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ua: string;
  ip: string;
}

export interface PublicSession {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ua: string;
  ip: string;
  current: boolean;
}

export class AccountError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'AccountError';
  }
}

export function publicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email ?? null,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt,
  };
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function assertUsername(username: string): string {
  const trimmed = username.trim();
  if (!USERNAME_RE.test(trimmed)) {
    throw new AccountError('Username must be 3–32 characters: letters, digits, dot, underscore, or hyphen.', 400, 'invalid_username');
  }
  return trimmed;
}

export function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new AccountError(`Password must be ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters.`, 400, 'invalid_password');
  }
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return {
    algo: 'scrypt',
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    params: { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, keylen: SCRYPT_PARAMS.keylen },
  };
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  const salt = Buffer.from(record.salt, 'base64');
  const expected = Buffer.from(record.hash, 'base64');
  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, expected.length, {
      N: record.params.N,
      r: record.params.r,
      p: record.params.p,
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Burn a scrypt when the user does not exist so the two failures take similar time. */
const DUMMY_SALT = randomBytes(16);
let dummyHashPromise: Promise<Buffer> | null = null;
function dummyHash(): Promise<Buffer> {
  dummyHashPromise ??= scrypt('not-a-real-password', DUMMY_SALT, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return dummyHashPromise;
}

async function burnPasswordTime(password: string): Promise<void> {
  const actual = await scrypt(password, DUMMY_SALT, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  const expected = await dummyHash();
  if (actual.length === expected.length) timingSafeEqual(actual, expected);
}

function userKey(id: string): string { return `user:${id}`; }
function userByNameKey(username: string): string { return `user-by-name:${normalizeUsername(username)}`; }
function sessionsKey(userId: string): string { return `user-sessions:${userId}`; }
function sessionKey(hash: string): string { return `session:${hash}`; }
function deviceUserKey(userId: string): string { return `device-user:${userId}`; }
function deviceKey(id: string): string { return `device:${id}`; }

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

async function readJson<T>(client: UpstashClient, key: string): Promise<T | null> {
  const raw = await client.command<string | null>(['GET', key]);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function getUserById(client: UpstashClient, id: string): Promise<UserRecord | null> {
  return readJson<UserRecord>(client, userKey(id));
}

export async function getUserByName(client: UpstashClient, username: string): Promise<UserRecord | null> {
  const id = await client.command<string | null>(['GET', userByNameKey(username)]);
  if (!id) return null;
  return getUserById(client, id);
}

export async function hasAdmin(client: UpstashClient): Promise<boolean> {
  const count = await client.command<number>(['SCARD', 'user-admins']);
  return Number(count) > 0;
}

export async function createUser(
  client: UpstashClient,
  input: { username: string; password: string; role: UserRole; email?: string },
  now = Date.now(),
): Promise<UserRecord> {
  const username = assertUsername(input.username);
  assertPassword(input.password);
  const existing = await client.command<string | null>(['GET', userByNameKey(username)]);
  if (existing) throw new AccountError('That username is already taken.', 409, 'username_taken');
  const user: UserRecord = {
    id: `usr_${randomBytes(16).toString('hex')}`,
    username,
    ...(input.email?.trim() ? { email: input.email.trim() } : {}),
    role: input.role,
    disabled: false,
    password: await hashPassword(input.password),
    createdAt: now,
    updatedAt: now,
  };
  const indexed = await client.command<string | null>(['SET', userByNameKey(username), user.id, 'NX']);
  if (indexed !== 'OK') throw new AccountError('That username is already taken.', 409, 'username_taken');
  await client.command(['SET', userKey(user.id), JSON.stringify(user)]);
  await client.command(['SADD', 'user-index', user.id]);
  if (user.role === 'admin') await client.command(['SADD', 'user-admins', user.id]);
  return user;
}

async function saveUser(client: UpstashClient, user: UserRecord): Promise<void> {
  await client.command(['SET', userKey(user.id), JSON.stringify(user)]);
}

export async function listUsers(client: UpstashClient): Promise<UserRecord[]> {
  const ids = await client.command<string[]>(['SMEMBERS', 'user-index']);
  const users: UserRecord[] = [];
  for (const id of ids ?? []) {
    const user = await getUserById(client, id);
    if (user) users.push(user);
  }
  users.sort((a, b) => a.username.localeCompare(b.username));
  return users;
}

interface WindowCounter { count: number; resetAt: number }

async function readCounter(client: UpstashClient, key: string, now: number, windowMs: number): Promise<WindowCounter> {
  const current = await readJson<WindowCounter>(client, key);
  if (!current || !Number.isFinite(current.resetAt) || now >= current.resetAt) {
    return { count: 0, resetAt: now + windowMs };
  }
  return current;
}

export async function assertLoginAllowed(
  client: UpstashClient,
  username: string,
  ip: string,
  now = Date.now(),
): Promise<void> {
  const ipCounter = await readCounter(client, `ratelimit:ip:${ip}`, now, IP_WINDOW_MS);
  if (ipCounter.count >= IP_ATTEMPT_LIMIT) {
    throw new AccountError(RATE_LIMIT_MESSAGE, 429, 'rate_limited');
  }
  await noteLoginAttempt(client, ip, now);
  const lock = await readJson<{ until: number }>(client, `ratelimit:lock:user:${normalizeUsername(username)}`);
  if (lock && lock.until > now) {
    throw new AccountError(RATE_LIMIT_MESSAGE, 429, 'rate_limited');
  }
}

async function noteLoginAttempt(client: UpstashClient, ip: string, now: number): Promise<void> {
  const key = `ratelimit:ip:${ip}`;
  const counter = await readCounter(client, key, now, IP_WINDOW_MS);
  counter.count += 1;
  const ttl = Math.max(1, Math.ceil((counter.resetAt - now) / 1000));
  await client.command(['SET', key, JSON.stringify(counter), 'EX', ttl]);
}

async function noteLoginFailure(client: UpstashClient, username: string, now: number): Promise<void> {
  const name = normalizeUsername(username);
  const key = `ratelimit:user:${name}`;
  const counter = await readCounter(client, key, now, USERNAME_WINDOW_MS);
  counter.count += 1;
  if (counter.count >= USERNAME_FAIL_LIMIT) {
    const until = now + USERNAME_LOCK_MS;
    await client.command(['SET', `ratelimit:lock:user:${name}`, JSON.stringify({ until }), 'EX', Math.ceil(USERNAME_LOCK_MS / 1000)]);
    await client.command(['DEL', key]);
    return;
  }
  const ttl = Math.max(1, Math.ceil((counter.resetAt - now) / 1000));
  await client.command(['SET', key, JSON.stringify(counter), 'EX', ttl]);
}

export interface LoginSuccess {
  user: PublicUser;
  token: string;
  session: SessionRecord;
}

export async function login(
  client: UpstashClient,
  input: { username: string; password: string; ip: string; ua: string },
  now = Date.now(),
): Promise<LoginSuccess> {
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (!username || !password) {
    throw new AccountError(INVALID_LOGIN_MESSAGE, 401, 'invalid_credentials');
  }
  await assertLoginAllowed(client, username, input.ip || 'unknown', now);
  const user = USERNAME_RE.test(username) ? await getUserByName(client, username) : null;
  const matches = user
    ? await verifyPassword(password, user.password)
    : await burnPasswordTime(password).then(() => false);
  if (!user || !matches || user.disabled) {
    await noteLoginFailure(client, username, now);
    throw new AccountError(INVALID_LOGIN_MESSAGE, 401, 'invalid_credentials');
  }
  await client.command(['DEL', `ratelimit:user:${normalizeUsername(username)}`]);
  const issued = await issueSession(client, user.id, { ip: input.ip, ua: input.ua }, now);
  return { user: publicUser(user), ...issued };
}

export async function issueSession(
  client: UpstashClient,
  userId: string,
  meta: { ip: string; ua: string },
  now = Date.now(),
): Promise<{ token: string; session: SessionRecord }> {
  const token = newToken();
  const hash = hashToken(token);
  const session: SessionRecord = {
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_TTL_MS,
    ua: (meta.ua || '').slice(0, 200),
    ip: (meta.ip || '').slice(0, 80),
  };
  await client.command(['SET', sessionKey(hash), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS]);
  await client.command(['SADD', sessionsKey(userId), hash]);
  return { token, session };
}

export async function readSession(
  client: UpstashClient,
  token: string,
  now = Date.now(),
): Promise<{ hash: string; session: SessionRecord; user: UserRecord } | null> {
  if (!token) return null;
  const hash = hashToken(token);
  const session = await readJson<SessionRecord>(client, sessionKey(hash));
  if (!session || session.expiresAt <= now) {
    if (session) await revokeSession(client, hash);
    return null;
  }
  const user = await getUserById(client, session.userId);
  if (!user || user.disabled) {
    await revokeSession(client, hash);
    return null;
  }
  return { hash, session, user };
}

/** Sliding 15-day expiry. Call on authenticated requests. */
export async function touchSession(
  client: UpstashClient,
  hash: string,
  session: SessionRecord,
  now = Date.now(),
): Promise<SessionRecord> {
  const next: SessionRecord = {
    ...session,
    lastSeenAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  await client.command(['SET', sessionKey(hash), JSON.stringify(next), 'EX', SESSION_TTL_SECONDS]);
  return next;
}

export async function revokeSession(client: UpstashClient, hash: string): Promise<boolean> {
  const session = await readJson<SessionRecord>(client, sessionKey(hash));
  const removed = await client.command<number>(['DEL', sessionKey(hash)]);
  if (session) await client.command(['SREM', sessionsKey(session.userId), hash]);
  return Number(removed) > 0;
}

export async function revokeAllSessions(client: UpstashClient, userId: string, exceptHash?: string): Promise<number> {
  const hashes = await client.command<string[]>(['SMEMBERS', sessionsKey(userId)]);
  let revoked = 0;
  for (const hash of hashes ?? []) {
    if (hash === exceptHash) continue;
    if (await revokeSession(client, hash)) revoked += 1;
  }
  return revoked;
}

export async function listSessions(
  client: UpstashClient,
  userId: string,
  currentHash?: string,
  now = Date.now(),
): Promise<PublicSession[]> {
  const hashes = await client.command<string[]>(['SMEMBERS', sessionsKey(userId)]);
  const sessions: PublicSession[] = [];
  for (const hash of hashes ?? []) {
    const session = await readJson<SessionRecord>(client, sessionKey(hash));
    if (!session || session.expiresAt <= now) {
      await revokeSession(client, hash);
      continue;
    }
    sessions.push({
      id: hash,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      ua: session.ua,
      ip: session.ip,
      current: hash === currentHash,
    });
  }
  sessions.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return sessions;
}

export async function changePassword(
  client: UpstashClient,
  user: UserRecord,
  currentPassword: string,
  nextPassword: string,
  keepSessionHash: string,
  now = Date.now(),
): Promise<void> {
  assertPassword(nextPassword);
  if (!await verifyPassword(currentPassword, user.password)) {
    throw new AccountError(INVALID_LOGIN_MESSAGE, 401, 'invalid_credentials');
  }
  user.password = await hashPassword(nextPassword);
  user.updatedAt = now;
  await saveUser(client, user);
  await revokeAllSessions(client, user.id, keepSessionHash);
}

export async function setUserDisabled(
  client: UpstashClient,
  userId: string,
  disabled: boolean,
  now = Date.now(),
): Promise<UserRecord> {
  const user = await getUserById(client, userId);
  if (!user) throw new AccountError('User not found.', 404, 'user_not_found');
  user.disabled = disabled;
  user.updatedAt = now;
  await saveUser(client, user);
  if (disabled) {
    await revokeAllSessions(client, user.id);
    await revokeUserDevices(client, user.id);
  }
  return user;
}

export async function resetUserPassword(
  client: UpstashClient,
  userId: string,
  password: string,
  now = Date.now(),
): Promise<UserRecord> {
  assertPassword(password);
  const user = await getUserById(client, userId);
  if (!user) throw new AccountError('User not found.', 404, 'user_not_found');
  user.password = await hashPassword(password);
  user.updatedAt = now;
  await saveUser(client, user);
  await revokeAllSessions(client, user.id);
  return user;
}

/** Device pairing is a later track. Disable/revoke still clears any device keys already stored. */
export async function revokeUserDevices(client: UpstashClient, userId: string): Promise<number> {
  const ids = await client.command<string[]>(['SMEMBERS', deviceUserKey(userId)]);
  let removed = 0;
  for (const id of ids ?? []) {
    removed += Number(await client.command<number>(['DEL', deviceKey(id)])) > 0 ? 1 : 0;
  }
  await client.command(['DEL', deviceUserKey(userId)]);
  return removed;
}

export async function listUserDevices(): Promise<[]> {
  return [];
}

export interface AuditEntry {
  id: string;
  at: number;
  actorId: string;
  action: string;
  targetUserId?: string;
}

export async function writeAudit(
  client: UpstashClient,
  entry: Omit<AuditEntry, 'id' | 'at'> & { at?: number },
): Promise<void> {
  const row: AuditEntry = {
    id: `aud_${randomBytes(8).toString('hex')}`,
    at: entry.at ?? Date.now(),
    actorId: entry.actorId,
    action: entry.action,
    ...(entry.targetUserId ? { targetUserId: entry.targetUserId } : {}),
  };
  await client.command(['SET', `audit:${row.id}`, JSON.stringify(row)]);
  await client.command(['SADD', 'audit:index', row.id]);
}
