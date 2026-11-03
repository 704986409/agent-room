import { spawnSync } from 'node:child_process';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LauncherAdapter } from './adapter.js';
import type { CredentialStore } from './credstore.js';
import { nextWait } from './interval.js';
import { joinRoomOverMcp, leaveRoomOverMcp, type RoomJoin, type RoomLeave } from './mcpJoin.js';
import { firstRunPrompt, reuseWakePrompt, wakePrompt } from './prompt.js';
import type { SecretRegistry } from './redact.js';
import { deleteSeatStateFiles, resolveMcpShimUrl, writeSeatFiles } from './seatFiles.js';
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
  /** room_sleep handoff `at` (ms). Advances each Quiet→sleep. */
  sleptAt?: number;
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
  poll(input?: { waitMs?: number }): Promise<{ seats: WakeSeatView[]; nextPollMs?: number }>;
  claim(body: { eventIds: string[]; wakeRunId?: string }): Promise<ClaimResult>;
  renew(body: { claimIds: string[] }): Promise<unknown>;
  progress(body: { claims: { claimId: string; status: 'resume_started' | 'resume_failed' }[] }): Promise<unknown>;
  /** Drop the wake binding so room @ no longer targets this seat. Optional for tests. */
  unregister?(body: { seatId: string }): Promise<unknown>;
}

export interface RunLock {
  tryAcquire(seatId: string): boolean | Promise<boolean>;
  release(seatId: string): void | Promise<void>;
}

export interface HeartbeatProbe {
  blocks(seat: SeatRecord): boolean;
}


/** True when path is this wake-agent entry (packaged .mjs or src/index). */
export function isDaemonShimEntry(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  if (!normalized) return false;
  if (normalized.endsWith('agent-room-daemon.mjs')) return true;
  if (normalized.includes('/tools/wake-agent/') && /(^|\/)index\.(ts|js|mjs)$/.test(normalized)) return true;
  if (normalized.endsWith('/wake-agent/src/index.ts')) return true;
  return false;
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
  /** Root for rooms/<code>/<seat>/ (AGENTS.md + shared rules). Defaults to sibling of stateDir: …/rooms. */
  roomsDir?: string;
  joinRoom?: RoomJoin;
  /** Leave the room seat (MCP room_leave). Injected in production; tests may stub. */
  leaveRoom?: RoomLeave;
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
  /**
   * Write into an existing embedded PTY for seatId.
   * Return true when bytes were accepted; false when no live session
   * (caller falls back to stop+codex resume).
   */
  writeSeatStdin?: (seatId: string, data: string) => boolean;
  /**
   * Delay between typing the inject prompt and sending Enter (CR).
   * Default 250ms — must exceed Codex paste-burst Enter suppress (120ms) plus
   * Windows idle flush (60ms). Tests set 0.
   */
  injectEnterDelayMs?: number;
}

