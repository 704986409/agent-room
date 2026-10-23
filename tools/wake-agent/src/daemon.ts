import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LauncherAdapter } from './adapter.js';
import type { CredentialStore } from './credstore.js';
import { nextWait } from './interval.js';
import { joinRoomOverMcp, type RoomJoin } from './mcpJoin.js';
import { firstRunPrompt, wakePrompt } from './prompt.js';
import type { SecretRegistry } from './redact.js';
import { reconcileAfterRestart, type DaemonState, type ProcessInspection, type SeatRecord } from './state.js';

/**
 * Seat logs live next to daemon.log. When the state dir is already `<install>/logs`
 * (Tauri sets AGENT_ROOM_STATE_DIR there), write `st_*.log` in that folder.
 * Otherwise keep a `logs/` subdirectory. Never a relative `.\.agent-room` fragment.
 */
export function seatLogPath(stateDir: string, seatId: string): string {
  const base = stateDir.replace(/[\\/]+$/, '');
  const sep = base.includes('\\') ? '\\' : '/';
  if (/(?:^|[\\/])logs$/i.test(base)) return `${base}${sep}${seatId}.log`;
  return `${base}${sep}logs${sep}${seatId}.log`;
}

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

export interface StartAgentInput {
  server: string;
  code: string;
  inviteCode: string;
  name: string;
  adapterId: string;
  model: string;
  cwd: string;
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
  adapterCommand?: string | ((adapterId: string) => string);
  credentials?: CredentialStore;
  server?: string;
  stateDir?: string;
  joinRoom?: RoomJoin;
  secrets?: SecretRegistry;
  /** Clock for the live-listen grace. Tests pin this; production uses Date.now. */
  now?: () => number;
  /**
   * How long a still-open interactive turn may ack a new @ itself.
   * After this, the previous process is stopped so `codex resume` can take the session.
   */
  resumeGraceMs?: number;
  /** Test hook. Production signals the terminal process group. */
  stopProcess?: (pid: number) => void;
}

export class WakeDaemon {
  private polling = false;
  private stopped = false;
  private authBlocked = false;
  emptyStreak = 0;
  waitMs = 5_000;
  serverNextPollMs = 5_000;
  readonly polls: Promise<unknown>[] = [];
  private readonly options: WakeDaemonOptions;
  private readonly claimsBySeat = new Map<string, string[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wakeSleep: (() => void) | undefined;
  /** When each still-pending event was first seen, so a live listen can ack it. */
  private readonly pendingSeen = new Map<string, number>();

  constructor(options: WakeDaemonOptions) {
    this.options = options;
    const resolve = options.adapterCommand
      ?? ((adapterId: string) => options.adapters.get(adapterId)?.command ?? adapterId);
    this.options.state = reconcileAfterRestart(options.state, options.inspect, resolve);
  }

  get seats(): readonly SeatRecord[] { return this.options.state.seats; }
  get state(): DaemonState { return this.options.state; }
  get authState(): 'ok' | 'unauthorized' { return this.authBlocked ? 'unauthorized' : 'ok'; }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.wakeSleep?.();
  }

  /** Polling resumes after a successful re-pair. Seats marked revoked stay revoked. */
  resumeAfterPair(): void { this.authBlocked = false; }

  /** One poll. A second call while the first is in flight does not issue another request. */
  async tick(): Promise<void> {
    if (this.polling || this.stopped || this.authBlocked) return;
    this.polling = true;
    let networkError = false;
    let busy = false;
    let skipped = false;
    let failure: unknown;
    const flight = this.options.api.poll().then(result => result, error => { failure = error; throw error; });
    this.polls.push(flight);
    try {
      const result = await flight;
      this.serverNextPollMs = result.nextPollMs ?? 5_000;
      for (const remote of result.seats) {
        const seat = this.options.state.seats.find(item => item.seatId === remote.seatId);
        if (!seat) continue;
        if (remote.status === 'revoked') {
          this.markRevoked(seat, `seat ${seat.seatId} revoked`);
          continue;
        }
        if (remote.status !== 'active') continue;
        const claimIds = remote.inFlight.map(event => event.claimId).filter((id): id is string => !!id);
        if (claimIds.length) await this.options.api.renew({ claimIds });
        if (remote.pending.length || remote.inFlight.length) busy = true;
        if (this.options.heartbeat?.blocks(seat)) continue;
        this.observeProcess(seat);
        if (!remote.pending.length) continue;
        // A claimed run is already inside the live process. Anything else needs a
        // new wake prompt. Interactive TUIs do not exit after room_sleep, and
        // `codex resume` refuses while that process still holds the session.
        if (seat.status === 'running' && seat.wakeRunId && remote.inFlight.length) {
          await this.merge(seat, remote);
          continue;
        }
        if (this.deferForLiveListen(seat, remote)) continue;
        if (seat.pid && this.options.inspect(seat.pid).alive) await this.stopLiveProcess(seat);
        await this.resumeSeat(seat, remote);
      }
    } catch {
      if (messageOf(failure) === 'unpaired') skipped = true;
      else {
        networkError = true;
        if (statusOf(failure) === 401) this.markUnauthorized();
      }
    } finally {
      this.polling = false;
      if (!skipped) {
        const decision = nextWait({
          emptyStreak: this.emptyStreak,
          busy,
          networkError,
          serverNextPollMs: this.serverNextPollMs,
          random: this.options.random?.() ?? 0,
        });
        this.emptyStreak = decision.emptyStreak;
        this.waitMs = decision.waitMs;
      }
      await this.options.persist?.(this.options.state);
    }
  }

