import { createHash } from 'node:crypto';
import type { UpstashClient } from '@agent-room/upstash-client';
import { authorizeStoredDevice } from './_devices.js';

/** Device identity accepted by /api/wake. Pairing (M6) is the only issuer. */
export interface DevicePrincipal {
  deviceId: string;
}

/**
 * Pluggable device-credential check. M6 stores only a hash under device-cred:*;
 * until then callers inject a map or the Redis lookup below. Neither
 * implementation mints credentials.
 */
export interface DeviceAuthenticator {
  authenticate(authorization: string | undefined): Promise<DevicePrincipal | null>;
}

export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

export function deviceCredentialHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** In-memory credential map for tests and local stubs. Unknown tokens are rejected. */
export class MapDeviceAuthenticator implements DeviceAuthenticator {
  constructor(private readonly tokens: ReadonlyMap<string, string>) {}
  async authenticate(authorization: string | undefined): Promise<DevicePrincipal | null> {
    const token = bearerToken(authorization);
    if (!token) return null;
    const deviceId = this.tokens.get(token);
    return deviceId && /^[\w.-]{1,128}$/.test(deviceId) ? { deviceId } : null;
  }
}

/**
 * Reads device-cred:{sha256(token)}.
 * Pairing stores JSON { deviceId, userId }; it also requires a live device
 * record and an enabled owner. Stub-format values (plain deviceId, or JSON
 * without userId) are accepted only when `allowLegacy` is set (unit tests).
 */
export class RedisDeviceAuthenticator implements DeviceAuthenticator {
  constructor(
    private readonly client: Pick<UpstashClient, 'command'>,
    private readonly now: () => number = Date.now,
    private readonly allowLegacy = false,
  ) {}
  async authenticate(authorization: string | undefined): Promise<DevicePrincipal | null> {
    const token = bearerToken(authorization);
    if (!token) return null;
    const raw = await this.client.command<string | null>(['GET', `device-cred:${deviceCredentialHash(token)}`]);
    if (!raw) return null;
    if (!raw.startsWith('{')) {
      return this.allowLegacy && /^[\w.-]{1,128}$/.test(raw) ? { deviceId: raw } : null;
    }
    let parsed: { deviceId?: string; userId?: string; revoked?: boolean };
    try {
      parsed = JSON.parse(raw) as { deviceId?: string; userId?: string; revoked?: boolean };
    } catch {
      return null;
    }
    if (parsed.revoked) return null;
    const deviceId = parsed.deviceId ?? '';
    if (!/^[\w.-]{1,128}$/.test(deviceId)) return null;
    if (typeof parsed.userId !== 'string' || !parsed.userId) return this.allowLegacy ? { deviceId } : null;
    const ok = await authorizeStoredDevice(this.client, deviceId, parsed.userId, deviceCredentialHash(token), this.now());
    return ok ? { deviceId } : null;
  }
}