export class WakeDaemon {
  private polling = false;
  private stopped = false;
  private authBlocked = false;
  emptyStreak = 0;
  /** When set, force short poll until this epoch ms (after long-poll failures). */
  longPollFallbackUntil = 0;
  longPollHoldMs = 30_000;
  waitMs = 5_000;
  serverNextPollMs = 5_000;
  readonly polls: Promise<unknown>[] = [];
  private readonly options: WakeDaemonOptions;
  private readonly claimsBySeat = new Map<string, string[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wakeSleep: (() => void) | undefined;
  /** When each still-pending event was first seen, so a live listen can ack it. */
  private readonly pendingSeen = new Map<string, number>();
  /** Last room_sleep handoff `at` applied per seat — advances clear wakeRunId. */
  private readonly lastSleptAt = new Map<string, number>();
  /** Seats the user explicitly stopped. Polling must not spawn them again. */
  private readonly stoppedByUser = new Set<string>();
  /** While deferring for live-listen grace, poll again soon instead of busy≥5s. */
  private static readonly GRACE_BUSY_WAIT_MS = 1_000;

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
    let graceDeferred = false;
    let skipped = false;
    let failure: unknown;
    const now = Date.now();
    const useLongPoll = now >= this.longPollFallbackUntil;
    const waitMs = useLongPoll ? this.longPollHoldMs : 0;
    const startedAt = now;
    this.logLine(`[wake] poll start at=${new Date(now).toISOString()} mode=${useLongPoll ? 'long' : 'short'} waitMs=${waitMs} emptyStreak=${this.emptyStreak}`);
    const flight = this.options.api.poll(waitMs > 0 ? { waitMs } : undefined)
      .then(result => result, error => { failure = error; throw error; });
    this.polls.push(flight);
    try {
      const result = await flight;
      const elapsed = Date.now() - startedAt;
      const pendingCount = result.seats.reduce((n, seat) => n + (seat.pending?.length ?? 0) + (seat.inFlight?.length ?? 0), 0);
      this.logLine(`[wake] poll ok mode=${useLongPoll ? 'long' : 'short'} elapsedMs=${elapsed} seats=${result.seats.length} work=${pendingCount} nextPollMs=${result.nextPollMs ?? 'none'}`);
      if (useLongPoll) this.longPollFallbackUntil = 0;
      this.serverNextPollMs = result.nextPollMs ?? (useLongPoll ? 0 : 5_000);
      for (const remote of result.seats) {
        const seat = this.options.state.seats.find(item => item.seatId === remote.seatId);
        if (!seat) continue;
        // Per-seat isolation: one seat's renew/inject/resume failure must not
        // abort the loop (that skipped every later seat's wake and mis-marked
        // the whole poll as a network error).
        try {
        if (remote.status === 'revoked') {
          this.markRevoked(seat, `seat ${seat.seatId} revoked`);
          continue;
        }
        if (this.stoppedByUser.has(seat.seatId)) continue;
        if (remote.status !== 'active') continue;
        this.noticeSleep(seat, remote);
        const claimIds = remote.inFlight.map(event => event.claimId).filter((id): id is string => !!id);
        if (claimIds.length) await this.options.api.renew({ claimIds });
        if (remote.pending.length || remote.inFlight.length) busy = true;
        if (this.options.heartbeat?.blocks(seat)) continue;
        this.observeProcess(seat);
        if (!remote.pending.length && !remote.inFlight.length) continue;
        // A claimed run may still be inside a live listen (or mid-turn).
        // - inFlight only: renew + wait for managed_listen ACK. Do NOT kill —
        //   force-resume on WAITING_ACK age tore down healthy room_listen
        //   ("监听直接被移除") on 0.1.26.
        // - new pending within grace: merge into the live run so @ reaches the
        //   hold without replacing the process.
        // - new pending past grace: fail stale claims and stop+resume so a
        //   cold / mid-turn CLI that never acks still gets the wake prompt.
        let view = remote;
        if (seat.status === 'running' && seat.wakeRunId && remote.inFlight.length) {
          if (!remote.pending.length) continue;
          if (this.deferForLiveListen(seat, remote)) {
            graceDeferred = true;
            await this.merge(seat, remote);
            continue;
          }
          await this.failStaleInFlight(seat, remote);
          view = {
            ...remote,
            pending: [
              ...remote.pending,
              ...remote.inFlight.map(event => ({ eventId: event.eventId })),
            ],
            inFlight: [],
          };
        }
        if (!view.pending.length) continue;
        if (this.deferForLiveListen(seat, view)) {
          graceDeferred = true;
          continue;
        }
        // Prefer injecting a short wake into the still-alive PTY so the rail
        // does not flash "进程已退出" / blank. Only rebuild when truly dead
        // or the PTY write hook is missing / refuses.
        if (await this.tryInjectWake(seat, view)) continue;
        if (seat.pid && this.options.inspect(seat.pid).alive) await this.stopLiveProcess(seat);
        await this.resumeSeat(seat, view);
        } catch (error) {
          // Auth/pairing failures are daemon-wide: let the outer handler see them.
          if (statusOf(error) === 401 || messageOf(error) === 'unpaired') { failure = error; throw error; }
          busy = true;
          this.logLine(`[wake] seat error seatId=${seat.seatId} reason=${messageOf(error) || 'unknown'}`);
        }
      }
    } catch {
      if (messageOf(failure) === 'unpaired') skipped = true;
      else {
        networkError = true;
        const status = statusOf(failure);
        if (status === 401) this.markUnauthorized();
        const reason = messageOf(failure) || 'unknown';
        this.logLine(`[wake] poll failed mode=${useLongPoll ? 'long' : 'short'} status=${status ?? 0} reason=${reason} elapsedMs=${Date.now() - startedAt}`);
        if (useLongPoll) {
          // Fall back to short poll + classic backoff for a few minutes.
          this.longPollFallbackUntil = Date.now() + 180_000;
          this.logLine(`[wake] long-poll fallback until=${new Date(this.longPollFallbackUntil).toISOString()} reason=${reason}`);
        }
      }
    } finally {
      this.polling = false;
      if (!skipped) {
        if (!networkError && useLongPoll && !busy) {
          // Server already held ~30s; re-enter immediately.
          this.emptyStreak = 0;
          this.waitMs = Math.max(0, this.serverNextPollMs || 0);
          this.logLine(`[wake] long-poll idle reenter waitMs=${this.waitMs}`);
        } else if (graceDeferred && !networkError) {
          // Live-listen grace: re-check soon. busy≥5s was burning 8–12s after sleep.
          this.emptyStreak = 0;
          this.waitMs = WakeDaemon.GRACE_BUSY_WAIT_MS;
          this.logLine(`[wake] next waitMs=${this.waitMs} emptyStreak=0 busy=${busy} graceDeferred=1 networkError=0`);
        } else {
          const decision = nextWait({
            emptyStreak: this.emptyStreak,
            busy,
            networkError,
            serverNextPollMs: this.serverNextPollMs,
            random: this.options.random?.() ?? 0,
          });
          this.emptyStreak = decision.emptyStreak;
          this.waitMs = decision.waitMs;
          this.logLine(`[wake] next waitMs=${this.waitMs} emptyStreak=${this.emptyStreak} busy=${busy} networkError=${networkError}`);
        }
      }
      try {
        await this.options.persist?.(this.options.state);
      } catch (error) {
        this.logLine(`[wake] persist after poll failed reason=${error instanceof Error ? error.message : String(error)}`);
      }
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
      try {
        await this.tick();
      } catch (error) {
        // Never let one bad tick (sleep/resume, network abort) end the loop.
        this.polling = false;
        this.logLine(`[wake] tick error reason=${error instanceof Error ? error.message : String(error)}`);
      }
      if (this.stopped) break;
      try { await sleep(this.waitMs); } catch { /* ignore */ }
    }
  }

