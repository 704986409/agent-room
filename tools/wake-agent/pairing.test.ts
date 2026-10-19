import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryCredentialStore } from './src/credstore.js';
import { pairComplete, pairWithLogin, platformLabelFrom, unpair, whoami, type PairingFetch, type PairingResponse } from './src/pairing.js';
import { readState, writeState, type DaemonState } from './src/state.js';

function response(status: number, body: unknown, cookies: string[] = []): PairingResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null, getSetCookie: () => cookies },
    json: async () => body,
  };
}

describe('pairing client', () => {
  it('formats the platform from PRETTY_NAME', () => {
    expect(platformLabelFrom('PRETTY_NAME="Debian GNU/Linux 13"\nID=debian\n', 'Linux', '6.12')).toBe('Linux (Debian GNU/Linux 13)');
    expect(platformLabelFrom(undefined, 'Linux', '6.12.0')).toBe('Linux 6.12.0');
  });

  it('stores the device credential outside the state file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-pair-'));
    const path = join(directory, 'daemon.json');
    const state: DaemonState = { seats: [] };
    const credentials = new MemoryCredentialStore();
    const seen: { url: string; body: string }[] = [];
    const fetchFn: PairingFetch = async (url, init) => {
      seen.push({ url, body: init.body ?? '' });
      return response(200, { deviceId: 'dev_1', deviceCredential: 'device-secret-value' });
    };
    const paired = await pairComplete('http://127.0.0.1:9', 'PAIRCODE', {
      fetch: fetchFn,
      credentials,
      readState: async () => state,
      writeState: async next => { await writeState(path, next); },
      hostname: 'box',
      platform: 'Linux (Debian GNU/Linux 13)',
      now: () => '2026-10-20T00:00:00.000Z',
    });
    expect(paired.deviceId).toBe('dev_1');
    expect(await credentials.get('device:http://127.0.0.1:9')).toBe('device-secret-value');
    const saved = await readState(path);
    expect(saved.device).toEqual({ server: 'http://127.0.0.1:9', deviceId: 'dev_1', pairedAt: '2026-10-20T00:00:00.000Z' });
    expect(JSON.stringify(saved)).not.toContain('device-secret-value');
    const request = JSON.parse(seen[0]!.body) as { platform: string; hostname: string; deviceName: string };
    expect(request).toMatchObject({ platform: 'Linux (Debian GNU/Linux 13)', hostname: 'box', deviceName: 'box', pairingCode: 'PAIRCODE' });
  });

  it('keeps the login cookie and password in memory only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-login-'));
    const path = join(directory, 'daemon.json');
    const state: DaemonState = { seats: [] };
    const credentials = new MemoryCredentialStore();
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchFn: PairingFetch = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body ?? '' });
      if (url.endsWith('/api/account/login')) return response(200, { user: { username: 'ada' } }, ['ar_session=session-token-value; HttpOnly']);
      if (url.endsWith('/api/device/pair-start')) return response(200, { pairingCode: 'ONCE' });
      if (url.endsWith('/api/device/pair-complete')) return response(200, { deviceId: 'dev_2', deviceCredential: 'device-secret-value' });
      if (url.endsWith('/api/account/logout')) return response(200, { ok: true });
      return response(500, { error: 'unexpected' });
    };
    const paired = await pairWithLogin('http://127.0.0.1:9', 'ada', 'p@ss-not-stored', {
      fetch: fetchFn,
      credentials,
      readState: async () => state,
      writeState: async next => { await writeState(path, next); },
      hostname: 'box',
      platform: 'Linux (Debian GNU/Linux 13)',
    });
    expect(paired).toEqual({ deviceId: 'dev_2' });
    expect(calls.map(call => call.url)).toEqual([
      'http://127.0.0.1:9/api/account/login',
      'http://127.0.0.1:9/api/device/pair-start',
      'http://127.0.0.1:9/api/device/pair-complete',
      'http://127.0.0.1:9/api/account/logout',
    ]);
    expect(calls[1]!.headers.cookie).toBe('ar_session=session-token-value');
    expect(calls[1]!.body).not.toContain('p@ss-not-stored');
    expect(calls[3]!.headers.cookie).toBe('ar_session=session-token-value');
    const saved = JSON.stringify(await readState(path));
    expect(saved).not.toContain('p@ss-not-stored');
    expect(saved).not.toContain('session-token-value');
    expect(await credentials.get('device:http://127.0.0.1:9')).toBe('device-secret-value');
    const dumped = JSON.stringify([...calls]);
    expect(dumped).toContain('p@ss-not-stored');
    await unpair('http://127.0.0.1:9', {
      credentials,
      readState: async () => state,
      writeState: async next => { await writeState(path, next); },
    });
    expect(await credentials.get('device:http://127.0.0.1:9')).toBeUndefined();
    expect((await readState(path)).device).toBeUndefined();
  });

  it('tolerates a missing whoami route', async () => {
    const fetchFn: PairingFetch = async () => response(404, { error: 'not_found' });
    expect(await whoami('http://127.0.0.1:9', 'device-secret-value', fetchFn)).toBeNull();
  });
});
