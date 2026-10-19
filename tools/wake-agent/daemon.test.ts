import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexCliAdapter, createCursorAdapter, type ProcessSpawner, type SpawnedProcess } from './src/adapter.js';
import { MemoryCredentialStore } from './src/credstore.js';
import { FileRunLock, MemoryRunLock, WakeDaemon, type WakeApi } from './src/daemon.js';
import { createHttpWakeApi, WakeHttpError } from './src/http.js';
import { nextWait } from './src/interval.js';
import { wakePrompt } from './src/prompt.js';
import { readState, reconcileAfterRestart, writeState, type DaemonState, type SeatRecord } from './src/state.js';

const THREAD = '{"type":"thread.started","thread_id":"thr_9"}\n';

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
  it('launches Codex, registers, and writes a 0600 state file without the seatKey', async () => {
    const child = spawner(['boot\n', THREAD]);
    const adapter = new CodexCliAdapter(child);
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
      inspect: () => ({ alive: true, cmdline: 'codex exec' }),
      log: line => logs.push(line),
      persist: state => writeState(path, state),
      credentials: creds,
      server: 'http://127.0.0.1:9',
      joinRoom: async () => { order.push('join'); return { seatKey: 'super-secret-key', cursor: 3, name: 'codex-a' }; },
    });
    const register = client.register.bind(client);
    client.register = async body => { order.push('register'); return register(body); };
    const inner = child.spawn.bind(child);
    child.spawn = (command, args, opts) => { order.push('launch'); return inner(command, args, opts); };
    const seat = await daemon.startAgent({
      server: 'http://127.0.0.1:9', code: 'ABC-DEF-GHJ', inviteCode: 'invite-1', name: 'codex-a',
      cwd: '/work', adapterId: 'codex', model: 'gpt-6.1-sol',
    });
    expect(order).toEqual(['join', 'register', 'launch']);
    expect(seat).toMatchObject({ seatId: 'st_a', roomInstanceId: 'ri', sessionId: 'thr_9', pid: 400, status: 'running', model: 'gpt-6.1-sol' });
    expect(seat.startedAt).toEqual(expect.any(String));
    expect(child.calls[0]!.args).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-m', 'gpt-6.1-sol', expect.stringContaining('AGENT_ROOM_SEAT_KEY'),
    ]);
    expect(child.calls[0]!.args.join(' ')).not.toMatch(/dangerously|full-auto|--yolo|--force/);
    expect(child.calls[0]!.env).toMatchObject({
      AGENT_ROOM_MANAGED: '1', AGENT_ROOM_SERVER: 'http://127.0.0.1:9', AGENT_ROOM_CODE: 'ABC-DEF-GHJ',
      AGENT_ROOM_NAME: 'codex-a', AGENT_ROOM_SEAT_KEY: 'super-secret-key',
    });
    expect(await creds.get('seat:st_a')).toBe('super-secret-key');
    expect(client.registered[0]).toMatchObject({ seatKey: 'super-secret-key', cursor: 3 });
    const saved = await readState(path);
    expect(saved.seats[0]).toMatchObject({ sessionId: 'thr_9', model: 'gpt-6.1-sol' });
    expect(JSON.stringify(saved)).not.toContain('super-secret-key');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(logs.join('\n')).not.toContain('super-secret-key');
    expect(logs.join('\n')).toContain('AGENT_ROOM_SEAT_KEY');
    expect(client.calls).toEqual(['register']);
  });

  it('keeps one poll loop, merges a running seat, and resumes an idle seat from readFrom', async () => {
    const child = spawner([THREAD]);
    const adapter = new CodexCliAdapter(child);
    const client = api();
    const logs: string[] = [];
    const daemon = new WakeDaemon({
      api: client,
      adapters: new Map([['codex', adapter]]),
      state: { seats: [{ seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', adapterId: 'codex', model: 'gpt-6.1-sol', sessionId: 'thr_9', cwd: '/work', status: 'idle' }] },
      lock: new MemoryRunLock(),
      inspect: pid => ({ alive: pid > 0, cmdline: 'codex exec resume thr_9' }),
      log: line => logs.push(line),
    });
    const first = daemon.tick();
    const second = daemon.tick();
    await Promise.all([first, second]);
    expect(client.polls).toBe(1);
    expect(child.calls).toHaveLength(1);
    expect(child.calls[0]!.args).toEqual(['exec', 'resume', 'thr_9', '--json', '--skip-git-repo-check', '-m', 'gpt-6.1-sol', expect.any(String)]);
    expect(logs[0]).toContain('since: 183');
    expect(logs[0]).toContain('第 120–182 条');
    expect(logs[0]).not.toContain('secret body');
    expect(logs[0]).not.toContain('seatKey');
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

  it('does not resume over a live user heartbeat, and takeover treats PID reuse as idle', () => {
    const state: DaemonState = { seats: [
      { seatId: 'st_a', code: 'ABC', name: 'codex-a', adapterId: 'codex', sessionId: 'thr_9', cwd: '/work', pid: 9, status: 'running', wakeRunId: 'wr' },
      { seatId: 'st_b', code: 'ABC', name: 'codex-b', adapterId: 'codex', sessionId: 'thr_2', cwd: '/work', pid: 2, status: 'running' },
    ] };
    const reconciled = reconcileAfterRestart(state, pid => pid === 9
      ? { alive: true, cmdline: 'codex\0exec' }
      : { alive: true, cmdline: 'nginx' }, 'codex');
    expect(reconciled.seats[0]).toMatchObject({ status: 'running', pid: 9 });
    expect(reconciled.seats[1]).toMatchObject({ status: 'idle', pid: undefined });
    const prompt = wakePrompt({ code: 'ABC', name: 'codex-a', readFrom: 4 });
    expect(prompt).toContain('since: 4');
    expect(prompt).not.toContain('seat-key');
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
      adapters: new Map([['codex', new CodexCliAdapter(child)]]),
      state: { seats: [{ seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', adapterId: 'codex', sessionId: 'thr_9', cwd: '/work', status: 'idle' }] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: true, cmdline: 'codex exec' }),
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
      seatId: 'st_live', code: 'ABC', name: 'codex-a', adapterId: 'codex', model: 'gpt-6.1-sol',
      sessionId: 'thr_live', cwd: '/work', pid: 11, status: 'running', ...extra,
    });
    const state: DaemonState = { seats: [
      base({ seatId: 'st_live', pid: 11, sessionId: 'thr_live', adapterId: 'codex' }),
      base({ seatId: 'st_reuse', pid: 22, sessionId: 'ses_2', adapterId: 'cursor-agent', model: 'grok-4.7', name: 'cursor-a' }),
      base({ seatId: 'st_dead', pid: 33, sessionId: 'thr_9', model: 'gpt-6.1-sol', name: 'sleeper' }),
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
        ['codex', new CodexCliAdapter(child)],
        ['cursor-agent', createCursorAdapter(child)],
      ]),
      state,
      lock: new MemoryRunLock(),
      inspect: pid => {
        if (pid === 11) return { alive: true, cmdline: '/usr/bin/codex\0exec' };
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
    expect(child.calls[0]!.args).toEqual(['exec', 'resume', 'thr_9', '--json', '--skip-git-repo-check', '-m', 'gpt-6.1-sol', expect.any(String)]);
    expect(child.calls[0]!.env.AGENT_ROOM_SEAT_KEY).toBe('seat-key-secret');
    expect(daemon.seats.find(seat => seat.seatId === 'st_dead')).toMatchObject({ status: 'running', sessionId: 'thr_9', model: 'gpt-6.1-sol' });
  });

  it('marks a remotely revoked seat, and stops polling after device 401', async () => {
    const logs: string[] = [];
    const revoked = api();
    revoked.poll = async () => ({
      seats: [{ seatId: 'st_a', code: 'ABC', name: 'codex-a', status: 'revoked' as const, pending: [], inFlight: [], failed: [] }],
    });
    const running: SeatRecord = {
      seatId: 'st_a', code: 'ABC', name: 'codex-a', adapterId: 'codex', model: 'gpt-6.1-sol',
      sessionId: 'thr_9', cwd: '/work', pid: 9, status: 'running',
    };
    const daemon = new WakeDaemon({
      api: revoked,
      adapters: new Map([['codex', new CodexCliAdapter(spawner([]))]]),
      state: { seats: [running] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: true, cmdline: 'codex exec' }),
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
      adapters: new Map([['codex', new CodexCliAdapter(spawner([]))]]),
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
});