  async startAgent(input: StartAgentInput): Promise<SeatRecord> {
    const adapter = this.adapter(input.adapterId);
    if (!adapter.models.includes(input.model)) throw new Error('model_not_allowed');
    this.logLine(`[host] start roomCode=${input.code} adapter=${input.adapterId}`);
    const join = this.options.joinRoom ?? joinRoomOverMcp;
    const leave = this.options.leaveRoom ?? leaveRoomOverMcp;
    let joined: Awaited<ReturnType<RoomJoin>> | undefined;
    let registered: { roomInstanceId: string; seatId: string; scanFrom: number } | undefined;
    let seatName = input.name;
    try {
      joined = await withTimeout(join({
        server: input.server, code: input.code, name: input.name, inviteCode: input.inviteCode,
      }), 20_000, 'join_timeout');
      seatName = joined.name || joined.yourName || input.name;
      this.logLine(`[host] join roomCode=${input.code} name=${seatName}`);
      registered = await withTimeout(this.options.api.register({
        code: input.code, name: seatName, seatKey: joined.seatKey, cursor: joined.cursor,
      }), 20_000, 'register_timeout');
      this.logLine(`[host] registered roomCode=${input.code} seatId=${registered.seatId}`);
      this.options.secrets?.add(joined.seatKey);
      await this.options.credentials?.set(`seat:${registered.seatId}`, joined.seatKey);
      let rulesPath: string | undefined;
      let seatDir: string | undefined;
      const roomsDir = this.roomsDir();
      if (roomsDir) {
        try {
          const written = await writeSeatFiles({
            roomsDir,
            code: input.code,
            name: seatName,
            seatId: registered.seatId,
            adapterId: input.adapterId,
            seatKey: joined.seatKey,
            mcpShimUrl: resolveMcpShimUrl(process.env),
          });
          rulesPath = written.rulesPath;
          seatDir = written.seatDir;
          this.logLine(`[host] seat files rules=${rulesPath} seatDir=${seatDir}`);
        } catch (error) {
          this.logLine(`[host] seat files failed roomCode=${input.code} seatId=${registered.seatId} reason=${messageOf(error)}`);
        }
      }
      const prompt = firstRunPrompt({
        code: input.code, name: seatName, readFrom: joined.cursor, seatKey: joined.seatKey,
        rulesPath,
      });
      this.logLine(prompt);
      // Prefer the seat folder as cwd so AGENTS.md loads from the workspace
      // (Codex Windows elevated sandbox often cannot read D:\Agent Room absolute paths
      // when cwd stays at the user home).
      const launchCwd = seatDir || input.cwd;
      const launched = await adapter.launch({
        cwd: launchCwd,
        prompt,
        model: input.model,
        env: await this.childEnv(registered.seatId, input.code, seatName, input.server, joined.seatKey, joined.cursor, {
          rulesPath, roomsDir: roomsDir ?? undefined, seatDir, adapterId: input.adapterId,
        }),
        logFile: this.logFile(registered.seatId),
      });
      this.logLine(`[host] launched roomCode=${input.code} seatId=${registered.seatId} adapter=${input.adapterId} pid=${launched.pid} cwd=${launchCwd}`);
      const seat: SeatRecord = {
        seatId: registered.seatId,
        roomInstanceId: registered.roomInstanceId,
        code: input.code,
        name: seatName,
        adapterId: input.adapterId,
        model: input.model,
        sessionId: launched.sessionId,
        cwd: launchCwd,
        pid: launched.pid,
        status: 'running',
        startedAt: new Date().toISOString(),
        seatDir,
        rulesPath,
      };
      this.options.state.seats.push(seat);
      this.stoppedByUser.delete(seat.seatId);
      this.watchExit(seat.seatId, launched.pid, launched.exited);
      await this.options.persist?.(this.options.state);
      return seat;
    } catch (error) {
      // Launch/register failed after cloud join → roll back so the room has no
      // ghost seat and no premature Hi from a half-hosted agent.
      await this.rollbackFailedHost({
        server: input.server,
        code: input.code,
        name: seatName,
        adapterId: input.adapterId,
        joined,
        registered,
        leave,
      });
      throw error;
    }
  }

