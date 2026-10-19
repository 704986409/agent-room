// Device pairing (design §2.3). Redis stores hashes of pairing codes and
// credentials, never the raw secrets. Revoke also drops wake bindings.

import { randomBytes } from 'node:crypto';
import type { UpstashClient } from '@agent-room/upstash-client';
import { AccountError, getUserById, hashToken } from './_accounts.js';
import { revokeDevice as revokeWakeDevice } from './_wakeBind.js';

export const PAIRING_TTL_SECONDS = 300;
export const PAIRING_LIMIT = 5;
const LAST_SEEN_INTERVAL_MS = 60_000;
const DEVICE_ID_RE = /^[\w.-]{1,128}$/;
const CRED_HASH_RE = /^[a-f0-9]{64}$/;

export interface DeviceRecord {
  deviceId: string;
  userId: string;
  name: string;
  platform: string;
  hostname?: string;
  createdAt: number;
  lastSeenAt: number;
  credHash: string;
  revokedAt?: number;
}

export interface PublicDevice {
  deviceId: string;
  name: string;
  platform: string;
  hostname: string | null;
  createdAt: number;
  lastSeenAt: number;
}

type Redis = Pick<UpstashClient, 'command'>;

export function deviceRecordKey(deviceId: string): string { return `device:${deviceId}`; }
function deviceUserKey(userId: string): string { return `device-user:${userId}`; }
function pairKey(code: string): string { return `device-pair:${hashToken(code)}`; }
function credKey(token: string): string { return `device-cred:${hashToken(token)}`; }
function pairCountKey(userId: string): string { return `device-pair-count:${userId}`; }

async function readJson<T>(client: Redis, key: string): Promise<T | null> {
  const raw = await client.command<string | null>(['GET', key]);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readDevice(client: Redis, deviceId: string): Promise<DeviceRecord | null> {
  if (!DEVICE_ID_RE.test(deviceId)) return null;
  return readJson<DeviceRecord>(client, deviceRecordKey(deviceId));
}

function cleanField(value: unknown, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new AccountError('Device name and platform must be 1–64 characters.', 400, 'invalid_device');
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new AccountError('Device name and platform must be 1–64 characters.', 400, 'invalid_device');
  }
  const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
  if (!cleaned) {
    if (required) throw new AccountError('Device name and platform must be 1–64 characters.', 400, 'invalid_device');
    return undefined;
  }
  if (cleaned.length > max) {
    throw new AccountError('Device name and platform must be 1–64 characters.', 400, 'invalid_device');
  }
  return cleaned;
}

export async function startPairing(
  client: Redis,
  userId: string,
  now = Date.now(),
): Promise<{ pairingCode: string; expiresAt: number }> {
  const count = Number(await client.command(['INCR', pairCountKey(userId)]));
  if (count === 1) await client.command(['EXPIRE', pairCountKey(userId), PAIRING_TTL_SECONDS]);
  if (!Number.isFinite(count) || count > PAIRING_LIMIT) {
    throw new AccountError('Too many pairing codes. Try again later.', 429, 'pairing_rate_limited');
  }
  const pairingCode = randomBytes(32).toString('base64url');
  const createdAt = now;
  const ok = await client.command([
    'SET', pairKey(pairingCode), JSON.stringify({ userId, createdAt }), 'EX', PAIRING_TTL_SECONDS, 'NX',
  ]);
  if (ok !== 'OK') throw new AccountError('Could not issue a pairing code.', 500, 'internal_server_error');
  return { pairingCode, expiresAt: createdAt + PAIRING_TTL_SECONDS * 1000 };
}

export async function completePairing(
  client: Redis,
  input: { pairingCode: unknown; deviceName: unknown; platform: unknown; hostname?: unknown },
  now = Date.now(),
): Promise<{ deviceId: string; deviceCredential: string; userId: string; name: string }> {
  const name = cleanField(input.deviceName, 64, true)!;
  const platform = cleanField(input.platform, 64, true)!;
  const hostname = cleanField(input.hostname, 64, false);
  const pairingCode = typeof input.pairingCode === 'string' ? input.pairingCode.trim() : '';
  if (!pairingCode || pairingCode.length > 200) {
    throw new AccountError('Pairing code is invalid or expired.', 400, 'pairing_code_invalid');
  }
  const raw = await client.command<string | null>(['GETDEL', pairKey(pairingCode)]);
  if (!raw) throw new AccountError('Pairing code is invalid or expired.', 400, 'pairing_code_invalid');
  let parsed: { userId?: string; createdAt?: number };
  try {
    parsed = JSON.parse(raw) as { userId?: string; createdAt?: number };
  } catch {
    throw new AccountError('Pairing code is invalid or expired.', 400, 'pairing_code_invalid');
  }
  const createdAt = Number(parsed.createdAt);
  if (!parsed.userId || !Number.isFinite(createdAt) || now - createdAt > PAIRING_TTL_SECONDS * 1000) {
    throw new AccountError('Pairing code is invalid or expired.', 400, 'pairing_code_invalid');
  }
  const user = await getUserById(client as UpstashClient, parsed.userId);
  if (!user || user.disabled) throw new AccountError('This account is disabled.', 403, 'user_disabled');

  const deviceCredential = `ard_${randomBytes(32).toString('base64url')}`;
  const deviceId = `dev_${randomBytes(12).toString('hex')}`;
  const credHash = hashToken(deviceCredential);
  const record: DeviceRecord = {
    deviceId,
    userId: user.id,
    name,
    platform,
    ...(hostname ? { hostname } : {}),
    createdAt: now,
    lastSeenAt: now,
    credHash,
  };
  await client.command(['SET', credKey(deviceCredential), JSON.stringify({ deviceId, userId: user.id })]);
  await client.command(['SET', deviceRecordKey(deviceId), JSON.stringify(record)]);
  await client.command(['SADD', deviceUserKey(user.id), deviceId]);
  return { deviceId, deviceCredential, userId: user.id, name };
}

