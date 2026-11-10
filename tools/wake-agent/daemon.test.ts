import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexCliAdapter, createCursorAdapter, type ProcessSpawner, type SpawnedProcess } from './src/adapter.js';
import { MemoryCredentialStore } from './src/credstore.js';
import { cursorFirstSubmit, decideCursorFirstEnter, FileRunLock, MemoryRunLock, WakeDaemon, seatLogPath, type WakeApi } from './src/daemon.js';
import { createHttpWakeApi, WakeHttpError } from './src/http.js';
import { nextWait } from './src/interval.js';
import { reuseWakePrompt, wakePrompt } from './src/prompt.js';
import { SecretRegistry } from './src/redact.js';
import { readState, reconcileAfterRestart, setStateWriteBarrier, writeState, type DaemonState, type SeatRecord } from './src/state.js';

const THREAD = '{"type":"thread.started","thread_id":"thr_9"}\n';
const codexOpts = { directSpawn: true as const, waitCodexSession: async () => 'thr_9' };

function spawner(chunks: string[]): ProcessSpawner & { calls: { command: string; args: string[]; env: Record<string, string> }[] } {
  const calls: { command: string; args: string[]; env: Record<string, string> }[] = [];
  let pid = 400;
  return {
    calls,
    spawn(command, args, opts): SpawnedProcess {
      calls.push({ command, args: [...args], env: { ...opts.env } });
      const output = chunks;
      return {
        pid: pid++,
        stdout: (async function* () { for (const chunk of output) yield chunk; })(),
        exited: new Promise(() => {}),
      };
    },
  };
}

function api(): WakeApi & { calls: string[]; polls: number; registered: { seatKey?: string; cursor?: number }[] } {
  const calls: string[] = [];
  const registered: { seatKey?: string; cursor?: number }[] = [];
  let polls = 0;
  return {
    calls,
    registered,
    get polls() { return polls; },
    async register(body) { calls.push('register'); registered.push(body); return { roomInstanceId: 'ri', seatId: 'st_a', scanFrom: 3 }; },
    async poll() {
      polls += 1;
      calls.push('poll');
      return {
        nextPollMs: 5_000,
        seats: [{
          seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', status: 'active' as const,
          pending: [{ eventId: 'wk:1', preview: 'secret body' }],
          inFlight: polls > 1 ? [{ eventId: 'wk:1', claimId: 'cl-wk:1' }] : [],
          failed: [],
        }],
      };
    },
    async claim(body) {
      calls.push(`claim:${body.wakeRunId ?? 'new'}`);
      return { wakeRunId: body.wakeRunId ?? 'wr_1', readFrom: 183, gap: [120, 183], claims: body.eventIds.map(eventId => ({ eventId, claimId: `cl-${eventId}` })) };
    },
    async renew() { calls.push('renew'); return { renewed: [] }; },
    async progress(body) {
      for (const claim of body.claims) {
        if (claim.status !== 'resume_started' && claim.status !== 'resume_failed') throw new Error('success_forbidden');
        calls.push(claim.status);
      }
      return { updated: [] };
    },
  };
}

