import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { CodexCliAdapter, type ProcessSpawner } from './src/adapter.js';
import { startControlServer } from './src/control.js';
import { MemoryCredentialStore } from './src/credstore.js';
import { MemoryRunLock, WakeDaemon } from './src/daemon.js';
import { DaemonLog } from './src/log.js';
import { SecretRegistry } from './src/redact.js';
import {
  clearPtyRegistryForTests,
  ptyAvailable,
  spawnPtySession,
} from './src/pty.js';
import WebSocket from 'ws';

function quietSpawner(): ProcessSpawner {
  return { spawn() { throw new Error('spawned'); } };
}

afterEach(() => {
  clearPtyRegistryForTests();
});

describe('control terminal routes', () => {
  it('lists and describes PTY sessions with token auth', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-term-'));
    const secrets = new SecretRegistry();
    const log = new DaemonLog(secrets);
    const adapters = new Map([['codex', new CodexCliAdapter(quietSpawner(), {
      probe: async () => ({ installed: true, version: 'x', path: '/bin/codex' }),
    })]]);
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
      log,
      getToken: async () => '',
      setToken: () => {},
    });
    try {
      const unauthorized = await fetch(`http://127.0.0.1:${control.port}/api/terminals`);
      expect(unauthorized.status).toBe(401);

      const empty = await fetch(`http://127.0.0.1:${control.port}/api/terminals?t=${control.token}`);
      expect(empty.status).toBe(200);
      const emptyBody = await empty.json() as { terminals: unknown[] };
      expect(emptyBody.terminals).toEqual([]);

      if (!ptyAvailable()) return;

      const seatId = `ctrl-pty-${Date.now()}`;
      spawnPtySession({
        seatId,
        command: 'bash',
        args: ['-lc', 'exec cat'],
        cwd: directory,
        env: {},
      });

      const listed = await fetch(`http://127.0.0.1:${control.port}/api/terminals?t=${control.token}`);
      const listedBody = await listed.json() as { terminals: { seatId: string; pid: number }[] };
      expect(listedBody.terminals.some(t => t.seatId === seatId)).toBe(true);

      const one = await fetch(`http://127.0.0.1:${control.port}/api/terminals/${encodeURIComponent(seatId)}?t=${control.token}`);
      expect(one.status).toBe(200);

      const missing = await fetch(`http://127.0.0.1:${control.port}/api/terminals/nope?t=${control.token}`);
      expect(missing.status).toBe(404);

      // WS stdin/stdout smoke
      const ws = new WebSocket(`ws://127.0.0.1:${control.port}/api/terminals/${encodeURIComponent(seatId)}/ws?t=${control.token}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws timeout')), 5000);
        ws.once('open', () => { clearTimeout(timer); resolve(); });
        ws.once('error', reject);
      });
      const got: string[] = [];
      ws.on('message', data => { got.push(String(data)); });
      ws.send(JSON.stringify({ type: 'stdin', data: 'ping-ws\n' }));
      const deadline = Date.now() + 5000;
      while (!got.join('').includes('ping-ws') && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      expect(got.join('')).toContain('ping-ws');
      ws.close();
    } finally {
      await control.close();
    }
  }, 20_000);
});

describe('debug pty-spawn hatch', () => {
  it('404s when AGENT_ROOM_DEBUG_PTY is unset and spawns when set to 1', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-debug-pty-'));
    const secrets = new SecretRegistry();
    const log = new DaemonLog(secrets);
    const adapters = new Map([['codex', new CodexCliAdapter(quietSpawner(), {
      probe: async () => ({ installed: true, version: 'x', path: '/bin/codex' }),
    })]]);
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
      log,
      getToken: async () => '',
      setToken: () => {},
    });
    const prev = process.env.AGENT_ROOM_DEBUG_PTY;
    try {
      delete process.env.AGENT_ROOM_DEBUG_PTY;
      const gated = await fetch(`http://127.0.0.1:${control.port}/api/debug/pty-spawn?t=${control.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seatId: 'qa-popout' }),
      });
      expect(gated.status).toBe(404);

      if (!ptyAvailable()) return;

      process.env.AGENT_ROOM_DEBUG_PTY = '1';
      const spawned = await fetch(`http://127.0.0.1:${control.port}/api/debug/pty-spawn?t=${control.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seatId: 'qa-popout' }),
      });
      expect(spawned.status).toBe(200);
      const body = await spawned.json() as { ok: boolean; seatId: string; pid: number };
      expect(body.ok).toBe(true);
      expect(body.seatId).toBe('qa-popout');
      expect(body.pid).toBeGreaterThan(0);

      const listed = await fetch(`http://127.0.0.1:${control.port}/api/terminals?t=${control.token}`);
      const listedBody = await listed.json() as { terminals: { seatId: string }[] };
      expect(listedBody.terminals.some(t => t.seatId === 'qa-popout')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AGENT_ROOM_DEBUG_PTY;
      else process.env.AGENT_ROOM_DEBUG_PTY = prev;
      await control.close();
    }
  }, 20_000);
});
