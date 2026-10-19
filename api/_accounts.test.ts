import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { MemoryRedis } from './_memoryRedis.js';
import {
  INVALID_LOGIN_MESSAGE,
  RATE_LIMIT_MESSAGE,
  SESSION_TTL_MS,
  USERNAME_FAIL_LIMIT,
  changePassword,
  createUser,
  getUserById,
  hashToken,
  hasAdmin,
  listSessions,
  listUserDevices,
  login,
  readSession,
  resetUserPassword,
  revokeAllSessions,
  revokeSession,
  setUserDisabled,
  touchSession,
} from './_accounts.js';

const PASSWORD = 'correct-horse-battery';

async function admin(redis: MemoryRedis) {
  return createUser(redis, { username: 'Ada', password: PASSWORD, role: 'admin' });
}

describe('accounts', () => {
  it('stores scrypt password material and a lowercase username index, never the raw password', async () => {
    const redis = new MemoryRedis();
    const user = await admin(redis);
    const stored = JSON.parse(await redis.command<string>(['GET', `user:${user.id}`]));
    expect(stored.password.algo).toBe('scrypt');
    expect(stored.password.salt).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(stored.password.hash).not.toBe(PASSWORD);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(await redis.command(['GET', 'user-by-name:ada'])).toBe(user.id);
    expect(await hasAdmin(redis)).toBe(true);
  });

  it('uses a different salt per user', async () => {
    const redis = new MemoryRedis();
    const a = await createUser(redis, { username: 'Ada', password: PASSWORD, role: 'admin' });
    const b = await createUser(redis, { username: 'Bea', password: PASSWORD, role: 'user' });
    expect(a.password.salt).not.toBe(b.password.salt);
    expect(a.password.hash).not.toBe(b.password.hash);
  });

  it('issues a session whose Redis value is the SHA-256 of the token', async () => {
    const redis = new MemoryRedis();
    await admin(redis);
    const result = await login(redis, { username: 'ada', password: PASSWORD, ip: '203.0.113.5', ua: 'TestBrowser' });
    const hash = hashToken(result.token);
    expect(hash).toBe(createHash('sha256').update(result.token, 'utf8').digest('hex'));
    const raw = await redis.command<string>(['GET', `session:${hash}`]);
    expect(raw).not.toContain(result.token);
    const session = JSON.parse(raw);
    expect(session.userId).toBe(result.user.id);
    expect(session.ip).toBe('203.0.113.5');
    expect(session.expiresAt - session.createdAt).toBe(SESSION_TTL_MS);
    expect(await redis.command(['SISMEMBER', `user-sessions:${result.user.id}`, hash])).toBe(1);
  });

  it('returns the same error for an unknown user and a wrong password', async () => {
    const redis = new MemoryRedis();
    await admin(redis);
    await expect(login(redis, { username: 'nobody', password: 'whatever-password', ip: '1.1.1.1', ua: '' }))
      .rejects.toMatchObject({ status: 401, message: INVALID_LOGIN_MESSAGE, code: 'invalid_credentials' });
    await expect(login(redis, { username: 'Ada', password: 'wrong-password-1', ip: '1.1.1.2', ua: '' }))
      .rejects.toMatchObject({ status: 401, message: INVALID_LOGIN_MESSAGE, code: 'invalid_credentials' });
  });

  it('locks a username after repeated failures and limits an IP per minute', async () => {
    const redis = new MemoryRedis();
    await admin(redis);
    for (let i = 0; i < USERNAME_FAIL_LIMIT; i++) {
      await expect(login(redis, { username: 'Ada', password: `wrong-password-${i}`, ip: '198.51.100.2', ua: '' }))
        .rejects.toMatchObject({ status: 401 });
    }
    await expect(login(redis, { username: 'Ada', password: PASSWORD, ip: '198.51.100.3', ua: '' }))
      .rejects.toMatchObject({ status: 429, message: RATE_LIMIT_MESSAGE });

    for (let i = 0; i < USERNAME_FAIL_LIMIT; i++) {
      await expect(login(redis, { username: 'ghost-user', password: `wrong-password-${i}`, ip: `203.0.113.${i + 10}`, ua: '' }))
        .rejects.toMatchObject({ status: 401, message: INVALID_LOGIN_MESSAGE });
    }
    await expect(login(redis, { username: 'ghost-user', password: PASSWORD, ip: '203.0.113.40', ua: '' }))
      .rejects.toMatchObject({ status: 429, message: RATE_LIMIT_MESSAGE });

    const fresh = new MemoryRedis();
    await createUser(fresh, { username: 'Cara', password: PASSWORD, role: 'user' });
    const resetAt = Date.now() + 60_000;
    await fresh.command(['SET', 'ratelimit:ip:198.51.100.9', JSON.stringify({ count: 29, resetAt })]);
    await expect(login(fresh, { username: 'Cara', password: PASSWORD, ip: '198.51.100.9', ua: '' }))
      .resolves.toMatchObject({ user: { username: 'Cara' } });
    await expect(login(fresh, { username: 'Cara', password: PASSWORD, ip: '198.51.100.9', ua: '' }))
      .rejects.toMatchObject({ status: 429, code: 'rate_limited' });
  });

  it('slides the session expiry and drops a revoked session', async () => {
    const redis = new MemoryRedis();
    const user = await admin(redis);
    const { token } = await login(redis, { username: 'Ada', password: PASSWORD, ip: '1.1.1.1', ua: 'A' });
    const opened = await readSession(redis, token, Date.now());
    expect(opened).not.toBeNull();
    const later = opened!.session.createdAt + 60_000;
    const touched = await touchSession(redis, opened!.hash, opened!.session, later);
    expect(touched.expiresAt).toBe(later + SESSION_TTL_MS);
    expect(touched.lastSeenAt).toBe(later);

    const other = await login(redis, { username: 'Ada', password: PASSWORD, ip: '1.1.1.8', ua: 'B' });
    expect(await revokeSession(redis, hashToken(other.token))).toBe(true);
    expect(await readSession(redis, other.token)).toBeNull();
    expect((await listSessions(redis, user.id, opened!.hash)).map(s => s.current)).toEqual([true]);

    await changePassword(redis, (await getUserById(redis, user.id))!, PASSWORD, 'new-password-ok', opened!.hash);
    expect(await readSession(redis, token)).not.toBeNull();
    await expect(login(redis, { username: 'Ada', password: PASSWORD, ip: '1.1.1.1', ua: '' })).rejects.toMatchObject({ status: 401 });
    const kept = await login(redis, { username: 'Ada', password: 'new-password-ok', ip: '9.9.9.9', ua: 'C' });
    await revokeAllSessions(redis, user.id, hashToken(kept.token));
    expect(await readSession(redis, token)).toBeNull();
    expect(await readSession(redis, kept.token)).not.toBeNull();
  });

  it('disabling a user revokes sessions and device credentials', async () => {
    const redis = new MemoryRedis();
    const user = await admin(redis);
    const { token } = await login(redis, { username: 'Ada', password: PASSWORD, ip: '1.1.1.1', ua: '' });
    await redis.command(['SADD', `device-user:${user.id}`, 'dev_1']);
    await redis.command(['SET', 'device:dev_1', '{"name":"laptop"}']);
    await setUserDisabled(redis, user.id, true);
    expect(await readSession(redis, token)).toBeNull();
    expect(await redis.command(['GET', 'device:dev_1'])).toBeNull();
    expect(await listUserDevices()).toEqual([]);
    await expect(login(redis, { username: 'Ada', password: PASSWORD, ip: '8.8.8.8', ua: '' }))
      .rejects.toMatchObject({ status: 401, message: INVALID_LOGIN_MESSAGE });
  });

  it('resetting a password revokes every session', async () => {
    const redis = new MemoryRedis();
    const user = await admin(redis);
    const first = await login(redis, { username: 'Ada', password: PASSWORD, ip: '1.1.1.1', ua: '' });
    await resetUserPassword(redis, user.id, 'rotated-password');
    expect(await readSession(redis, first.token)).toBeNull();
    await expect(login(redis, { username: 'Ada', password: 'rotated-password', ip: '1.1.1.1', ua: '' })).resolves.toMatchObject({
      user: { username: 'Ada' },
    });
  });
});