  /** Best-effort cloud cleanup when join/register succeeded but launch failed. */
  private async rollbackFailedHost(input: {
    server: string;
    code: string;
    name: string;
    adapterId: string;
    joined?: { seatKey: string };
    registered?: { seatId: string };
    leave: RoomLeave;
  }): Promise<void> {
    const seatId = input.registered?.seatId;
    if (seatId) {
      try {
        await this.options.api.unregister?.({ seatId });
      } catch (error) {
        this.logLine(`[host] rollback unregister failed seatId=${seatId} reason=${messageOf(error)}`);
      }
    }
    // Only leave when join succeeded — otherwise there is no cloud seat to remove.
    if (input.joined && input.server && input.code && input.name) {
      try {
        const seatKey = input.joined.seatKey
          || (seatId ? await this.options.credentials?.get(`seat:${seatId}`) ?? '' : '');
        this.logLine(`[host] rollback leave roomCode=${input.code} name=${input.name}`);
        await input.leave({ server: input.server, code: input.code, name: input.name, seatKey });
      } catch (error) {
        this.logLine(`[host] rollback leave failed roomCode=${input.code} reason=${messageOf(error)}`);
      }
    }
    if (seatId) {
      try { await this.options.credentials?.delete(`seat:${seatId}`); } catch { /* ignore */ }
      const roomsDir = this.roomsDir();
      if (roomsDir && input.code && input.name) {
        try {
          await deleteSeatStateFiles({
            roomsDir,
            code: input.code,
            name: input.name,
            seatId,
            adapterId: input.adapterId,
          });
        } catch { /* ignore */ }
      }
      this.options.state.seats = this.options.state.seats.filter(item => item.seatId !== seatId);
    }
  }