  /** Locks left by a previous daemon process (killed mid-run) would block resume forever. */
  async releaseStaleLocks(): Promise<void> {
    for (const seat of this.options.state.seats) {
      if (seat.status !== 'running') await this.options.lock.release(seat.seatId);
    }
  }

  async run(): Promise<void> {
    await this.releaseStaleLocks();
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>(resolve => {
      this.wakeSleep = resolve;
      this.timer = setTimeout(() => {
        this.wakeSleep = undefined;
        resolve();
      }, ms);
    }));
    while (!this.stopped) {
      await this.tick();
      if (this.stopped) break;
      await sleep(this.waitMs);
    }
  }

  async startAgent(input: StartAgentInput): Promise<SeatRecord> {
    const adapter = this.adapter(input.adapterId);
    if (!adapter.models.includes(input.model)) throw new Error('model_not_allowed');
    const join = this.options.joinRoom ?? joinRoomOverMcp;
    const joined = await join({
      server: input.server, code: input.code, name: input.name, inviteCode: input.inviteCode,
    });
    const seatName = joined.name || joined.yourName || input.name;
    const registered = await this.options.api.register({
      code: input.code, name: seatName, seatKey: joined.seatKey, cursor: joined.cursor,
    });
    this.options.secrets?.add(joined.seatKey);
    await this.options.credentials?.set(`seat:${registered.seatId}`, joined.seatKey);
    const prompt = firstRunPrompt({
      code: input.code, name: seatName, readFrom: joined.cursor, seatKey: joined.seatKey,
    });
    this.logLine(prompt);
    const launched = await adapter.launch({
      cwd: input.cwd,
      prompt,
      model: input.model,
      env: await this.childEnv(registered.seatId, input.code, seatName, input.server, joined.seatKey, joined.cursor),
      logFile: this.logFile(registered.seatId),
    });
    const seat: SeatRecord = {
      seatId: registered.seatId,
      roomInstanceId: registered.roomInstanceId,
      code: input.code,
      name: seatName,
      adapterId: input.adapterId,
      model: input.model,
      sessionId: launched.sessionId,
      cwd: input.cwd,
      pid: launched.pid,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.options.state.seats.push(seat);
    this.watchExit(seat.seatId, launched.pid, launched.exited);
    await this.options.persist?.(this.options.state);
    return seat;
  }

  private adapter(id: string): LauncherAdapter {
    const adapter = this.options.adapters.get(id);
    if (!adapter) throw new Error('launcher_unavailable');
    return adapter;
  }

  /** Prompt text contains the seatKey. Logs see the redacted copy; the child gets the original. */
  private logLine(line: string): void {
    this.options.log?.(this.options.secrets ? this.options.secrets.redact(line) : line);
  }

  private logFile(seatId: string): string | undefined {
    return this.options.stateDir ? seatLogPath(this.options.stateDir, seatId) : undefined;
  }

  private async childEnv(seatId: string, code: string, name: string, server: string, seatKey?: string, cursor?: number): Promise<Record<string, string>> {
    const stored = seatKey ?? await this.options.credentials?.get(`seat:${seatId}`) ?? '';
    if (stored) this.options.secrets?.add(stored);
    const base = server || this.options.server || '';
    const env: Record<string, string> = {
      ...(this.options.env ?? {}),
      AGENT_ROOM_MANAGED: '1',
      AGENT_ROOM_SERVER: base,
      AGENT_ROOM_BASE_URL: base,
      AGENT_ROOM_CODE: code,
      AGENT_ROOM_NAME: name,
      AGENT_ROOM_SEAT_KEY: stored,
    };
    if (typeof cursor === 'number' && Number.isFinite(cursor)) env.AGENT_ROOM_CURSOR = String(cursor);
    return env;
  }

  private markRevoked(seat: SeatRecord, line: string): void {
    if (seat.status === 'revoked') return;
    this.options.log?.(line);
    seat.status = 'revoked';
    seat.pid = undefined;
    seat.wakeRunId = undefined;
    void this.options.lock.release(seat.seatId);
  }

  private markUnauthorized(): void {
    if (this.authBlocked) return;
    this.authBlocked = true;
    this.waitMs = 5_000;
    this.options.log?.('device unauthorized; polling stopped until re-paired');
    for (const seat of this.options.state.seats) this.markRevoked(seat, `seat ${seat.seatId} revoked`);
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

  private watchExit(seatId: string, pid: number, exited: Promise<number>): void {
    void exited.then(code => {
      const seat = this.options.state.seats.find(item => item.seatId === seatId);
      if (!seat || seat.pid !== pid || seat.status !== 'running') return;
      const claims = this.claimsBySeat.get(seatId) ?? [];
      seat.status = 'idle';
      seat.pid = undefined;
      seat.wakeRunId = undefined;
      this.claimsBySeat.delete(seatId);
      void this.options.lock.release(seatId);
      if (code !== 0 && claims.length) {
        void this.options.api.progress({ claims: claims.map(claimId => ({ claimId, status: 'resume_failed' as const })) });
      }
      void this.options.persist?.(this.options.state);
    });
  }

  /**
   * A process that is still inside room_listen will ack a new @ on its own.
   * Give it one grace window before replacing it. An idle prompt after
   * room_sleep will not ack, so the next poll starts a real resume.
   */
  private deferForLiveListen(seat: SeatRecord, remote: WakeSeatView): boolean {
    if (seat.status !== 'running' || !seat.pid || !this.options.inspect(seat.pid).alive) return false;
    const grace = this.options.resumeGraceMs ?? 8_000;
    if (grace <= 0) return false;
    const now = this.options.now?.() ?? Date.now();
    let mature = false;
    for (const event of remote.pending) {
      let seen = this.pendingSeen.get(event.eventId);
      if (seen === undefined) {
        seen = now;
        this.pendingSeen.set(event.eventId, now);
      }
      if (now - seen >= grace) mature = true;
    }
    return !mature;
  }

  /** End the previous terminal so the next `codex resume` can lock the session. */
  private async stopLiveProcess(seat: SeatRecord): Promise<void> {
    const pid = seat.pid;
    const alive = !!pid && this.options.inspect(pid).alive;
    if (pid && alive) {
      const stop = this.options.stopProcess ?? stopProcessGroup;
      stop(pid);
      const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && this.options.inspect(pid).alive) await pause(50);
      if (this.options.inspect(pid).alive) stop(pid);
      await pause(300);
    }
    seat.status = 'idle';
    seat.pid = undefined;
    seat.wakeRunId = undefined;
    await this.options.lock.release(seat.seatId);
  }

  private async resumeSeat(seat: SeatRecord, remote: WakeSeatView): Promise<void> {
    if (!seat.sessionId || !seat.model) return;
    if (!(await this.options.lock.tryAcquire(seat.seatId))) return;
    const claimed = await this.options.api.claim({ eventIds: remote.pending.map(event => event.eventId) });
    const ok = claimed.claims.filter(claim => claim.claimId);
    if (!ok.length || claimed.readFrom === undefined) {
      await this.options.lock.release(seat.seatId);
      return;
    }
    const seatKey = await this.options.credentials?.get(`seat:${seat.seatId}`) ?? '';
    if (seatKey) this.options.secrets?.add(seatKey);
    const prompt = wakePrompt({
      code: seat.code, name: seat.name, readFrom: claimed.readFrom, gap: claimed.gap, seatKey,
    });
    this.logLine(prompt);
    try {
      await this.options.api.progress({ claims: ok.map(claim => ({ claimId: claim.claimId!, status: 'resume_started' as const })) });
      const child = await this.adapter(seat.adapterId).resume({
        sessionId: seat.sessionId,
        cwd: seat.cwd,
        prompt,
        model: seat.model,
        env: await this.childEnv(seat.seatId, seat.code, seat.name, this.options.server ?? '', undefined, claimed.readFrom),
        logFile: this.logFile(seat.seatId),
      });
      seat.pid = child.pid;
      seat.status = 'running';
      seat.wakeRunId = claimed.wakeRunId;
      this.claimsBySeat.set(seat.seatId, ok.map(claim => claim.claimId!));
      this.watchExit(seat.seatId, child.pid, child.exited);
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
    this.claimsBySeat.set(seat.seatId, ok.map(claim => claim.claimId!));
    await this.options.api.progress({ claims: ok.map(claim => ({ claimId: claim.claimId!, status: 'resume_started' as const })) });
  }

  private async merge(seat: SeatRecord, remote: WakeSeatView): Promise<void> {
    await this.options.api.claim({ eventIds: remote.pending.map(event => event.eventId), wakeRunId: seat.wakeRunId });
  }
}

function stopProcessGroup(pid: number): void {
  try { process.kill(-pid, 'SIGTERM'); }
  catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ } }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error && 'status' in error && typeof (error as { status: unknown }).status === 'number') {
    return (error as { status: number }).status;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}
