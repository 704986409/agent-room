import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexCliAdapter, type ProcessSpawner, type SpawnedProcess } from './src/adapter.js';
import { MemoryRunLock, WakeDaemon, type WakeApi } from './src/daemon.js';
import { nextWait } from './src/interval.js';
import { wakePrompt } from './src/prompt.js';
import { readState, reconcileAfterRestart, writeState, type DaemonState } from './src/state.js';

function spawner(chunks: string[]): ProcessSpawner & { calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  let pid = 400;
  return {
    calls,
    spawn(command, args): SpawnedProcess {
      calls.push({ command, args: [...args] });
      const output = chunks;
      return {
        pid: pid++,
        stdout: (async function* () { for (const chunk of output) yield chunk; })(),
        exited: new Promise(() => {}),
      };
    },
  };
}

function api(): WakeApi & { calls: string[]; polls: number } {
  const calls: string[] = [];
  let polls = 0;
  return {
    calls,
    get polls() { return polls; },
    async register() { calls.push('register'); return { roomInstanceId: 'ri', seatId: 'st_a', scanFrom: 3 }; },
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
    const child = spawner(['boot\n', 'thread_id: thr_9\n']);
    const adapter = new CodexCliAdapter(child);
    const directory = await mkdtemp(join(tmpdir(), 'wake-agent-'));
    const path = join(directory, 'daemon.json');
    const client = api();
    const logs: string[] = [];
    const daemon = new WakeDaemon({
      api: client,
      adapters: new Map([['codex', adapter]]),
      state: { seats: [] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: true, cmdline: 'codex exec' }),
      log: line => logs.push(line),
      persist: state => writeState(path, state),
    });
    const seat = await daemon.startAgent({
      code: 'ABC-DEF-GHJ', name: 'codex-a', cwd: '/work', adapterId: 'codex', seatKey: 'super-secret-key', cursor: 3,
    });
    expect(seat).toMatchObject({ seatId: 'st_a', sessionId: 'thr_9', pid: 400, status: 'running' });
    expect(child.calls[0]!.args.slice(0, 2)).toEqual(['exec', expect.stringContaining('room_join')]);
    expect(child.calls[0]!.args.join(' ')).not.toMatch(/dangerously|full-auto/);
    const saved = await readState(path);
    expect(saved.seats[0]).toMatchObject({ sessionId: 'thr_9' });
    expect(JSON.stringify(saved)).not.toContain('super-secret-key');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(logs.join('\n')).not.toContain('super-secret-key');
    expect(client.calls).toEqual(['register']);
  });

  it('keeps one poll loop, merges a running seat, and resumes an idle seat from readFrom', async () => {
    const child = spawner(['thread_id: thr_9']);
    const adapter = new CodexCliAdapter(child);
    const client = api();
    const logs: string[] = [];
    const daemon = new WakeDaemon({
      api: client,
      adapters: new Map([['codex', adapter]]),
      state: { seats: [{ seatId: 'st_a', code: 'ABC-DEF-GHJ', name: 'codex-a', adapterId: 'codex', sessionId: 'thr_9', cwd: '/work', status: 'idle' }] },
      lock: new MemoryRunLock(),
      inspect: pid => ({ alive: pid > 0, cmdline: 'codex exec resume thr_9' }),
      log: line => logs.push(line),
    });
    const first = daemon.tick();
    const second = daemon.tick();
    await Promise.all([first, second]);
    expect(client.polls).toBe(1);
    expect(child.calls).toHaveLength(1);
    expect(child.calls[0]!.args).toEqual(['exec', 'resume', 'thr_9', expect.any(String)]);
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