describe('wake daemon', () => {
  it('keeps polling after a poll timeout instead of throwing out of run()', async () => {
    const client = api();
    let calls = 0;
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    client.poll = async () => { calls++; if (calls <= 2) throw timeout; return { seats: [], nextPollMs: 5 } as never; };
    let sleeps = 0;
    const daemon: WakeDaemon = new WakeDaemon({
      api: client,
      adapters: new Map(),
      state: { seats: [] },
      lock: new MemoryRunLock(),
      sleep: async () => { sleeps++; if (sleeps >= 3) daemon.stop(); },
    });
    await expect(daemon.run()).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('releases a stale file lock left by a killed daemon so idle seats can resume', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-lock-'));
    const lock = new FileRunLock(directory);
    expect(await lock.tryAcquire('st_old')).toBe(true);
    const daemon = new WakeDaemon({
      api: api(),
      adapters: new Map(),
      state: { seats: [{ seatId: 'st_old', code: 'C', name: 'n', adapterId: 'codex', cwd: '/', status: 'running', pid: 999999 }] },
      lock,
      inspect: () => ({ alive: false, cmdline: '' }),
    });
    await daemon.releaseStaleLocks();
    expect(await lock.tryAcquire('st_old')).toBe(true);
  });

  it('launches Codex, registers, and writes a 0600 state file without the seatKey', async () => {
    const child = spawner(['boot\n', THREAD]);
    const adapter = new CodexCliAdapter(child, codexOpts);
    const directory = await mkdtemp(join(tmpdir(), 'wake-agent-'));
    const path = join(directory, 'daemon.json');
    const client = api();
    const logs: string[] = [];
    const creds = new MemoryCredentialStore();
    const order: string[] = [];
    const daemon = new WakeDaemon({
      api: client,
      adapters: new Map([['codex', adapter]]),
      state: { seats: [] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: true, cmdline: 'codex -m' }),
      log: line => logs.push(line),
      persist: state => writeState(path, state),
      credentials: creds,
      secrets: new SecretRegistry(),
      server: 'http://127.0.0.1:9',
      joinRoom: async () => { order.push('join'); return { seatKey: 'super-secret-key', cursor: 3, name: 'codex-a' }; },
    });
    const register = client.register.bind(client);
    client.register = async body => { order.push('register'); return register(body); };
    const inner = child.spawn.bind(child);
    child.spawn = (command, args, opts) => { order.push('launch'); return inner(command, args, opts); };
    const seat = await daemon.startAgent({
      server: 'http://127.0.0.1:9', code: 'ABC-DEF-GHJ', inviteCode: 'invite-1', name: 'codex-a',
      cwd: '/work', adapterId: 'codex', model: 'gpt-6-sol',
    });
    expect(order).toEqual(['join', 'register', 'launch']);
    expect(seat).toMatchObject({ seatId: 'st_a', roomInstanceId: 'ri', sessionId: 'thr_9', pid: 400, status: 'running', model: 'gpt-6-sol' });
    expect(seat.startedAt).toEqual(expect.any(String));
    expect(child.calls[0]!.args.slice(0, 2)).toEqual(['-m', 'gpt-6-sol']);
    expect(child.calls[0]!.args).toContain('suppress_unstable_features_warning=true');
    expect(child.calls[0]!.args).toContain('mcp_servers.agent-room.default_tools_approval_mode="approve"');
    expect(child.calls[0]!.args.at(-1)).toContain('seatKey: "super-secret-key"');
    expect(child.calls[0]!.args.at(-1)).toContain('AGENT_ROOM_SEAT_KEY');
    expect(child.calls[0]!.args.at(-1)).toContain('AGENT_ROOM_CURSOR');
    expect(child.calls[0]!.args.join(' ')).not.toMatch(/dangerously|full-auto|--yolo|--force/);
    expect(child.calls[0]!.env).toMatchObject({
      AGENT_ROOM_MANAGED: '1', AGENT_ROOM_SERVER: 'http://127.0.0.1:9',
      AGENT_ROOM_BASE_URL: 'http://127.0.0.1:9', AGENT_ROOM_CODE: 'ABC-DEF-GHJ',
      AGENT_ROOM_NAME: 'codex-a', AGENT_ROOM_SEAT_KEY: 'super-secret-key', AGENT_ROOM_CURSOR: '3',
    });
    expect(await creds.get('seat:st_a')).toBe('super-secret-key');
    expect(client.registered[0]).toMatchObject({ seatKey: 'super-secret-key', cursor: 3 });
    const saved = await readState(path);
    expect(saved.seats[0]).toMatchObject({ sessionId: 'thr_9', model: 'gpt-6-sol' });
    expect(JSON.stringify(saved)).not.toContain('super-secret-key');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(logs.join('\n')).not.toContain('super-secret-key');
    expect(logs.join('\n')).toContain('[redacted]');
    expect(logs.join('\n')).toContain('AGENT_ROOM_SEAT_KEY');
    expect(client.calls).toEqual(['register']);
  });

  it('keeps one poll loop, merges a running seat, and resumes an idle seat from readFrom', async () => {
    const child = spawner([THREAD]);
    const adapter = new CodexCliAdapter(child, codexOpts);
    const client = api();
    const logs: string[] = [];
    const daemon = new WakeDaemon({
      api: client,
      adapters: new Map([['codex', adapter]]),
      state: { seats: [{ seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', adapterId: 'codex', model: 'gpt-6-sol', sessionId: 'thr_9', cwd: '/work', status: 'idle' }] },
      lock: new MemoryRunLock(),
      inspect: pid => ({ alive: pid > 0, cmdline: 'codex resume thr_9' }),
      log: line => logs.push(line),
    });
    const first = daemon.tick();
    const second = daemon.tick();
    await Promise.all([first, second]);
    expect(client.polls).toBe(1);
    expect(child.calls).toHaveLength(1);
    expect(child.calls[0]!.args).toEqual([
      'resume', 'thr_9', '-m', 'gpt-6-sol',
      '-c', 'suppress_unstable_features_warning=true',
      '-c', 'mcp_servers.agent-room.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.airoom-e2e.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.airoom.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.agent-room.url="http://127.0.0.1:17421/mcp-shim"',
      '-c', 'mcp_servers.agent-room.bearer_token_env_var="AGENT_ROOM_SEAT_KEY"',
      '-c', 'mcp_servers.airoom-e2e.url="http://127.0.0.1:17421/mcp-shim"',
      '-c', 'mcp_servers.airoom-e2e.bearer_token_env_var="AGENT_ROOM_SEAT_KEY"',
      '-c', 'mcp_servers.airoom.url="http://127.0.0.1:17421/mcp-shim"',
      '-c', 'mcp_servers.airoom.bearer_token_env_var="AGENT_ROOM_SEAT_KEY"',
      expect.any(String),
    ]);
    const promptLog = logs.find(line => line.includes('since: 183'))!;
    expect(promptLog).toContain('第 120–182 条');
    expect(promptLog).not.toContain('secret body');
    expect(promptLog).toContain('seatKey: ""');
    expect(promptLog).not.toContain('AGENT_ROOM_SEAT_KEY');
    expect(promptLog).not.toContain('super-secret');
    expect(client.calls).toContain('resume_started');
    expect(client.calls).not.toContain('SUCCEEDED');

    client.calls.length = 0;
    daemon.seats[0]!.status = 'running';
    daemon.seats[0]!.wakeRunId = 'wr_1';
    daemon.seats[0]!.pid = 400;
    await daemon.tick();
    expect(client.calls).toContain('renew');
    expect(client.calls).toContain('claim:wr_1');
    expect(child.calls).toHaveLength(1);
  });

  it('releases the seat lock when a wake claim fails so a later poll can retry', async () => {
    const client = api();
    let attempts = 0;
    const claim = client.claim;
    client.claim = async body => {
      if (++attempts === 1) throw new Error('temporary_network_error');
      return claim(body);
    };
    const lock = new MemoryRunLock();
    const child = spawner([]);
    const daemon = new WakeDaemon({
      api: client,
      adapters: new Map([['codex', new CodexCliAdapter(child, codexOpts)]]),
      state: { seats: [{ seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', adapterId: 'codex', model: 'gpt-6-sol', sessionId: 'thr_9', cwd: '/work', status: 'idle' }] },
      lock,
      inspect: () => ({ alive: false, cmdline: '' }),
    });
    await daemon.tick();
    expect(lock.has('st_a')).toBe(false);
    await daemon.tick();
    expect(attempts).toBe(2);
    expect(child.calls).toHaveLength(1);
  });

  it('does not resume over a live user heartbeat, and takeover treats PID reuse as idle', () => {
    const state: DaemonState = { seats: [
      { seatId: 'st_a', code: 'ABC', name: 'codex-a', adapterId: 'codex', sessionId: 'thr_9', cwd: '/work', pid: 9, status: 'running', wakeRunId: 'wr' },
      { seatId: 'st_b', code: 'ABC', name: 'codex-b', adapterId: 'codex', sessionId: 'thr_2', cwd: '/work', pid: 2, status: 'running' },
    ] };
    const reconciled = reconcileAfterRestart(state, pid => pid === 9
      ? { alive: true, cmdline: 'codex\0-m' }
      : { alive: true, cmdline: 'nginx' }, 'codex');
    expect(reconciled.seats[0]).toMatchObject({ status: 'running', pid: 9 });
    expect(reconciled.seats[1]).toMatchObject({ status: 'idle', pid: undefined });
    const prompt = wakePrompt({ code: 'ABC', name: 'codex-a', readFrom: 4, seatKey: 'seat-key-secret' });
    expect(prompt).toContain('since: 4');
    expect(prompt).toContain('MCP 工具已预先批准');
    expect(prompt).toContain('不要等用户在终端里逐个批准');
    expect(prompt).toContain('managed: { seatKey: "seat-key-secret" }');
    expect(prompt).toContain('room_sleep({ code: "ABC", name: "codex-a", cursor: <最新 cursor>, seatKey: "seat-key-secret" })');
    expect(prompt).not.toContain('AGENT_ROOM_SEAT_KEY');
    expect(seatLogPath('C:\\Users\\a\\AppData\\Local\\Agent Room\\logs', 'st_a'))
      .toBe('C:\\Users\\a\\AppData\\Local\\Agent Room\\logs\\st_a.log');
    expect(seatLogPath('/home/me/.local/state/agent-room', 'st_b'))
      .toBe('/home/me/.local/state/agent-room/logs/st_b.log');
    expect(seatLogPath('C:\\Users\\a\\AppData\\Local\\Agent Room\\logs', 'st_a')).not.toContain('.\\.agent-room');
    const live = reconcileAfterRestart({ seats: [state.seats[0]!] }, () => ({ alive: true, cmdline: '' }), 'codex');
    expect(live.seats[0]).toMatchObject({ status: 'running', pid: 9, sessionId: 'thr_9' });
  });

  it('backs off empty polls and network errors without changing the renew path', () => {
    expect(nextWait({ emptyStreak: 0, busy: true, networkError: false }).waitMs).toBe(5_000);
    expect(nextWait({ emptyStreak: 0, busy: false, networkError: false }).waitMs).toBe(5_000);
    expect(nextWait({ emptyStreak: 3, busy: false, networkError: false }).waitMs).toBe(30_000);
    expect(nextWait({ emptyStreak: 3, busy: false, networkError: false, serverNextPollMs: 45_000 }).waitMs).toBe(45_000);
    const errorWait = nextWait({ emptyStreak: 4, busy: false, networkError: true, random: 0 });
    expect(errorWait.waitMs).toBeLessThanOrEqual(60_000);
    expect(errorWait.waitMs).toBeGreaterThan(30_000);
  });

  it('blocks resume while a user session heartbeat is alive', async () => {
    const child = spawner([]);
    const client = api();
    const daemon = new WakeDaemon({
      api: client,
      adapters: new Map([['codex', new CodexCliAdapter(child, codexOpts)]]),
      state: { seats: [{ seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', adapterId: 'codex', sessionId: 'thr_9', cwd: '/work', status: 'idle' }] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: true, cmdline: 'codex -m' }),
      heartbeat: { blocks: () => true },
    });
    await daemon.tick();
    expect(client.calls).toEqual(['poll']);
    expect(child.calls).toHaveLength(0);
    expect(daemon.seats[0]!.status).toBe('idle');
  });

  it('keeps a live matching pid, idles a dead or reused pid, then resumes with the stored session and seat key', async () => {
    const child = spawner([THREAD]);
    const creds = new MemoryCredentialStore();
    await creds.set('seat:st_dead', 'seat-key-secret');
    const base = (extra: Partial<SeatRecord>): SeatRecord => ({
      seatId: 'st_live', code: 'ABC', name: 'codex-a', adapterId: 'codex', model: 'gpt-6-sol',
      sessionId: 'thr_live', cwd: '/work', pid: 11, status: 'running', ...extra,
    });
    const state: DaemonState = { seats: [
      base({ seatId: 'st_live', pid: 11, sessionId: 'thr_live', adapterId: 'codex' }),
      base({ seatId: 'st_reuse', pid: 22, sessionId: 'ses_2', adapterId: 'cursor-agent', model: 'grok-4.7', name: 'cursor-a' }),
      base({ seatId: 'st_dead', pid: 33, sessionId: 'thr_9', model: 'gpt-6-sol', name: 'sleeper' }),
    ] };
    const client = api();
    client.poll = async () => {
      client.calls.push('poll');
      return {
        seats: [{
          seatId: 'st_dead', code: 'ABC', name: 'sleeper', status: 'active' as const,
          pending: [{ eventId: 'wk:9' }], inFlight: [], failed: [],
        }],
      };
    };
    const daemon = new WakeDaemon({
      api: client,
      adapters: new Map<string, CodexCliAdapter | ReturnType<typeof createCursorAdapter>>([
        ['codex', new CodexCliAdapter(child, codexOpts)],
        ['cursor-agent', createCursorAdapter(child)],
      ]),
      state,
      lock: new MemoryRunLock(),
      inspect: pid => {
        if (pid === 11) return { alive: true, cmdline: '/usr/bin/codex\0-m' };
        if (pid === 22) return { alive: true, cmdline: 'nginx\0worker' };
        return { alive: false, cmdline: '' };
      },
      credentials: creds,
      server: 'http://127.0.0.1:9',
    });
    expect(daemon.seats.find(seat => seat.seatId === 'st_live')).toMatchObject({ status: 'running', pid: 11, sessionId: 'thr_live' });
    expect(daemon.seats.find(seat => seat.seatId === 'st_reuse')).toMatchObject({ status: 'idle', pid: undefined, sessionId: 'ses_2' });
    expect(daemon.seats.find(seat => seat.seatId === 'st_dead')).toMatchObject({ status: 'idle', pid: undefined, sessionId: 'thr_9' });
    await daemon.tick();
    expect(child.calls).toHaveLength(1);
    expect(child.calls[0]!.args).toEqual([
      'resume', 'thr_9', '-m', 'gpt-6-sol',
      '-c', 'suppress_unstable_features_warning=true',
      '-c', 'mcp_servers.agent-room.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.airoom-e2e.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.airoom.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.agent-room.url="http://127.0.0.1:17421/mcp-shim"',
      '-c', 'mcp_servers.agent-room.bearer_token_env_var="AGENT_ROOM_SEAT_KEY"',
      '-c', 'mcp_servers.airoom-e2e.url="http://127.0.0.1:17421/mcp-shim"',
      '-c', 'mcp_servers.airoom-e2e.bearer_token_env_var="AGENT_ROOM_SEAT_KEY"',
      '-c', 'mcp_servers.airoom.url="http://127.0.0.1:17421/mcp-shim"',
      '-c', 'mcp_servers.airoom.bearer_token_env_var="AGENT_ROOM_SEAT_KEY"',
      expect.any(String),
    ]);
    expect(child.calls[0]!.args.at(-1)).toContain('seatKey: "seat-key-secret"');
    expect(child.calls[0]!.args.at(-1)).not.toContain('AGENT_ROOM_SEAT_KEY');
    expect(child.calls[0]!.env.AGENT_ROOM_SEAT_KEY).toBe('seat-key-secret');
    expect(daemon.seats.find(seat => seat.seatId === 'st_dead')).toMatchObject({ status: 'running', sessionId: 'thr_9', model: 'gpt-6-sol' });
  });

  it('waits out a live listen, then stops that process before codex resume', async () => {
    const child = spawner([THREAD]);
    let alive = true;
    const stopped: number[] = [];
    let now = 1_000_000;
    const creds = new MemoryCredentialStore();
    await creds.set('seat:st_a', 'seat-key-secret');
    const daemon = new WakeDaemon({
      api: api(),
      adapters: new Map([['codex', new CodexCliAdapter(child, codexOpts)]]),
      state: { seats: [{
        seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', adapterId: 'codex', model: 'gpt-6-sol',
        sessionId: 'thr_9', cwd: '/work', status: 'running', pid: 4242, wakeRunId: 'wr_1',
      }] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive, cmdline: 'xfce4-terminal --title Agent Room · codex' }),
      now: () => now,
      resumeGraceMs: 8_000,
      stopProcess: pid => { stopped.push(pid); alive = false; },
      server: 'http://127.0.0.1:9',
      credentials: creds,
    });
    await daemon.tick();
    expect(stopped).toEqual([]);
    expect(child.calls).toHaveLength(0);
    now += 8_000;
    await daemon.tick();
    expect(stopped).toEqual([4242]);
    expect(child.calls).toHaveLength(1);
    expect(child.calls[0]!.args[0]).toBe('resume');
    expect(child.calls[0]!.args.at(-1)).toContain('seatKey: "seat-key-secret"');
    expect(daemon.seats[0]).toMatchObject({ status: 'running', sessionId: 'thr_9' });
    expect(daemon.seats[0]!.pid).not.toBe(4242);
  });

  it('marks a remotely revoked seat, and stops polling after device 401', async () => {
    const logs: string[] = [];
    const revoked = api();
    revoked.poll = async () => ({
      seats: [{ seatId: 'st_a', code: 'ABC', name: 'codex-a', status: 'revoked' as const, pending: [], inFlight: [], failed: [] }],
    });
    const running: SeatRecord = {
      seatId: 'st_a', code: 'ABC', name: 'codex-a', adapterId: 'codex', model: 'gpt-6-sol',
      sessionId: 'thr_9', cwd: '/work', pid: 9, status: 'running',
    };
    const daemon = new WakeDaemon({
      api: revoked,
      adapters: new Map([['codex', new CodexCliAdapter(spawner([]), codexOpts)]]),
      state: { seats: [running] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: true, cmdline: 'codex -m' }),
      log: line => logs.push(line),
    });
    await daemon.tick();
    expect(daemon.seats[0]).toMatchObject({ status: 'revoked', pid: undefined });
    expect(logs.join('\n')).toContain('revoked');
    expect(daemon.authState).toBe('ok');

    let polls = 0;
    const denied = new WakeDaemon({
      api: {
        async register() { return { roomInstanceId: 'ri', seatId: 'st_a', scanFrom: 0 }; },
        async poll() { polls += 1; throw new WakeHttpError('unauthorized', 401); },
        async claim() { return { wakeRunId: 'wr', readFrom: 0, claims: [] }; },
        async renew() { return {}; },
        async progress() { return {}; },
      },
      adapters: new Map([['codex', new CodexCliAdapter(spawner([]), codexOpts)]]),
      state: { seats: [{ ...running, seatId: 'st_b', status: 'idle', pid: undefined }] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: false, cmdline: '' }),
      log: line => logs.push(line),
    });
    await denied.tick();
    await denied.tick();
    expect(polls).toBe(1);
    expect(denied.authState).toBe('unauthorized');
    expect(denied.seats[0]!.status).toBe('revoked');
    expect(logs.join('\n')).toContain('polling stopped until re-paired');
    denied.resumeAfterPair();
    expect(denied.authState).toBe('ok');
  });
});

describe('local lock and http client', () => {
  it('allows one holder of a seat lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-lock-'));
    const lock = new FileRunLock(directory);
    expect(await lock.tryAcquire('st_a')).toBe(true);
    expect(await lock.tryAcquire('st_a')).toBe(false);
    await lock.release('st_a');
    expect(await lock.tryAcquire('st_a')).toBe(true);
  });

  it('posts wake actions with the device token and never a success status', async () => {
    const seen: { url: string; body: { action: string; status?: string }; authorization: string }[] = [];
    const client = createHttpWakeApi('http://127.0.0.1:9', 'device-token', async (url, init) => {
      const body = JSON.parse(init.body) as { action: string; status?: string };
      seen.push({ url, body, authorization: init.headers.authorization ?? '' });
      return { ok: true, status: 200, json: async () => ({ seats: [], nextPollMs: 5000, wakeRunId: 'wr', readFrom: 1, claims: [] }) };
    });
    await client.poll();
    await client.progress({ claims: [{ claimId: 'cl', status: 'resume_started' }] });
    expect(seen.every(call => call.authorization === 'Bearer device-token')).toBe(true);
    expect(seen.map(call => call.body.action)).toEqual(['poll', 'progress']);
    expect(JSON.stringify(seen)).not.toContain('succeeded');
  });
});

describe('state file round trip', () => {
  it('returns an empty state when the file is absent', async () => {
    expect(await readState(join(tmpdir(), 'missing-wake-daemon.json'))).toEqual({ seats: [] });
    const directory = await mkdtemp(join(tmpdir(), 'wake-agent-'));
    const path = join(directory, 'nested', 'daemon.json');
    await writeState(path, { seats: [] });
    expect(await readFile(path, 'utf8')).toContain('seats');
  });

  it('does not let an in-flight empty write erase a seat added during launch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-state-race-'));
    const path = join(directory, 'daemon.json');
    const state: DaemonState = { seats: [] };
    const seat: SeatRecord = {
      seatId: 'st_keep', code: 'ABC-DEF-GHJ', name: '席', adapterId: 'codex', model: 'gpt-6-luna',
      sessionId: 'thr_keep', cwd: 'D:\\work', status: 'running', pid: 42,
    };
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    let used = false;
    setStateWriteBarrier(async () => {
      if (used) return;
      used = true;
      entered();
      await gate;
    });
    try {
      const first = writeState(path, state);
      await enteredGate;
      state.seats.push(seat);
      const second = writeState(path, state);
      release();
      await first;
      await second;
    } finally {
      setStateWriteBarrier(undefined);
    }
    const saved = await readState(path);
    expect(saved.seats.map(item => item.seatId)).toEqual(['st_keep']);
    expect(saved.seats[0]).toMatchObject({ sessionId: 'thr_keep', model: 'gpt-6-luna', name: '席' });
  });

  it('keeps the seat after the console exits and after a daemon restart', async () => {
    let finish: (code: number) => void = () => {};
    const exited = new Promise<number>(resolve => { finish = resolve; });
    const child = spawner([]);
    const inner = child.spawn.bind(child);
    child.spawn = (command, args, opts) => ({ ...inner(command, args, opts), exited });
    const adapter = new CodexCliAdapter(child, codexOpts);
    const directory = await mkdtemp(join(tmpdir(), 'wake-survive-'));
    const path = join(directory, 'daemon.json');
    const daemon = new WakeDaemon({
      api: api(),
      adapters: new Map([['codex', adapter]]),
      state: { seats: [] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: true, cmdline: 'codex -m' }),
      persist: state => writeState(path, state),
      credentials: new MemoryCredentialStore(),
      server: 'http://127.0.0.1:9',
      stateDir: directory,
      joinRoom: async () => ({ seatKey: 'super-secret-key', cursor: 3, name: 'codex-a' }),
    });
    const seat = await daemon.startAgent({
      server: 'http://127.0.0.1:9', code: 'ABC-DEF-GHJ', inviteCode: 'invite-1', name: 'codex-a',
      cwd: '/work', adapterId: 'codex', model: 'gpt-6-sol',
    });
    expect((await readState(path)).seats.map(item => item.seatId)).toEqual([seat.seatId]);
    finish(1);
    let idle = false;
    for (let attempt = 0; attempt < 50 && !idle; attempt += 1) {
      const disk = await readState(path);
      idle = disk.seats[0]?.status === 'idle' && disk.seats[0]?.sessionId === 'thr_9';
      if (!idle) await new Promise(resolve => setTimeout(resolve, 20));
    }
    const disk = await readState(path);
    expect(disk.seats).toHaveLength(1);
    expect(disk.seats[0]).toMatchObject({ seatId: 'st_a', status: 'idle', sessionId: 'thr_9', model: 'gpt-6-sol' });
    expect(disk.seats[0]!.pid).toBeUndefined();
    expect(JSON.stringify(disk)).not.toContain('super-secret-key');
    const restarted = new WakeDaemon({
      api: api(),
      adapters: new Map(),
      state: await readState(path),
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: false, cmdline: '' }),
    });
    expect(restarted.seats).toHaveLength(1);
    expect(restarted.seats[0]).toMatchObject({ seatId: 'st_a', status: 'idle', sessionId: 'thr_9', model: 'gpt-6-sol' });
  });

  it('does not resume a seat the user stopped', async () => {
    const stopped: number[] = [];
    let alive = true;
    const surface = api();
    const daemon = new WakeDaemon({
      api: surface,
      adapters: new Map(),
      state: {
        seats: [{
          seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', adapterId: 'codex', model: 'gpt-6-sol',
          sessionId: 'thr_9', cwd: '/work', status: 'running', pid: 4242,
        }],
      },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive, cmdline: 'codex' }),
      stopProcess: (pid) => { stopped.push(pid); alive = false; },
    });
    expect(await daemon.stopManagedSeat('st_a')).toBe(true);
    expect(stopped).toEqual([4242]);
    // Closed seats are removed from local state (rail + room kick path).
    expect(daemon.seats.find(s => s.seatId === 'st_a')).toBeUndefined();
    await daemon.tick();
    expect(surface.calls).toEqual(['poll']);
    expect(await daemon.stopManagedSeat('missing')).toBe(false);
  });

  it('re-resumes after grace when pending @ never acks under a live inFlight run', async () => {
    const child = spawner([THREAD]);
    let now = 1_000;
    const stopped: number[] = [];
    let alive = true;
    const surface = api();
    surface.poll = async () => {
      surface.calls.push('poll');
      return {
        nextPollMs: 5_000,
        seats: [{
          seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'cursor-a', status: 'active' as const,
          pending: [{ eventId: 'wk:2', preview: '@ hello' }],
          inFlight: [{ eventId: 'wk:1', claimId: 'cl-wk:1', state: 'WAITING_ACK' }],
          failed: [],
        }],
      };
    };
    const daemon = new WakeDaemon({
      api: surface,
      adapters: new Map([['codex', new CodexCliAdapter(child, codexOpts)]]),
      state: { seats: [{
        seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'cursor-a', adapterId: 'codex', model: 'gpt-6-sol',
        sessionId: 'thr_9', cwd: '/work', status: 'running', pid: 400, wakeRunId: 'wr_1',
      }] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive, cmdline: 'codex resume thr_9' }),
      now: () => now,
      resumeGraceMs: 100,
      stopProcess: pid => { stopped.push(pid); alive = false; },
    });
    await daemon.tick();
    expect(stopped).toEqual([]);
    expect(child.calls).toHaveLength(0);
    expect(surface.calls).toContain('claim:wr_1'); // merge within grace
    now = 1_250; // past grace
    surface.calls.length = 0;
    await daemon.tick();
    expect(surface.calls).toContain('resume_failed');
    expect(stopped).toEqual([400]);
    expect(child.calls).toHaveLength(1);
    expect(child.calls[0]!.args[0]).toBe('resume');
  });

  it('keeps a healthy live listen: inFlight-only past grace must not kill the process', async () => {
    const child = spawner([THREAD]);
    let now = 1_000;
    const stopped: number[] = [];
    let alive = true;
    const surface = api();
    surface.poll = async () => {
      surface.calls.push('poll');
      return {
        nextPollMs: 5_000,
        seats: [{
          seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'cursor-a', status: 'active' as const,
          pending: [],
          inFlight: [{ eventId: 'wk:1', claimId: 'cl-wk:1', state: 'WAITING_ACK' }],
          failed: [],
        }],
      };
    };
    const daemon = new WakeDaemon({
      api: surface,
      adapters: new Map([['codex', new CodexCliAdapter(child, codexOpts)]]),
      state: { seats: [{
        seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'cursor-a', adapterId: 'codex', model: 'gpt-6-sol',
        sessionId: 'thr_9', cwd: '/work', status: 'running', pid: 400, wakeRunId: 'wr_1',
      }] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive, cmdline: 'codex resume thr_9' }),
      now: () => now,
      resumeGraceMs: 100,
      stopProcess: pid => { stopped.push(pid); alive = false; },
    });
    await daemon.tick();
    now = 1_500; // well past grace
    surface.calls.length = 0;
    await daemon.tick();
    expect(stopped).toEqual([]);
    expect(child.calls).toHaveLength(0);
    expect(surface.calls).toContain('renew');
    expect(surface.calls).not.toContain('resume_failed');
    expect(daemon.seats[0]).toMatchObject({ status: 'running', pid: 400, wakeRunId: 'wr_1' });
  });

  it('skips resume grace when room_sleep left no wakeRunId so @ wakes immediately', async () => {
    const child = spawner([THREAD]);
    let now = 1_000;
    const stopped: number[] = [];
    let alive = true;
    const surface = api();
    surface.poll = async () => {
      surface.calls.push('poll');
      return {
        nextPollMs: 5_000,
        seats: [{
          seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'cursor-a', status: 'active' as const,
          pending: [{ eventId: 'wk:2', preview: '@ wake' }],
          inFlight: [],
          failed: [],
        }],
      };
    };
    const daemon = new WakeDaemon({
      api: surface,
      adapters: new Map([['codex', new CodexCliAdapter(child, codexOpts)]]),
      state: { seats: [{
        seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'cursor-a', adapterId: 'codex', model: 'gpt-6-sol',
        sessionId: 'thr_9', cwd: '/work', status: 'running', pid: 400,
      }] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive, cmdline: 'codex' }),
      now: () => now,
      resumeGraceMs: 8_000,
      stopProcess: pid => { stopped.push(pid); alive = false; },
    });
    await daemon.tick();
    expect(stopped).toEqual([400]);
    expect(child.calls).toHaveLength(1);
    expect(child.calls[0]!.args[0]).toBe('resume');
  });

  it('clears wakeRunId when poll sleptAt advances so post-sleep @ injects without grace', async () => {
    const child = spawner([THREAD]);
    const stopped: number[] = [];
    const writes: { seatId: string; data: string }[] = [];
    let alive = true;
    let now = 1_000_000;
    const surface = api();
    // Idle poll carries advanced sleptAt (room_sleep handoff) while wakeRunId still set.
    surface.poll = async () => {
      surface.calls.push('poll');
      return {
        nextPollMs: 5_000,
        seats: [{
          seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', status: 'active' as const,
          pending: [], inFlight: [], failed: [], sleptAt: 2_000_000,
        }],
      };
    };
    const daemon = new WakeDaemon({
      api: surface,
      adapters: new Map([['codex', new CodexCliAdapter(child, codexOpts)]]),
      state: { seats: [{
        seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', adapterId: 'codex', model: 'gpt-6-sol',
        sessionId: 'thr_9', cwd: '/work', status: 'running', pid: 4242, wakeRunId: 'wr_old',
      }] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive, cmdline: 'codex' }),
      now: () => now,
      resumeGraceMs: 8_000,
      stopProcess: pid => { stopped.push(pid); alive = false; },
      injectEnterDelayMs: 0,
      writeSeatStdin: (seatId, data) => { writes.push({ seatId, data }); return true; },
    });
    await daemon.tick();
    expect(daemon.seats[0]!.wakeRunId).toBeUndefined();
    expect(writes).toHaveLength(0);
    expect(stopped).toEqual([]);

    // New @ with wakeRunId cleared: inject immediately (no 8s grace).
    surface.poll = async () => {
      surface.calls.push('poll');
      return {
        nextPollMs: 5_000,
        seats: [{
          seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', status: 'active' as const,
          pending: [{ eventId: 'wk:post-sleep', preview: '@ after sleep' }],
          inFlight: [], failed: [], sleptAt: 2_000_000,
        }],
      };
    };
    await daemon.tick();
    expect(stopped).toEqual([]);
    expect(child.calls).toHaveLength(0);
    expect(writes).toHaveLength(2);
    expect(writes[0]!.data).toContain('执行唤醒监听');
    expect(daemon.seats[0]).toMatchObject({ status: 'running', pid: 4242, wakeRunId: 'wr_1' });
  });

  it('uses 1s wait while deferring live-listen grace instead of busy 5s', async () => {
    const child = spawner([THREAD]);
    let now = 1_000;
    const surface = api();
    surface.poll = async () => {
      surface.calls.push('poll');
      return {
        nextPollMs: 5_000,
        seats: [{
          seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', status: 'active' as const,
          pending: [{ eventId: 'wk:live', preview: '@ mid listen' }],
          inFlight: [{ eventId: 'wk:old', claimId: 'cl-old' }],
          failed: [],
        }],
      };
    };
    const daemon = new WakeDaemon({
      api: surface,
      adapters: new Map([['codex', new CodexCliAdapter(child, codexOpts)]]),
      state: { seats: [{
        seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', adapterId: 'codex', model: 'gpt-6-sol',
        sessionId: 'thr_9', cwd: '/work', status: 'running', pid: 400, wakeRunId: 'wr_1',
      }] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: true, cmdline: 'codex' }),
      now: () => now,
      resumeGraceMs: 8_000,
    });
    await daemon.tick();
    expect(surface.calls).toContain('claim:wr_1'); // merge within grace
    expect(daemon.waitMs).toBe(1_000);
  });

  it('injects a short wake into a live PTY after sleep instead of stop+resume', async () => {
    const child = spawner([THREAD]);
    const stopped: number[] = [];
    const writes: { seatId: string; data: string }[] = [];
    let alive = true;
    const surface = api();
    surface.poll = async () => {
      surface.calls.push('poll');
      return {
        nextPollMs: 5_000,
        seats: [{
          seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'cursor-a', status: 'active' as const,
          pending: [{ eventId: 'wk:2', preview: '@ wake' }],
          inFlight: [],
          failed: [],
        }],
      };
    };
    const creds = new MemoryCredentialStore();
    await creds.set('seat:st_a', 'seat-key-secret');
    const daemon = new WakeDaemon({
      api: surface,
      adapters: new Map([['codex', new CodexCliAdapter(child, codexOpts)]]),
      state: { seats: [{
        seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'cursor-a', adapterId: 'codex', model: 'gpt-6-sol',
        sessionId: 'thr_9', cwd: '/work', status: 'running', pid: 400,
      }] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive, cmdline: 'codex' }),
      resumeGraceMs: 8_000,
      stopProcess: pid => { stopped.push(pid); alive = false; },
      credentials: creds,
      injectEnterDelayMs: 0,
      writeSeatStdin: (seatId, data) => {
        writes.push({ seatId, data });
        return true;
      },
    });
    await daemon.tick();
    expect(stopped).toEqual([]);
    expect(child.calls).toHaveLength(0);
    expect(writes).toHaveLength(2);
    expect(writes[0]!.seatId).toBe('st_a');
    expect(writes[0]!.data.startsWith('\x1b[200~')).toBe(true);
    expect(writes[0]!.data.endsWith('\x1b[201~')).toBe(true);
    expect(writes[0]!.data).toContain('执行唤醒监听，动作游标=183');
    expect(writes[0]!.data).not.toContain('seat-key-secret');
    expect(writes[0]!.data).not.toContain('since:');
    expect(writes[0]!.data.includes('\r')).toBe(false);
    expect(writes[1]).toEqual({ seatId: 'st_a', data: '\r' });
    expect(writes[0]!.data.length).toBeLessThan(wakePrompt({
      code: 'ABC-DEF-GHJ', name: 'cursor-a', readFrom: 183, seatKey: 'seat-key-secret',
    }).length);
    expect(surface.calls).toContain('resume_started');
    expect(daemon.seats[0]).toMatchObject({ status: 'running', pid: 400, wakeRunId: 'wr_1' });
    // Second @ while still alive must inject again, not kill.
    surface.calls.length = 0;
    writes.length = 0;
    surface.poll = async () => {
      surface.calls.push('poll');
      return {
        nextPollMs: 5_000,
        seats: [{
          seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'cursor-a', status: 'active' as const,
          pending: [{ eventId: 'wk:3', preview: '@ again' }],
          inFlight: [],
          failed: [],
        }],
      };
    };
    // Clear wakeRunId as after Quiet→sleep / managed_read completion for a fresh idle seat.
    daemon.seats[0]!.wakeRunId = undefined;
    await daemon.tick();
    expect(stopped).toEqual([]);
    expect(child.calls).toHaveLength(0);
    expect(writes).toHaveLength(2);
    expect(writes[0]!.data.startsWith('\x1b[200~')).toBe(true);
    expect(writes[1]).toEqual({ seatId: 'st_a', data: '\r' });
    expect(daemon.seats[0]!.pid).toBe(400);
  });

  it('falls back to stop+resume when live PTY write is refused', async () => {
    const child = spawner([THREAD]);
    const stopped: number[] = [];
    let alive = true;
    const surface = api();
    surface.poll = async () => {
      surface.calls.push('poll');
      return {
        nextPollMs: 5_000,
        seats: [{
          seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'cursor-a', status: 'active' as const,
          pending: [{ eventId: 'wk:2', preview: '@ wake' }],
          inFlight: [],
          failed: [],
        }],
      };
    };
    const daemon = new WakeDaemon({
      api: surface,
      adapters: new Map([['codex', new CodexCliAdapter(child, codexOpts)]]),
      state: { seats: [{
        seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'cursor-a', adapterId: 'codex', model: 'gpt-6-sol',
        sessionId: 'thr_9', cwd: '/work', status: 'running', pid: 400,
      }] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive, cmdline: 'codex' }),
      resumeGraceMs: 8_000,
      stopProcess: pid => { stopped.push(pid); alive = false; },
      writeSeatStdin: () => false,
    });
    await daemon.tick();
    expect(stopped).toEqual([400]);
    expect(child.calls).toHaveLength(1);
    expect(child.calls[0]!.args[0]).toBe('resume');
  });

  it('after grace injects into live PTY instead of killing when write succeeds', async () => {
    const child = spawner([THREAD]);
    let alive = true;
    const stopped: number[] = [];
    const writes: string[] = [];
    let now = 1_000_000;
    const creds = new MemoryCredentialStore();
    await creds.set('seat:st_a', 'seat-key-secret');
    const daemon = new WakeDaemon({
      api: api(),
      adapters: new Map([['codex', new CodexCliAdapter(child, codexOpts)]]),
      state: { seats: [{
        seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', adapterId: 'codex', model: 'gpt-6-sol',
        sessionId: 'thr_9', cwd: '/work', status: 'running', pid: 4242, wakeRunId: 'wr_1',
      }] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive, cmdline: 'xfce4-terminal --title Agent Room · codex' }),
      now: () => now,
      resumeGraceMs: 8_000,
      stopProcess: pid => { stopped.push(pid); alive = false; },
      server: 'http://127.0.0.1:9',
      credentials: creds,
      injectEnterDelayMs: 0,
      writeSeatStdin: (_seatId, data) => { writes.push(data); return true; },
    });
    await daemon.tick();
    expect(stopped).toEqual([]);
    expect(child.calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
    now += 8_000;
    await daemon.tick();
    expect(stopped).toEqual([]);
    expect(child.calls).toHaveLength(0);
    const expected = reuseWakePrompt({
      code: 'ABC-DEF-GHJ', name: 'codex-a', readFrom: 183, seatKey: 'seat-key-secret',
    });
    expect(expected).toBe('执行唤醒监听，动作游标=183（仅 room_listen 的 since，禁止当作 room_sleep 的 cursor）');
    expect(writes).toEqual([`\x1b[200~${expected}\x1b[201~`, '\r']);
    expect(daemon.seats[0]).toMatchObject({ status: 'running', pid: 4242, sessionId: 'thr_9' });
  });

  it('rolls back cloud join when launch fails so the room has no ghost seat', async () => {
    const left: { code: string; name: string }[] = [];
    const unregistered: string[] = [];
    const surface = api();
    surface.unregister = async ({ seatId }) => { unregistered.push(seatId); return { ok: true }; };
    const failing: ProcessSpawner = {
      spawn() {
        throw new Error('spawn -NoProfile ENOENT');
      },
    };
    const daemon = new WakeDaemon({
      api: surface,
      adapters: new Map([['codex', new CodexCliAdapter(failing, codexOpts)]]),
      state: { seats: [] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: false, cmdline: '' }),
      server: 'http://127.0.0.1:9',
      credentials: new MemoryCredentialStore(),
      joinRoom: async () => ({ seatKey: 'super-secret-key', cursor: 3, name: '测试工程师' }),
      leaveRoom: async (input) => { left.push({ code: input.code, name: input.name }); },
    });
    await expect(daemon.startAgent({
      server: 'http://127.0.0.1:9', code: 'ABC-DEF-GHJ', inviteCode: 'invite-1', name: '测试工程师',
      cwd: '/work', adapterId: 'codex', model: 'gpt-6-sol',
    })).rejects.toThrow(/ENOENT|spawn/);
    expect(unregistered).toEqual(['st_a']);
    expect(left).toEqual([{ code: 'ABC-DEF-GHJ', name: '测试工程师' }]);
    expect(daemon.seats).toEqual([]);
  });

  it('with roomsDir: writes shared rules + AGENTS (no state.md), short firstRun, cleans seat on close', async () => {
    const child = spawner([THREAD]);
    const adapter = new CodexCliAdapter(child, codexOpts);
    const directory = await mkdtemp(join(tmpdir(), 'wake-rooms-'));
    const roomsDir = join(directory, 'rooms');
    const path = join(directory, 'daemon.json');
    const creds = new MemoryCredentialStore();
    const daemon = new WakeDaemon({
      api: api(),
      adapters: new Map([['codex', adapter]]),
      state: { seats: [] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: true, cmdline: 'codex -m' }),
      persist: state => writeState(path, state),
      credentials: creds,
      server: 'http://127.0.0.1:9',
      roomsDir,
      joinRoom: async () => ({ seatKey: 'super-secret-key', cursor: 3, name: '开发工程师' }),
    });
    const seat = await daemon.startAgent({
      server: 'http://127.0.0.1:9', code: 'ABC-DEF-GHJ', inviteCode: 'invite-1', name: '开发工程师',
      cwd: '/work', adapterId: 'codex', model: 'gpt-6-sol',
    });
    expect(seat.rulesPath).toBe(join(roomsDir, 'rules.md'));
    expect(seat.statePath).toBeUndefined();
    expect(seat.seatDir).toBeTruthy();
    expect(seat.cwd).toBe(seat.seatDir);
    const prompt = child.calls[0]!.args.at(-1)!;
    expect(prompt).toContain('执行唤醒监听，动作游标=3');
    expect(prompt).toContain('AGENTS.md');
    expect(prompt).toContain('mcp-shim');
    expect(prompt).not.toContain('AGENT_ROOM_SEAT_KEY');
    expect(prompt).toContain('不要读 state.md');
    expect(prompt).not.toContain(seat.rulesPath!);
    expect(prompt).not.toContain('super-secret-key');
    expect(prompt).not.toContain('since: 3');
    expect(child.calls[0]!.env).toMatchObject({
      AGENT_ROOM_RULES_FILE: seat.rulesPath,
      AGENT_ROOM_ROOMS_DIR: roomsDir,
      AGENT_ROOM_SEAT_DIR: seat.seatDir,
      AGENT_ROOM_SEAT_KEY: 'super-secret-key',
      AGENT_ROOM_MCP_ALIAS: 'agent-room',
      AGENT_ROOM_ADAPTER: 'codex',
    });
    expect(child.calls[0]!.env).not.toHaveProperty('AGENT_ROOM_STATE_FILE');
    // Codex managed argv should pre-trust the seat/rooms dirs (no YOLO).
    const argv = child.calls[0]!.args.join('\0');
    expect(argv).toContain(`projects."${seat.seatDir}".trust_level="trusted"`);
    expect(argv).not.toMatch(/yolo|full-auto|dangerously/i);
    const rules = await readFile(seat.rulesPath!, 'utf8');
    expect(rules).toContain('动作游标');
    expect(rules).toContain('不要读 `state.md`');
    await expect(readFile(join(seat.seatDir!, 'state.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(seat.seatDir!, 'AGENTS.md'), 'utf8')).toContain('AGENT_ROOM_SEAT_KEY');

    expect(await daemon.stopManagedSeat(seat.seatId)).toBe(true);
    await expect(readFile(join(seat.seatDir!, 'AGENTS.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    // Shared rules kept after close
    expect(await readFile(seat.rulesPath!, 'utf8')).toContain('动作游标');
  });

  it('closes a seat with wake unregister and room leave', async () => {
    const stopped: number[] = [];
    let alive = true;
    const left: { code: string; name: string }[] = [];
    const unregistered: string[] = [];
    const surface = api();
    surface.unregister = async ({ seatId }) => { unregistered.push(seatId); return { ok: true }; };
    const creds = new MemoryCredentialStore();
    await creds.set('seat:st_a', 'seat-key-secret');
    const daemon = new WakeDaemon({
      api: surface,
      adapters: new Map(),
      state: {
        seats: [{
          seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', adapterId: 'codex', model: 'gpt-6-sol',
          sessionId: 'thr_9', cwd: '/work', status: 'running', pid: 4242,
        }],
      },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive, cmdline: 'codex' }),
      stopProcess: (pid) => { stopped.push(pid); alive = false; },
      server: 'http://127.0.0.1:9',
      credentials: creds,
      leaveRoom: async (input) => { left.push({ code: input.code, name: input.name }); },
    });
    expect(await daemon.stopManagedSeat('st_a')).toBe(true);
    expect(stopped).toEqual([4242]);
    expect(unregistered).toEqual(['st_a']);
    expect(left).toEqual([{ code: 'ABC-DEF-GHJ', name: 'codex-a' }]);
    expect(daemon.seats).toEqual([]);
    expect(await creds.get('seat:st_a')).toBeUndefined();
  });

  it('submits the first Cursor prompt with Enter when a PTY writer exists', async () => {
    expect(decideCursorFirstEnter('')).toBe('wait');
    expect(decideCursorFirstEnter('Cursor Agent\n')).toBe('submit');
    expect(decideCursorFirstEnter('Add a follow-up')).toBe('submit');
    expect(cursorFirstSubmit({ terminalMode: 'embedded', hasWriter: true })).toBe('pty');
    expect(cursorFirstSubmit({ terminalMode: 'system', hasWriter: true })).toBe('stdin');
    expect(cursorFirstSubmit({ terminalMode: 'system', hasWriter: false })).toBe('stdin');
    expect(cursorFirstSubmit({ terminalMode: 'embedded', hasWriter: false })).toBe('argv');
    const child = spawner([]);
    const writes: { seatId: string; data: string }[] = [];
    const logs: string[] = [];
    let seenCwd: string | undefined;
    const directory = await mkdtemp(join(tmpdir(), 'wake-cursor-first-'));
    const daemon = new WakeDaemon({
      api: api(),
      adapters: new Map([['cursor-agent', createCursorAdapter(child, {
        directSpawn: true,
        createChat: async cwd => { seenCwd = cwd; return '22222222-2222-4222-8222-222222222222'; },
      })]]),
      state: { seats: [] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: true, cmdline: 'cursor-agent' }),
      log: line => logs.push(line),
      server: 'http://127.0.0.1:9',
      roomsDir: join(directory, 'rooms'),
      terminalMode: 'embedded',
      injectEnterDelayMs: 0,
      firstSubmitWaitMs: 0,
      writeSeatStdin: (seatId, data) => { writes.push({ seatId, data }); return true; },
      joinRoom: async () => ({ seatKey: 'super-secret-key', cursor: 0, name: 'cursor-a' }),
    });
    const seat = await daemon.startAgent({
      server: 'http://127.0.0.1:9', code: 'ABC-DEF-GHJ', inviteCode: 'invite-1', name: 'cursor-a',
      cwd: '/work', adapterId: 'cursor-agent', model: 'grok-4.7-high',
    });
    expect(seenCwd).toBe(seat.cwd);
    expect(child.calls[0]!.args).toContain('--approve-mcps');
    expect(child.calls[0]!.args).not.toContain('--yolo');
    expect(child.calls[0]!.args).not.toContain('--force');
    expect(child.calls[0]!.args.join('\n')).not.toContain('执行唤醒监听');
    expect(writes.map(write => write.data)[0]).toContain('执行唤醒监听，动作游标=0');
    expect(writes.map(write => write.data)[1]).toBe('\r');
    expect(logs.join('\n')).toContain('cursor first-submit');
    expect(logs.join('\n')).toContain('enter=1');
    expect(logs.join('\n')).toContain('promptDelivery=pty');
    const cli = JSON.parse(await readFile(join(seat.seatDir!, '.cursor', 'cli.json'), 'utf8')) as {
      approvalMode?: string;
      permissions: { allow: string[]; deny: string[] };
    };
    expect(cli.approvalMode).toBeUndefined();
    expect(cli.permissions.allow).toContain('Mcp(agent-room:*)');
    expect(cli.permissions.deny).toEqual([]);
    expect(JSON.stringify(cli)).not.toContain('unrestricted');
  });

  it('system console first Cursor launch types via stdin instead of an argv draft', async () => {
    const seen: { args: string[]; prompt?: string; stdinSubmit?: boolean; cwd?: string }[] = [];
    const writes: string[] = [];
    let chatCwd: string | undefined;
    const directory = await mkdtemp(join(tmpdir(), 'wake-cursor-system-'));
    const daemon = new WakeDaemon({
      api: api(),
      adapters: new Map([['cursor-agent', createCursorAdapter({
        spawn(command, args, opts) {
          seen.push({ args: [...args], prompt: opts.prompt, stdinSubmit: opts.stdinSubmit, cwd: opts.cwd });
          return { pid: 401, stdout: (async function* () { /* empty */ })(), exited: new Promise(() => {}) };
          void command;
        },
      }, {
        directSpawn: true,
        createChat: async cwd => { chatCwd = cwd; return '22222222-2222-4222-8222-222222222222'; },
      })]]),
      state: { seats: [] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: true, cmdline: 'cursor-agent' }),
      server: 'http://127.0.0.1:9',
      roomsDir: join(directory, 'rooms'),
      terminalMode: 'system',
      writeSeatStdin: (_seatId, data) => { writes.push(data); return true; },
      joinRoom: async () => ({ seatKey: 'super-secret-key', cursor: 0, name: 'cursor-a' }),
    });
    const seat = await daemon.startAgent({
      server: 'http://127.0.0.1:9', code: 'ABC-DEF-GHJ', inviteCode: 'invite-1', name: 'cursor-a',
      cwd: '/work', adapterId: 'cursor-agent', model: 'grok-4.7-high',
    });
    expect(chatCwd).toBe(seat.cwd);
    expect(seen[0]!.stdinSubmit).toBe(true);
    expect(seen[0]!.prompt).toContain('执行唤醒监听，动作游标=0');
    expect(seen[0]!.args.join('\n')).not.toContain('执行唤醒监听');
    expect(seen[0]!.args).toContain('--approve-mcps');
    expect(seen[0]!.args).not.toContain('--yolo');
    expect(writes).toEqual([]);
  });
});
