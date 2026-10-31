import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_DAEMON_PING_URL,
  DESKTOP_PROBE_HEADER,
  ROOM_HEALTH_PATH,
  createOfflineGate,
  probeReachable,
  probeRoomAndDaemon,
  reachabilityFailed,
  reduceOfflineGate,
} from './networkReachability.js';

function jsonResponse(status: number): Response {
  return new Response('{}', { status });
}

describe('probeReachable', () => {
  it('treats any HTTP response as reachable, including auth and server errors', async () => {
    for (const status of [200, 401, 403, 500]) {
      const fetchImpl = vi.fn(async () => jsonResponse(status));
      await expect(probeReachable('/healthz', fetchImpl as unknown as typeof fetch)).resolves.toBe(true);
    }
  });

  it('treats a thrown fetch as unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(probeReachable('/healthz', fetchImpl as unknown as typeof fetch)).resolves.toBe(false);
  });

  it('treats an abort timeout as unreachable', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new Error('aborted'));
      if (init?.signal?.aborted) {
        abort();
        return;
      }
      init?.signal?.addEventListener('abort', abort);
    }));
    await expect(probeReachable('/healthz', fetchImpl as unknown as typeof fetch, undefined, 20)).resolves.toBe(false);
  });
});

describe('probeRoomAndDaemon', () => {
  it('probes same-origin /healthz and skips the daemon outside the desktop shell', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200));
    const snapshot = await probeRoomAndDaemon(fetchImpl as unknown as typeof fetch, false);
    expect(snapshot).toEqual({ roomReachable: true, daemonReachable: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(ROOM_HEALTH_PATH);
  });

  it('probes the loopback daemon with the desktop header and counts 401 as up', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => jsonResponse(url === DESKTOP_DAEMON_PING_URL ? 401 : 200));
    const snapshot = await probeRoomAndDaemon(fetchImpl as unknown as typeof fetch, true);
    expect(snapshot).toEqual({ roomReachable: true, daemonReachable: true });
    const daemonCall = fetchImpl.mock.calls.find(call => call[0] === DESKTOP_DAEMON_PING_URL);
    expect(daemonCall?.[0]).toBe('http://127.0.0.1:17421/api/desktop/ping');
    const init = daemonCall?.[1];
    expect((init?.headers as Record<string, string> | undefined)?.[DESKTOP_PROBE_HEADER]).toBe('1');
    expect(init?.method).toBe('GET');
  });

  it('reports the daemon down only when its fetch throws', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === DESKTOP_DAEMON_PING_URL) throw new TypeError('network');
      return jsonResponse(200);
    });
    const snapshot = await probeRoomAndDaemon(fetchImpl as unknown as typeof fetch, true);
    expect(snapshot).toEqual({ roomReachable: true, daemonReachable: false });
  });
});

describe('reachabilityFailed', () => {
  const up = { browserOffline: false, roomReachable: true, daemonReachable: null as boolean | null };

  it('fails when any signal fails', () => {
    expect(reachabilityFailed(up)).toBe(false);
    expect(reachabilityFailed({ ...up, browserOffline: true })).toBe(true);
    expect(reachabilityFailed({ ...up, roomReachable: false })).toBe(true);
    expect(reachabilityFailed({ ...up, daemonReachable: false })).toBe(true);
    expect(reachabilityFailed({ ...up, daemonReachable: true })).toBe(false);
  });
});

describe('reduceOfflineGate', () => {
  it('shows after one failure and hides on the next success', () => {
    let gate = createOfflineGate();
    gate = reduceOfflineGate(gate, true);
    expect(gate).toEqual({ visible: true, consecutiveFailures: 1 });
    gate = reduceOfflineGate(gate, true);
    expect(gate).toEqual({ visible: true, consecutiveFailures: 2 });
    gate = reduceOfflineGate(gate, false);
    expect(gate).toEqual({ visible: false, consecutiveFailures: 0 });
    gate = reduceOfflineGate(gate, true);
    expect(gate).toEqual({ visible: true, consecutiveFailures: 1 });
  });
});
