import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LauncherAdapter } from './adapter.js';
import { nextWait } from './interval.js';
import { launchPrompt, wakePrompt } from './prompt.js';
import { reconcileAfterRestart, type DaemonState, type ProcessInspection, type SeatRecord } from './state.js';

export interface WakeSeatView {
  seatId: string;
  code: string;
  name: string;
  status: 'active' | 'rebind_required' | 'revoked';
  pending: { eventId: string; sourceMessageIndex?: number; preview?: string }[];
  inFlight: { eventId: string; claimId?: string; state?: string }[];
  failed: { eventId: string; reason?: string }[];
}

export interface ClaimResult {
  wakeRunId: string;
  readFrom?: number;
  gap?: [number, number];
  claims: { eventId: string; claimId?: string; error?: string }[];
}

/** Daemon HTTP surface. There is no action that marks an event succeeded. */
export interface WakeApi {
  register(body: { code: string; name: string; seatKey: string; cursor: number }): Promise<{ roomInstanceId: string; seatId: string; scanFrom: number }>;
  poll(): Promise<{ seats: WakeSeatView[]; nextPollMs?: number }>;
  claim(body: { eventIds: string[]; wakeRunId?: string }): Promise<ClaimResult>;
  renew(body: { claimIds: string[] }): Promise<unknown>;
  progress(body: { claims: { claimId: string; status: 'resume_started' | 'resume_failed' }[] }): Promise<unknown>;
}

export interface RunLock {
  tryAcquire(seatId: string): boolean | Promise<boolean>;
  release(seatId: string): void | Promise<void>;
}

export interface HeartbeatProbe {
  blocks(seat: SeatRecord): boolean;
}

/** One daemon process, one lock file per seat. A second acquire fails until release. */
export class FileRunLock implements RunLock {
  constructor(private readonly directory: string) {}
  async tryAcquire(seatId: string): Promise<boolean> {
    await mkdir(this.directory, { recursive: true });
    try {
      const handle = await open(join(this.directory, `${seatId}.lock`), 'wx');
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }
  async release(seatId: string): Promise<void> {
    await rm(join(this.directory, `${seatId}.lock`), { force: true });
  }
}

export class MemoryRunLock implements RunLock {
  private readonly held = new Set<string>();
  tryAcquire(seatId: string): boolean {
    if (this.held.has(seatId)) return false;
    this.held.add(seatId);
    return true;
  }
  release(seatId: string): void { this.held.delete(seatId); }
  has(seatId: string): boolean { return this.held.has(seatId); }
}

export interface WakeDaemonOptions {
  api: WakeApi;
  adapters: ReadonlyMap<string, LauncherAdapter>;
  state: DaemonState;
  lock: RunLock;
  inspect: (pid: number) => ProcessInspection;
  heartbeat?: HeartbeatProbe;
  persist?: (state: DaemonState) => Promise<void> | void;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  env?: Record<string, string>;
  adapterCommand?: string;
}

export class WakeDaemon {
  private polling = false;
  private stopped = false;
  emptyStreak = 0;
  waitMs = 5_000;
  serverNextPollMs = 5_000;
  readonly polls: Promise<unknown>[] = [];
  private readonly options: WakeDaemonOptions;

  constructor(options: WakeDaemonOptions) {
    this.options = options;
    this.options.state = reconcileAfterRestart(options.state, options.inspect, options.adapterCommand ?? 'codex');
  }

  get seats(): readonly SeatRecord[] { return this.options.state.seats; }

  stop(): void { this.stopped = true; }