  /**
   * End one managed seat: stop the process, unregister wake, leave the room,
   * drop the local seat record, and keep the wake loop from starting it again.
   * The PTY, when present, is killed by the control route before this runs.
   */
  async stopManagedSeat(seatId: string): Promise<boolean> {
    const seat = this.options.state.seats.find(item => item.seatId === seatId);
    if (!seat || seat.status === 'revoked') return false;
    this.logLine(`[leave] stopManagedSeat start roomCode=${seat.code} seatId=${seatId} pid=${seat.pid ?? 0}`);
    this.stoppedByUser.add(seatId);
    await this.stopLiveProcess(seat);
    try {
      await this.options.api.unregister?.({ seatId });
    } catch (error) {
      this.logLine(`[leave] unregister failed roomCode=${seat.code} seatId=${seatId} reason=${messageOf(error)}`);
      /* best-effort — room @ must not keep targeting a closed seat */
    }
    const leave = this.options.leaveRoom ?? leaveRoomOverMcp;
    const server = this.options.server ?? '';
    if (server && seat.code && seat.name) {
      try {
        const seatKey = await this.options.credentials?.get(`seat:${seatId}`) ?? '';
        this.logLine(`[leave] room_leave start roomCode=${seat.code} seatId=${seatId}`);
        await leave({ server, code: seat.code, name: seat.name, seatKey });
        this.logLine(`[leave] room_leave done roomCode=${seat.code} seatId=${seatId}`);
      } catch (error) {
        this.logLine(`[leave] room_leave failed roomCode=${seat.code} seatId=${seatId} reason=${messageOf(error)}`);
        /* room may already be ended / seat already gone */
      }
    }
    try {
      await this.options.credentials?.delete(`seat:${seatId}`);
    } catch { /* ignore */ }
    const roomsDir = this.roomsDir();
    if (roomsDir) {
      try {
        await deleteSeatStateFiles({
          roomsDir,
          code: seat.code,
          name: seat.name,
          seatId,
          adapterId: seat.adapterId,
          seatDir: seat.seatDir,
        });
        this.logLine(`[leave] deleted seat files roomCode=${seat.code} seatId=${seatId}`);
      } catch (error) {
        this.logLine(`[leave] delete seat files failed seatId=${seatId} reason=${messageOf(error)}`);
      }
    }
    this.options.state.seats = this.options.state.seats.filter(item => item.seatId !== seatId);
    this.claimsBySeat.delete(seatId);
    await this.options.persist?.(this.options.state);
    this.logLine(`[leave] stopManagedSeat done roomCode=${seat.code} seatId=${seatId}`);
    return true;
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

  private roomsDir(): string | undefined {
    // Only when the host sets roomsDir (index defaults to <install>/rooms).
    // Do not infer from arbitrary stateDir — unit tests pass temp dirs that are not
    // the install layout, and would otherwise pollute a sibling "rooms/" folder.
    return this.options.roomsDir || undefined;
  }

  private async childEnv(
    seatId: string,
    code: string,
    name: string,
    server: string,
    seatKey?: string,
    cursor?: number,
    files?: { rulesPath?: string; roomsDir?: string; seatDir?: string; adapterId?: string; mcpAlias?: string },
  ): Promise<Record<string, string>> {
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
      AGENT_ROOM_MCP_ALIAS: files?.mcpAlias?.trim() || 'agent-room',
    };
    if (files?.adapterId?.trim()) env.AGENT_ROOM_ADAPTER = files.adapterId.trim();
    // Point managed Codex at the loopback HTTP mcp-shim so seatKey is injected
    // when the model sends managed:{}. Must stay HTTP (not stdio): Codex rejects
    // url+command mixes ("url is not supported for stdio").
    if (!env.AGENT_ROOM_MCP_SHIM_URL?.trim()) {
      env.AGENT_ROOM_MCP_SHIM_URL = resolveMcpShimUrl(process.env);
    }
    if (typeof cursor === 'number' && Number.isFinite(cursor)) env.AGENT_ROOM_CURSOR = String(cursor);
    if (files?.rulesPath) env.AGENT_ROOM_RULES_FILE = files.rulesPath;
    if (files?.roomsDir) env.AGENT_ROOM_ROOMS_DIR = files.roomsDir;
    if (files?.seatDir) env.AGENT_ROOM_SEAT_DIR = files.seatDir;
    return env;
  }

  private markRevoked(seat: SeatRecord, line: string): void {
    if (seat.status === 'revoked') return;
    this.options.log?.(line);
    seat.status = 'revoked';
    seat.pid = undefined;
    seat.wakeRunId = undefined;
    void Promise.resolve().then(() => this.options.lock.release(seat.seatId)).catch(() => {});
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
    void Promise.resolve().then(() => this.options.lock.release(seat.seatId)).catch(() => {});
  }

  private watchExit(seatId: string, pid: number, exited: Promise<number>): void {
    void exited.catch(() => -1).then(code => {
      const seat = this.options.state.seats.find(item => item.seatId === seatId);
      if (!seat || seat.pid !== pid || seat.status !== 'running') return;
      const claims = this.claimsBySeat.get(seatId) ?? [];
      this.logLine(`[listen] process exit roomCode=${seat.code} seatId=${seatId} pid=${pid} code=${code} claims=${claims.length}`);
      seat.status = 'idle';
      seat.pid = undefined;
      seat.wakeRunId = undefined;
      this.claimsBySeat.delete(seatId);
      void Promise.resolve().then(() => this.options.lock.release(seatId)).catch(() => {});
      if (code !== 0 && claims.length) {
        void Promise.resolve().then(() => this.options.api.progress({ claims: claims.map(claimId => ({ claimId, status: 'resume_failed' as const })) }))
          .catch(error => this.logLine(`[wake] progress failed seatId=${seatId} reason=${error instanceof Error ? error.message : String(error)}`));
      }
      void Promise.resolve().then(() => this.options.persist?.(this.options.state)).catch(() => {});
    });
  }

