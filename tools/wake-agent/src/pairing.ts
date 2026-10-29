import { readFile } from 'node:fs/promises';
import { hostname, release, type } from 'node:os';
import type { CredentialStore } from './credstore.js';
import type { DaemonState } from './state.js';

export interface PairingResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null; getSetCookie?: () => string[] };
  json: () => Promise<unknown>;
}

export type PairingFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<PairingResponse>;

export interface PairingDeps {
  fetch?: PairingFetch;
  credentials: CredentialStore;
  readState: () => Promise<DaemonState>;
  writeState: (state: DaemonState) => Promise<void>;
  hostname?: string;
  platform?: string;
  now?: () => string;
  /** Override whoami during restore. Production uses the real device endpoint. */
  identify?: (server: string, token: string) => Promise<{ username?: string; userId?: string; deviceId?: string } | null>;
}

export function serverOrigin(server: string): string {
  return new URL(server).origin;
}

export function deviceCredentialKey(server: string): string {
  return `device:${serverOrigin(server)}`;
}

/** `Linux (Debian GNU/Linux 13)` when PRETTY_NAME is present, otherwise `Linux <release>`. */
export function platformLabelFrom(text: string | undefined, osType = type(), osRelease = release()): string {
  const line = text?.split('\n').find(entry => entry.startsWith('PRETTY_NAME='));
  if (line) {
    let value = line.slice('PRETTY_NAME='.length).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value) return `${osType} (${value})`;
  }
  return `${osType} ${osRelease}`;
}

export async function currentPlatform(): Promise<string> {
  try {
    return platformLabelFrom(await readFile('/etc/os-release', 'utf8'));
  } catch {
    return platformLabelFrom(undefined);
  }
}

function sessionCookie(headers: PairingResponse['headers']): string | undefined {
  const listed = headers.getSetCookie?.() ?? [];
  const fromList = listed.map(cookie => cookie.split(';', 1)[0] ?? '').find(cookie => cookie.startsWith('ar_session='));
  if (fromList) return fromList;
  const raw = headers.get('set-cookie');
  const match = raw?.match(/ar_session=[^;]+/);
  return match?.[0];
}

async function postJson(fetchFn: PairingFetch, url: string, body: unknown, headers: Record<string, string>): Promise<PairingResponse> {
  return fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export async function pairComplete(
  server: string,
  pairingCode: string,
  deps: PairingDeps,
): Promise<{ deviceId: string; deviceCredential: string }> {
  const fetchFn = deps.fetch ?? (fetch as unknown as PairingFetch);
  const response = await postJson(fetchFn, new URL('/api/device/pair-complete', server).toString(), {
    pairingCode,
    deviceName: deps.hostname ?? hostname(),
    platform: deps.platform ?? await currentPlatform(),
    hostname: deps.hostname ?? hostname(),
  }, {});
  const payload = await response.json().catch(() => ({})) as { deviceId?: unknown; deviceCredential?: unknown; error?: unknown };
  if (!response.ok || typeof payload.deviceId !== 'string' || typeof payload.deviceCredential !== 'string') {
    throw new Error(typeof payload.error === 'string' ? payload.error : 'pair_failed');
  }
  await deps.credentials.set(deviceCredentialKey(server), payload.deviceCredential);
  const state = await deps.readState();
  state.device = { server, deviceId: payload.deviceId, pairedAt: deps.now?.() ?? new Date().toISOString() };
  await deps.writeState(state);
  return { deviceId: payload.deviceId, deviceCredential: payload.deviceCredential };
}

export async function whoami(
  server: string,
  token: string,
  fetchFn: PairingFetch = fetch as unknown as PairingFetch,
): Promise<{ username?: string; userId?: string; deviceId?: string } | null> {
  const response = await postJson(fetchFn, new URL('/api/device/self', server).toString(), {}, {
    authorization: `Bearer ${token}`,
  });
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const payload = await response.json().catch(() => ({})) as {
    username?: unknown;
    userId?: unknown;
    deviceId?: unknown;
    user?: { username?: unknown; userId?: unknown };
  };
  const username = typeof payload.username === 'string' ? payload.username
    : typeof payload.user?.username === 'string' ? payload.user.username : undefined;
  const userId = typeof payload.userId === 'string' ? payload.userId
    : typeof payload.user?.userId === 'string' ? payload.user.userId : undefined;
  const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : undefined;
  return { username, userId, deviceId };
}

export async function pairWithLogin(
  server: string,
  username: string,
  password: string,
  deps: PairingDeps,
): Promise<{ deviceId: string }> {
  const fetchFn = deps.fetch ?? (fetch as unknown as PairingFetch);
  const login = await postJson(fetchFn, new URL('/api/account/login', server).toString(), { username, password }, {});
  if (!login.ok) throw new Error('login_failed');
  const cookie = sessionCookie(login.headers);
  if (!cookie) throw new Error('login_failed');
  try {
    const started = await postJson(fetchFn, new URL('/api/device/pair-start', server).toString(), {}, { cookie });
    const payload = await started.json().catch(() => ({})) as { pairingCode?: unknown; error?: unknown };
    if (!started.ok || typeof payload.pairingCode !== 'string' || !payload.pairingCode) {
      throw new Error(typeof payload.error === 'string' ? payload.error : 'pair_start_failed');
    }
    const paired = await pairComplete(server, payload.pairingCode, { ...deps, fetch: fetchFn });
    return { deviceId: paired.deviceId };
  } finally {
    await postJson(fetchFn, new URL('/api/account/logout', server).toString(), {}, { cookie }).catch(() => undefined);
  }
}

/**
 * daemon.json can lose `device` while the credential store still has the token.
 * Rebuild the record so wake register and the desktop status report stay paired.
 * A credential the server rejects is left unset so the settings page can re-pair.
 */
export async function restoreDeviceFromCredential(server: string, deps: PairingDeps): Promise<boolean> {
  const state = await deps.readState();
  if (state.device?.server && state.device.deviceId) return false;
  const token = await deps.credentials.get(deviceCredentialKey(server));
  if (!token) return false;
  let deviceId = 'restored';
  try {
    const identify = deps.identify ?? ((srv: string, tok: string) => whoami(srv, tok, deps.fetch));
    const user = await identify(server, token);
    if (!user) return false;
    if (user.deviceId) deviceId = user.deviceId;
  } catch {
    deviceId = 'restored';
  }
  state.device = { server, deviceId, pairedAt: deps.now?.() ?? new Date().toISOString() };
  await deps.writeState(state);
  return true;
}

export async function unpair(server: string | undefined, deps: Pick<PairingDeps, 'credentials' | 'readState' | 'writeState'>): Promise<void> {
  const state = await deps.readState();
  const target = server ?? state.device?.server;
  if (target) await deps.credentials.delete(deviceCredentialKey(target));
  state.device = undefined;
  await deps.writeState(state);
}
