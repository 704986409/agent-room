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
  getPtySession,
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
      const session = spawnPtySession({
        seatId,
        command: 'bash',
        args: ['-lc', 'printf "prior-scroll\\n"; exec cat'],
        cwd: directory,
        env: {},
      });
      const priorDeadline = Date.now() + 5000;
      while (!session.scrollback().includes('prior-scroll') && Date.now() < priorDeadline) {
        await new Promise(r => setTimeout(r, 30));
      }
      expect(session.scrollback()).toContain('prior-scroll');
      expect(getPtySession(seatId)?.scrollback()).toContain('prior-scroll');

      const listed = await fetch(`http://127.0.0.1:${control.port}/api/terminals?t=${control.token}`);
      const listedBody = await listed.json() as { terminals: { seatId: string; pid: number }[] };
      expect(listedBody.terminals.some(t => t.seatId === seatId)).toBe(true);

      const one = await fetch(`http://127.0.0.1:${control.port}/api/terminals/${encodeURIComponent(seatId)}?t=${control.token}`);
      expect(one.status).toBe(200);

      const missing = await fetch(`http://127.0.0.1:${control.port}/api/terminals/nope?t=${control.token}`);
      expect(missing.status).toBe(404);

      // WS stdin/stdout smoke. Listen before open so the attach replay is not missed.
      const ws = new WebSocket(`ws://127.0.0.1:${control.port}/api/terminals/${encodeURIComponent(seatId)}/ws?t=${control.token}`);
      const got: string[] = [];
      ws.on('message', data => { got.push(String(data)); });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws timeout')), 5000);
        ws.once('open', () => { clearTimeout(timer); resolve(); });
        ws.once('error', reject);
      });
      const replayDeadline = Date.now() + 5000;
      while (!got.join('').includes('prior-scroll') && Date.now() < replayDeadline) {
        await new Promise(r => setTimeout(r, 30));
      }
      expect(got.join('')).toContain('prior-scroll');
      ws.send(JSON.stringify({ type: 'stdin', data: 'ping-ws\n' }));
      const deadline = Date.now() + 5000;
      while (!got.join('').includes('ping-ws') && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      const transcript = got.join('');
      expect(transcript).toContain('ping-ws');
      expect(transcript.indexOf('prior-scroll')).toBeLessThan(transcript.indexOf('ping-ws'));
      ws.close();
    } finally {
      await control.close();
    }
  }, 20_000);
});