  /**
   * room_sleep advances handoff `at` (poll `sleptAt`). Clear local wakeRunId so
   * the next @ skips resumeGrace — idle CLI after sleep will not ack pending.
   */
  private noticeSleep(seat: SeatRecord, remote: WakeSeatView): void {
    const sleptAt = remote.sleptAt;
    if (typeof sleptAt !== 'number' || !Number.isFinite(sleptAt) || sleptAt <= 0) return;
    const prev = this.lastSleptAt.get(seat.seatId) ?? 0;
    if (sleptAt <= prev) return;
    this.lastSleptAt.set(seat.seatId, sleptAt);
    if (!seat.wakeRunId) {
      this.logLine(`[wake] sleep noticed roomCode=${seat.code} seatId=${seat.seatId} sleptAt=${new Date(sleptAt).toISOString()} wakeRunId=none`);
      return;
    }
    const cleared = seat.wakeRunId;
    seat.wakeRunId = undefined;
    this.claimsBySeat.delete(seat.seatId);
    this.logLine(`[wake] sleep clear wakeRunId roomCode=${seat.code} seatId=${seat.seatId} sleptAt=${new Date(sleptAt).toISOString()} was=${cleared}`);
  }

  /**
   * A process that is still inside room_listen will ack a new @ on its own.
   * Grace is only for *pending* events (new @), never for WAITING_ACK age —
   * killing on inFlight age removed a live listen. An idle prompt after
   * room_sleep will not ack pending, so noticeSleep clears wakeRunId and the
   * next @ injects without burning resumeGraceMs.
   */
  private deferForLiveListen(seat: SeatRecord, remote: WakeSeatView): boolean {
    if (seat.status !== 'running' || !seat.pid || !this.options.inspect(seat.pid).alive) return false;
    // First-run / room_sleep never claimed a wake run — the idle CLI will not
    // ack cloud @ on its own. Skip grace and resume immediately.
    if (!seat.wakeRunId) return false;
    const grace = this.options.resumeGraceMs ?? 8_000;
    if (grace <= 0) return false;
    const now = this.options.now?.() ?? Date.now();
    let mature = false;
    for (const event of remote.pending) {
      let seen = this.pendingSeen.get(event.eventId);
      if (seen === undefined) {
        seen = now;
        this.pendingSeen.set(event.eventId, now);
        this.logLine(`[wake] pending first-seen at=${new Date(now).toISOString()} roomCode=${seat.code} seatId=${seat.seatId} eventId=${event.eventId}`);
      }
      if (now - seen >= grace) mature = true;
    }
    if (!mature) {
      this.logLine(`[wake] defer live-listen at=${new Date(now).toISOString()} roomCode=${seat.code} seatId=${seat.seatId} wakeRunId=${seat.wakeRunId} pending=${remote.pending.length} graceMs=${grace}`);
    }
    return !mature;
  }

