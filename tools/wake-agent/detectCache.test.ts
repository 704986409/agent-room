import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexCliAdapter, type LauncherAdapter, type ProcessSpawner } from './src/adapter.js';
import {
  beginDetectRefresh,
  clearDetectCache,
  detectCacheSize,
  getCachedDetect,
  setCachedDetect,
} from './src/detectCache.js';
import { startControlServer } from './src/control.js';
import { MemoryCredentialStore } from './src/credstore.js';
import { MemoryRunLock, WakeDaemon } from './src/daemon.js';
import { DaemonLog } from './src/log.js';
import { SecretRegistry } from './src/redact.js';

function quietSpawner(): ProcessSpawner {
  return { spawn() { throw new Error('spawned'); } };
}

describe('detectCache', () => {
  beforeEach(() => {
    clearDetectCache();
  });

  afterEach(() => {
    clearDetectCache();
  });

  it('stores detect results and dedupes concurrent refreshes', async () => {
    let calls = 0;
    const adapter: LauncherAdapter = {
      id: 'codex',
      command: 'codex',
      models: ['default'],
      async detect() {
        calls += 1;
        await new Promise(r => setTimeout(r, 30));
        return { installed: true, path: '/bin/codex', version: '1' };
      },
      async launch() { throw new Error('no'); },
      async resume() { throw new Error('no'); },
      parseSessionId() { return undefined; },
      launchArgv() { return []; },
      resumeArgv() { return []; },
    };
    const a = beginDetectRefresh([adapter]);
    const b = beginDetectRefresh([adapter]);
    await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(getCachedDetect('codex')).toEqual({ installed: true, path: '/bin/codex', version: '1' });
    expect(detectCacheSize()).toBe(1);
  });
});

describe('GET /api/status uses detect cache', () => {
  beforeEach(() => {
    clearDetectCache();
  });

  afterEach(() => {
    clearDetectCache();
  });

  it('returns cached detect without calling a slow adapter.detect()', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-detect-cache-'));
    let detectCalls = 0;
    const adapters = new Map([['codex', new CodexCliAdapter(quietSpawner(), {
      probe: async () => {
        detectCalls += 1;
        await new Promise(r => setTimeout(r, 5_000));
        return { installed: true, version: 'slow', path: '/bin/codex' };
      },
    })]]);
    // Seed cache as if daemon boot already warmed it.
    setCachedDetect('codex', { installed: true, version: 'cached-1', path: '/cached/codex' });

    const secrets = new SecretRegistry();
    const daemon = new WakeDaemon({
      api: {
        async register() { return { roomInstanceId: 'ri', seatId: 'st', scanFrom: 0 }; },
        async poll() { return { seats: [] }; },
        async claim() { return { wakeRunId: 'wr', claims: [] }; },
        async renew() { return {}; },
        async progress() { return {}; },
      },
      adapters,
      state: { seats: [] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: false, cmdline: '' }),
    });
    const control = await startControlServer({
      daemon,
      credentials: new MemoryCredentialStore(),
      statePath: join(directory, 'daemon.json'),
      stateDir: directory,
      server: 'http://127.0.0.1:9',
      adapters,
      secrets,
      log: new DaemonLog(secrets),
      home: directory,
      run: async () => { throw new Error('unexpected command'); },
      getToken: async () => '',
      setToken: () => undefined,
    });
    try {
      const started = Date.now();
      const status = await fetch(`http://127.0.0.1:${control.port}/api/status?t=${control.token}`);
      const elapsed = Date.now() - started;
      expect(status.status).toBe(200);
      const body = await status.json() as { adapters: { id: string; installed: boolean; version?: string; path?: string; models: string[] }[] };
      expect(body.adapters[0]).toMatchObject({
        id: 'codex',
        installed: true,
        version: 'cached-1',
        path: '/cached/codex',
      });
      expect(body.adapters[0]!.models.length).toBeGreaterThan(0);
      // Must not wait on the 5s slow probe.
      expect(elapsed).toBeLessThan(2_000);
      expect(detectCalls).toBe(0);
    } finally {
      await control.close();
    }
  });
});