describe('desktop-auth terminal routes', () => {
  it('lists and attaches with the desktop mark and rejects a missing mark', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-desk-term-'));
    const secrets = new SecretRegistry();
    const log = new DaemonLog(secrets);
    const adapters = new Map([['codex', new CodexCliAdapter(quietSpawner(), {
      probe: async () => ({ installed: true, version: 'x', path: '/bin/codex' }),
    })]]);
    const seatId = `desk-pty-${Date.now()}`;
    const daemon = new WakeDaemon({
      api: {
        async register() { return { roomInstanceId: 'ri', seatId: 'st', scanFrom: 0 }; },
        async poll() { return { seats: [] }; },
        async claim() { return { wakeRunId: 'wr', claims: [] }; },
        async renew() { return {}; },
        async progress() { return {}; },
      },
      adapters,
      state: {
        seats: [{
          seatId, code: 'ABC-DEF', name: '开发工程师', adapterId: 'codex', cwd: directory, status: 'running',
        }],
      },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: false, cmdline: '' }),
    });
    const control = await startControlServer({
      daemon,
      credentials: new MemoryCredentialStore(),
      statePath: join(directory, 'daemon.json'),
      stateDir: directory,
      server: 'https://room.example',
      adapters,
      secrets,
      log,
      getToken: async () => '',
      setToken: () => {},
    });
    const roomOrigin = 'https://room.example';
    try {
      const missingMark = await fetch(`http://127.0.0.1:${control.port}/api/desktop/terminals`, {
        headers: { origin: roomOrigin },
      });
      expect(missingMark.status).toBe(401);

      const foreign = await fetch(`http://127.0.0.1:${control.port}/api/desktop/terminals`, {
        headers: { origin: 'https://evil.example', 'x-agent-room-desktop': '1' },
      });
      expect(foreign.status).toBe(403);

      const empty = await fetch(`http://127.0.0.1:${control.port}/api/desktop/terminals`, {
        headers: { origin: roomOrigin, 'x-agent-room-desktop': '1' },
      });
      expect(empty.status).toBe(200);
      expect(empty.headers.get('access-control-allow-origin')).toBe(roomOrigin);
      const emptyBody = await empty.json() as { terminals: unknown[]; mode: string };
      expect(emptyBody.terminals).toEqual([]);
      expect(emptyBody.mode).toBe('embedded');

      const wsDenied = new WebSocket(
        `ws://127.0.0.1:${control.port}/api/desktop/terminals/${encodeURIComponent(seatId)}/ws`,
        { headers: { origin: roomOrigin } },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('denied ws timeout')), 5000);
        wsDenied.once('open', () => { clearTimeout(timer); reject(new Error('ws opened without desktop mark')); });
        wsDenied.once('unexpected-response', () => { clearTimeout(timer); resolve(); });
        wsDenied.once('error', () => { clearTimeout(timer); resolve(); });
      });

      if (!ptyAvailable()) return;

      spawnPtySession({
        seatId,
        command: 'bash',
        args: ['-lc', 'exec cat'],
        cwd: directory,
        env: {},
      });

      const listed = await fetch(`http://127.0.0.1:${control.port}/api/desktop/terminals`, {
        headers: { origin: roomOrigin, 'x-agent-room-desktop': '1' },
      });
      const listedBody = await listed.json() as { terminals: { seatId: string; name?: string; code?: string }[] };
      expect(listedBody.terminals).toEqual(expect.arrayContaining([
        expect.objectContaining({ seatId, name: '开发工程师', code: 'ABC-DEF' }),
      ]));

      const ws = new WebSocket(
        `ws://127.0.0.1:${control.port}/api/desktop/terminals/${encodeURIComponent(seatId)}/ws?desktop=1`,
        { headers: { origin: roomOrigin } },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws timeout')), 5000);
        ws.once('open', () => { clearTimeout(timer); resolve(); });
        ws.once('error', reject);
      });
      const got: string[] = [];
      ws.on('message', data => { got.push(String(data)); });
      ws.send(JSON.stringify({ type: 'stdin', data: 'desk-ws\n' }));
      const deadline = Date.now() + 5000;
      while (!got.join('').includes('desk-ws') && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      expect(got.join('')).toContain('desk-ws');
      expect(ws.url.includes('t=')).toBe(false);
      ws.close();
    } finally {
      await control.close();
    }
  }, 20_000);
});

describe('desktop clipboard route', () => {
  it('requires the desktop mark and returns reader text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-clip-'));
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
      server: 'https://room.example',
      adapters,
      secrets,
      log,
      readClipboard: async () => 'INVITE-FROM-OS',
      getToken: async () => '',
      setToken: () => {},
    });
    const roomOrigin = 'https://room.example';
    try {
      const missingMark = await fetch(`http://127.0.0.1:${control.port}/api/desktop/clipboard`, {
        headers: { origin: roomOrigin },
      });
      expect(missingMark.status).toBe(401);

      const foreign = await fetch(`http://127.0.0.1:${control.port}/api/desktop/clipboard`, {
        headers: { origin: 'https://evil.example', 'x-agent-room-desktop': '1' },
      });
      expect(foreign.status).toBe(403);

      const ok = await fetch(`http://127.0.0.1:${control.port}/api/desktop/clipboard`, {
        headers: { origin: roomOrigin, 'x-agent-room-desktop': '1' },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('access-control-allow-origin')).toBe(roomOrigin);
      expect(await ok.json()).toEqual({ text: 'INVITE-FROM-OS' });
    } finally {
      await control.close();
    }
  });

  it('returns an empty string when the clipboard reader throws', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-clip-fail-'));
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
      server: 'https://room.example',
      adapters,
      secrets,
      log,
      readClipboard: async () => { throw new Error('clipboard down'); },
      getToken: async () => '',
      setToken: () => {},
    });
    try {
      const ok = await fetch(`http://127.0.0.1:${control.port}/api/desktop/clipboard`, {
        headers: { origin: 'https://room.example', 'x-agent-room-desktop': '1' },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ text: '' });
    } finally {
      await control.close();
    }
  });
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