  /**
   * Alive session + writable PTY: claim the pending @, mark resume_started,
   * and type a short follow-up into the existing terminal. Returns true when
   * injection succeeded (caller must not kill/resume).
   */
  private async tryInjectWake(seat: SeatRecord, remote: WakeSeatView): Promise<boolean> {
    const write = this.options.writeSeatStdin;
    if (!write) return false;
    if (seat.status !== 'running' || !seat.pid || !this.options.inspect(seat.pid).alive) {
      this.logLine(`[wake] inject skip roomCode=${seat.code} seatId=${seat.seatId} reason=not_alive status=${seat.status} pid=${seat.pid ?? 'none'}`);
      return false;
    }
    if (!remote.pending.length) return false;
    if (!(await this.options.lock.tryAcquire(seat.seatId))) {
      this.logLine(`[wake] inject skip roomCode=${seat.code} seatId=${seat.seatId} reason=lock_held`);
      return false;
    }
    const eventIds = remote.pending.map(event => event.eventId);
    this.logLine(`[wake] inject claim start at=${new Date().toISOString()} roomCode=${seat.code} seatId=${seat.seatId} pid=${seat.pid} eventIds=${eventIds.join(',')}`);
    let claimed: ClaimResult;
    try {
      claimed = await this.options.api.claim({ eventIds });
    } catch (error) {
      this.logLine(`[wake] inject claim failed roomCode=${seat.code} seatId=${seat.seatId} reason=${messageOf(error)}`);
      await this.options.lock.release(seat.seatId);
      throw error;
    }
    const ok = claimed.claims.filter(claim => claim.claimId);
    this.logLine(`[wake] inject claim result roomCode=${seat.code} seatId=${seat.seatId} eventIds=${ok.map(c => c.eventId).join(',')} readFrom=${claimed.readFrom ?? 'missing'}`);
    if (!ok.length || claimed.readFrom === undefined) {
      await this.options.lock.release(seat.seatId);
      return false;
    }
    const seatKey = await this.options.credentials?.get(`seat:${seat.seatId}`) ?? '';
    if (seatKey) this.options.secrets?.add(seatKey);
    // Short human wake only — seatKey lives in AGENT_ROOM_*; 动作游标 = since.
    const prompt = reuseWakePrompt({
      code: seat.code, name: seat.name, readFrom: claimed.readFrom, seatKey,
    });
    // Codex (Windows ConPTY) classifies a fast char burst as paste and keeps an
    // Enter-suppress window (~120ms after last burst activity; idle flush ~60ms).
    // Enter inside that window becomes a newline and *extends* the window — so a
    // short delay + retry never submits. Beat it by: (1) bracketed paste for
    // Codex (clears the window via clear_after_explicit_paste), (2) wait past
    // the suppress window, (3) optional End key to clear residual state, (4)
    // one CR. Never rapid-fire Enter.
    const isCodex = seat.adapterId === 'codex';
    const textPayload = isCodex ? `\x1b[200~${prompt}\x1b[201~` : prompt;
    const injectMode = isCodex ? 'bracketed' : 'plain';
    let written = false;
    try {
      written = write(seat.seatId, textPayload);
    } catch (error) {
      this.logLine(`[wake] inject write threw roomCode=${seat.code} seatId=${seat.seatId} reason=${messageOf(error)}`);
      written = false;
    }
    if (!written) {
      this.logLine(`[wake] inject write refused roomCode=${seat.code} seatId=${seat.seatId} — falling back to stop+resume`);
      await this.options.lock.release(seat.seatId);
      return false;
    }
    const enterDelayMs = this.options.injectEnterDelayMs ?? 250;
    this.logLine(`[wake] inject text ok roomCode=${seat.code} seatId=${seat.seatId} promptChars=${prompt.length} mode=${injectMode} delayMs=${enterDelayMs}`);
    if (enterDelayMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, enterDelayMs));
    }
    // Non-char clears Codex paste-burst Enter-suppress (paste_burst.rs).
    // Skip when delay is 0 (unit tests assert a single CR write).
    if (isCodex && enterDelayMs > 0) {
      try {
        write(seat.seatId, '\x1b[F');
      } catch (error) {
        this.logLine(`[wake] inject clear threw roomCode=${seat.code} seatId=${seat.seatId} reason=${messageOf(error)}`);
      }
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(50, enterDelayMs)));
    }
    // Enter as CR — matches xterm.js default for the Return key.
    let enterOk = false;
    try {
      enterOk = write(seat.seatId, '\r');
    } catch (error) {
      this.logLine(`[wake] inject enter threw roomCode=${seat.code} seatId=${seat.seatId} reason=${messageOf(error)}`);
      enterOk = false;
    }
    if (!enterOk) {
      // Retry only after a full delay — a quick second Enter would re-open the
      // Codex suppress window if the first one landed as a newline.
      if (enterDelayMs > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, enterDelayMs));
      }
      try {
        enterOk = write(seat.seatId, '\r');
      } catch (error) {
        this.logLine(`[wake] inject enter retry threw roomCode=${seat.code} seatId=${seat.seatId} reason=${messageOf(error)}`);
        enterOk = false;
      }
    }
    this.logLine(`[wake] inject enter ${enterOk ? 'ok' : 'failed'} roomCode=${seat.code} seatId=${seat.seatId} mode=${injectMode}`);
    try {
      await this.options.api.progress({ claims: ok.map(claim => ({ claimId: claim.claimId!, status: 'resume_started' as const })) });
    } catch (error) {
      this.logLine(`[wake] inject progress failed roomCode=${seat.code} seatId=${seat.seatId} reason=${messageOf(error)}`);
    }
    seat.wakeRunId = claimed.wakeRunId;
    this.claimsBySeat.set(seat.seatId, ok.map(claim => claim.claimId!));
    // Release immediately: the same PTY stays up across Quiet→sleep and later
    // @. Holding the lock (resumeSeat style) would force the next wake down the
    // stop+resume path and blank the rail again.
    await this.options.lock.release(seat.seatId);
    this.logLine(`[wake] inject ok at=${new Date().toISOString()} roomCode=${seat.code} seatId=${seat.seatId} pid=${seat.pid} wakeRunId=${claimed.wakeRunId} promptChars=${prompt.length} enter=${enterOk ? '1' : '0'}`);
    this.logLine(prompt);
    // Text reached the PTY; even if Enter failed we must not stop+resume (would
    // blank the rail and duplicate the prompt). Operator can press Enter once.
    return true;
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
    if (!seat.sessionId || !seat.model) {
      this.logLine(`[wake] resume unavailable roomCode=${seat.code} seatId=${seat.seatId} session=${Boolean(seat.sessionId)} model=${Boolean(seat.model)}`);
      return;
    }
    if (!(await this.options.lock.tryAcquire(seat.seatId))) return;
    const eventIds = remote.pending.map(event => event.eventId);
    this.logLine(`[wake] claim start roomCode=${seat.code} seatId=${seat.seatId} eventIds=${eventIds.join(',')}`);
    let claimed: ClaimResult;
    try {
      claimed = await this.options.api.claim({ eventIds });
    } catch (error) {
      this.logLine(`[wake] claim failed roomCode=${seat.code} seatId=${seat.seatId} reason=${messageOf(error)}`);
      await this.options.lock.release(seat.seatId);
      throw error;
    }
    const ok = claimed.claims.filter(claim => claim.claimId);
    this.logLine(`[wake] claim result roomCode=${seat.code} seatId=${seat.seatId} eventIds=${ok.map(c => c.eventId).join(',')} readFrom=${claimed.readFrom ?? 'missing'}`);
    if (!ok.length || claimed.readFrom === undefined) {
      await this.options.lock.release(seat.seatId);
      return;
    }
    const seatKey = await this.options.credentials?.get(`seat:${seat.seatId}`) ?? '';
    if (seatKey) this.options.secrets?.add(seatKey);
    const prompt = wakePrompt({
      code: seat.code, name: seat.name, readFrom: claimed.readFrom, gap: claimed.gap, seatKey,
      rulesPath: seat.rulesPath,
    });
    this.logLine(prompt);
    try {
      this.logLine(`[wake] resume start roomCode=${seat.code} seatId=${seat.seatId} adapter=${seat.adapterId} eventIds=${ok.map(c => c.eventId).join(',')}`);
      await this.options.api.progress({ claims: ok.map(claim => ({ claimId: claim.claimId!, status: 'resume_started' as const })) });
      const child = await this.adapter(seat.adapterId).resume({
        sessionId: seat.sessionId,
        cwd: seat.cwd,
        prompt,
        model: seat.model,
        env: await this.childEnv(seat.seatId, seat.code, seat.name, this.options.server ?? '', undefined, claimed.readFrom, {
          rulesPath: seat.rulesPath, roomsDir: this.roomsDir(), seatDir: seat.seatDir, adapterId: seat.adapterId,
        }),
        logFile: this.logFile(seat.seatId),
      });
      seat.pid = child.pid;
      seat.status = 'running';
      seat.wakeRunId = claimed.wakeRunId;
      this.claimsBySeat.set(seat.seatId, ok.map(claim => claim.claimId!));
      this.watchExit(seat.seatId, child.pid, child.exited);
      this.logLine(`[wake] resume launched roomCode=${seat.code} seatId=${seat.seatId} pid=${child.pid}`);
    } catch (error) {
      this.logLine(`[wake] resume failed roomCode=${seat.code} seatId=${seat.seatId} reason=${messageOf(error)}`);
      await this.options.api.progress({ claims: ok.map(claim => ({ claimId: claim.claimId!, status: 'resume_failed' as const })) });
      await this.options.lock.release(seat.seatId);
    }
  }

  /** Roll stale WAITING_ACK claims back to PENDING so the next resume can claim them. */
  private async failStaleInFlight(seat: SeatRecord, remote: WakeSeatView): Promise<void> {
    const claims = remote.inFlight
      .map(event => event.claimId)
      .filter((id): id is string => !!id)
      .map(claimId => ({ claimId, status: 'resume_failed' as const }));
    if (claims.length) await this.options.api.progress({ claims });
    seat.wakeRunId = undefined;
    this.claimsBySeat.delete(seat.seatId);
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
    this.logLine(`[wake] merge live run roomCode=${seat.code} seatId=${seat.seatId} eventIds=${remote.pending.map(e => e.eventId).join(',')}`);
    await this.options.api.claim({ eventIds: remote.pending.map(event => event.eventId), wakeRunId: seat.wakeRunId });
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), ms);
    work.then(value => {
      clearTimeout(timer);
      resolve(value);
    }, error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function stopProcessGroup(pid: number): void {
  if (process.platform === 'win32') {
    try {
      // Negative PIDs / POSIX signals do not tear down a Windows console tree.
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      return;
    } catch { /* fall through */ }
  }
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