  /** One poll. A second call while the first is in flight does not issue another request. */
  async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    let networkError = false;
    let busy = false;
    const flight = this.options.api.poll().then(result => result, error => { networkError = true; throw error; });
    this.polls.push(flight);
    try {
      const result = await flight;
      this.serverNextPollMs = result.nextPollMs ?? 5_000;
      for (const remote of result.seats) {
        const seat = this.options.state.seats.find(item => item.seatId === remote.seatId);
        if (!seat) continue;
        if (remote.status !== 'active') continue;
        const claimIds = remote.inFlight.map(event => event.claimId).filter((id): id is string => !!id);
        if (claimIds.length) await this.options.api.renew({ claimIds });
        if (remote.pending.length || remote.inFlight.length) busy = true;
        if (this.options.heartbeat?.blocks(seat)) continue;
        this.observeProcess(seat);
        if (!remote.pending.length) continue;
        if (seat.status === 'running' && seat.wakeRunId) await this.merge(seat, remote);
        else if (seat.status === 'running') await this.attachRunning(seat, remote);
        else if (seat.status === 'idle') await this.resumeSeat(seat, remote);
      }
    } catch {
      networkError = true;
    } finally {
      this.polling = false;
      const decision = nextWait({
        emptyStreak: this.emptyStreak,
        busy,
        networkError,
        serverNextPollMs: this.serverNextPollMs,
        random: this.options.random?.() ?? 0,
      });
      this.emptyStreak = decision.emptyStreak;
      this.waitMs = decision.waitMs;
      await this.options.persist?.(this.options.state);
    }
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(this.waitMs);
    }
  }

  async startAgent(input: { code: string; name: string; cwd: string; adapterId: string; seatKey: string; cursor: number }): Promise<SeatRecord> {
    const adapter = this.adapter(input.adapterId);
    const prompt = launchPrompt(input.code, input.name);
    this.options.log?.(prompt);
    const launched = await adapter.launch({ cwd: input.cwd, prompt, env: this.options.env ?? {} });
    const registered = await this.options.api.register({
      code: input.code, name: input.name, seatKey: input.seatKey, cursor: input.cursor,
    });
    const seat: SeatRecord = {
      seatId: registered.seatId, code: input.code, name: input.name, adapterId: input.adapterId,
      sessionId: launched.sessionId, cwd: input.cwd, pid: launched.pid, status: 'running',
    };
    this.options.state.seats.push(seat);
    await this.options.persist?.(this.options.state);
    return seat;
  }

  private adapter(id: string): LauncherAdapter {
    const adapter = this.options.adapters.get(id);
    if (!adapter) throw new Error('launcher_unavailable');
    return adapter;
  }

  private observeProcess(seat: SeatRecord): void {
    if (seat.status !== 'running' || !seat.pid) return;
    const seen = this.options.inspect(seat.pid);
    if (seen.alive) return;
    seat.status = 'idle';
    seat.pid = undefined;
    seat.wakeRunId = undefined;
    void this.options.lock.release(seat.seatId);
  }

  private async resumeSeat(seat: SeatRecord, remote: WakeSeatView): Promise<void> {
    if (!seat.sessionId) return;
    if (!(await this.options.lock.tryAcquire(seat.seatId))) return;
    const claimed = await this.options.api.claim({ eventIds: remote.pending.map(event => event.eventId) });
    const ok = claimed.claims.filter(claim => claim.claimId);
    if (!ok.length || claimed.readFrom === undefined) {
      await this.options.lock.release(seat.seatId);
      return;
    }
    const prompt = wakePrompt({ code: seat.code, name: seat.name, readFrom: claimed.readFrom, gap: claimed.gap });
    this.options.log?.(prompt);
    try {
      await this.options.api.progress({ claims: ok.map(claim => ({ claimId: claim.claimId!, status: 'resume_started' as const })) });
      const child = await this.adapter(seat.adapterId).resume({
        sessionId: seat.sessionId, cwd: seat.cwd, prompt, env: this.options.env ?? {},
      });
      seat.pid = child.pid;
      seat.status = 'running';
      seat.wakeRunId = claimed.wakeRunId;
    } catch {
      await this.options.api.progress({ claims: ok.map(claim => ({ claimId: claim.claimId!, status: 'resume_failed' as const })) });
      await this.options.lock.release(seat.seatId);
    }
  }

  /** The seat's process is already up. Claim into one run and do not spawn another. */
  private async attachRunning(seat: SeatRecord, remote: WakeSeatView): Promise<void> {
    const claimed = await this.options.api.claim({ eventIds: remote.pending.map(event => event.eventId) });
    const ok = claimed.claims.filter(claim => claim.claimId);
    if (!ok.length) return;
    seat.wakeRunId = claimed.wakeRunId;
    await this.options.api.progress({ claims: ok.map(claim => ({ claimId: claim.claimId!, status: 'resume_started' as const })) });
  }

  private async merge(seat: SeatRecord, remote: WakeSeatView): Promise<void> {
    await this.options.api.claim({ eventIds: remote.pending.map(event => event.eventId), wakeRunId: seat.wakeRunId });
  }
}