describe('pop-out assets and stop', () => {
  it('serves xterm from the daemon and stops a PTY without a CDN', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-stop-'));
    const secrets = new SecretRegistry();
    const log = new DaemonLog(secrets);
    const adapters = new Map([['codex', new CodexCliAdapter(quietSpawner(), {
      probe: async () => ({ installed: true, version: 'x', path: '/bin/codex' }),
    })]]);
    const seatId = 'st_stop';
    let alive = true;
    const daemon = new WakeDaemon({
      api: {
        async register() { return { roomInstanceId: 'ri', seatId, scanFrom: 0 }; },
        async poll() { return { seats: [] }; },
        async claim() { return { wakeRunId: 'wr', claims: [] }; },
        async renew() { return {}; },
        async progress() { return {}; },
      },
      adapters,
      state: {
        seats: [{
          seatId, code: 'ABC-DEF', name: '开发工程师', adapterId: 'codex', cwd: directory,
          status: 'running', pid: 5150,
        }],
      },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive, cmdline: 'codex' }),
      stopProcess: () => { alive = false; },
    });
    const control = await startControlServer({
      daemon,
      credentials: new MemoryCredentialStore(),
      statePath: join(directory, 'daemon.json'),
      stateDir: directory,
      server: 'https://room.example',
      adapters,
      secrets,
      log,
      getToken: async () => '',
      setToken: () => {},
    });
    const roomOrigin = 'https://room.example';
    try {
      const page = await fetch(`http://127.0.0.1:${control.port}/?t=${control.token}&terminal=${seatId}&popout=1`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).not.toContain('jsdelivr');
      expect(html).toContain('/vendor/xterm.js');
      expect(html).toContain('defer');
      expect(html).toContain('id="term-boot"');
      expect(html).toContain('html.popout #term-wrap');
      expect(html).toContain("document.body.classList.add('popout')");
      expect(html).toContain("wrap.classList.add('term-open')");
      expect(html).not.toMatch(/id="term-wrap"\s+hidden/);
      expect(html).toContain("get('popout')");
      expect(html).toContain('id="term-stop"');

      const vendor = await fetch(`http://127.0.0.1:${control.port}/vendor/xterm.js`);
      expect(vendor.status).toBe(200);
      expect(vendor.headers.get('content-type')).toContain('javascript');
      expect(await vendor.text()).toContain('Terminal');
      const fit = await fetch(`http://127.0.0.1:${control.port}/vendor/xterm-addon-fit.js`);
      expect(fit.status).toBe(200);
      expect(await fit.text()).toContain('FitAddon');

      const denied = await fetch(`http://127.0.0.1:${control.port}/api/desktop/terminals/${seatId}/stop`, {
        method: 'POST',
        headers: { origin: roomOrigin },
      });
      expect(denied.status).toBe(401);

      if (ptyAvailable()) {
        const session = spawnPtySession({
          seatId,
          command: 'bash',
          args: ['-lc', 'exec cat'],
          cwd: directory,
          env: {},
        });
        const stopped = await fetch(`http://127.0.0.1:${control.port}/api/desktop/terminals/${seatId}/stop`, {
          method: 'POST',
          headers: { origin: roomOrigin, 'x-agent-room-desktop': '1' },
        });
        expect(stopped.status).toBe(200);
        expect(await stopped.json()).toMatchObject({ ok: true, stopped: true, seatId });
        const deadline = Date.now() + 3000;
        while (getPtySession(seatId) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        expect(getPtySession(seatId)).toBeUndefined();
        expect(daemon.seats[0]).toMatchObject({ status: 'idle', pid: undefined });
        const gone = await fetch(`http://127.0.0.1:${control.port}/api/terminals/missing-seat/stop?t=${control.token}`, {
          method: 'POST',
        });
        expect(gone.status).toBe(404);
        expect(session.pid).toBeGreaterThan(0);
      } else {
        const stopped = await fetch(`http://127.0.0.1:${control.port}/api/terminals/${seatId}/stop?t=${control.token}`, {
          method: 'POST',
        });
        expect(stopped.status).toBe(200);
        expect(daemon.seats[0]?.status).toBe('idle');
      }
    } finally {
      await control.close();
    }
  }, 20_000);
});