export function publicDevice(record: DeviceRecord): PublicDevice {
  return {
    deviceId: record.deviceId,
    name: record.name,
    platform: record.platform,
    hostname: record.hostname ?? null,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
  };
}

export async function listUserDevices(client: Redis, userId: string): Promise<PublicDevice[]> {
  const ids = await client.command<string[]>(['SMEMBERS', deviceUserKey(userId)]) ?? [];
  const devices: PublicDevice[] = [];
  for (const id of ids) {
    const record = await readDevice(client, id);
    if (!record || record.revokedAt || record.userId !== userId) continue;
    devices.push(publicDevice(record));
  }
  devices.sort((a, b) => b.createdAt - a.createdAt || b.deviceId.localeCompare(a.deviceId));
  return devices;
}

/** Delete the credential, drop the device record, and release wake bindings. */
export async function revokeStoredDevice(client: Redis, deviceId: string, now = Date.now()): Promise<boolean> {
  if (!DEVICE_ID_RE.test(deviceId)) return false;
  const record = await readDevice(client, deviceId);
  await revokeWakeDevice(client, deviceId, now);
  if (record?.credHash && CRED_HASH_RE.test(record.credHash)) {
    await client.command(['DEL', `device-cred:${record.credHash}`]);
  }
  const deleted = Number(await client.command<number>(['DEL', deviceRecordKey(deviceId)])) > 0;
  if (record?.userId && DEVICE_ID_RE.test(record.userId)) {
    await client.command(['SREM', deviceUserKey(record.userId), deviceId]);
  }
  return deleted;
}

export async function revokeUserDevices(client: Redis, userId: string, now = Date.now()): Promise<number> {
  const ids = await client.command<string[]>(['SMEMBERS', deviceUserKey(userId)]) ?? [];
  let removed = 0;
  for (const id of ids) {
    if (await revokeStoredDevice(client, id, now)) removed += 1;
  }
  await client.command(['DEL', deviceUserKey(userId)]);
  return removed;
}

export async function revokeOwnedDevice(
  client: Redis,
  deviceId: string,
  actor: { id: string; role: 'admin' | 'user' },
  now = Date.now(),
): Promise<void> {
  const record = await readDevice(client, deviceId);
  if (!record || record.revokedAt || (record.userId !== actor.id && actor.role !== 'admin')) {
    throw new AccountError('Device not found.', 404, 'not_found');
  }
  await revokeStoredDevice(client, deviceId, now);
}

/**
 * New credentials are JSON {deviceId, userId}. Reject missing, revoked, and
 * disabled owners. lastSeenAt updates are best effort and at most once a minute.
 */
export async function authorizeStoredDevice(
  client: Redis,
  deviceId: string,
  userId: string,
  credHash: string,
  now = Date.now(),
): Promise<boolean> {
  const record = await readDevice(client, deviceId);
  if (!record || record.revokedAt || record.userId !== userId || record.credHash !== credHash) return false;
  const user = await getUserById(client as UpstashClient, userId);
  if (!user || user.disabled) return false;
  const seen = Number(record.lastSeenAt);
  if (!Number.isFinite(seen) || now - seen >= LAST_SEEN_INTERVAL_MS) {
    try {
      const latest = await readDevice(client, deviceId);
      const latestSeen = Number(latest?.lastSeenAt);
      if (
        latest
        && !latest.revokedAt
        && latest.userId === userId
        && latest.credHash === credHash
        && (!Number.isFinite(latestSeen) || now - latestSeen >= LAST_SEEN_INTERVAL_MS)
      ) {
        latest.lastSeenAt = now;
        await client.command(['SET', deviceRecordKey(deviceId), JSON.stringify(latest)]);
      }
    } catch {
      // Seeing the device is enough; a failed timestamp write must not fail auth.
    }
  }
  return true;
}
