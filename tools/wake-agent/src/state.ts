import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type SeatRuntime = 'idle' | 'running' | 'revoked';

/** Local seat row. seatKey and device credentials are never stored here. */
export interface SeatRecord {
  seatId: string;
  roomInstanceId?: string;
  code: string;
  name: string;
  adapterId: string;
  model?: string;
  sessionId?: string;
  cwd: string;
  pid?: number;
  status: SeatRuntime;
  wakeRunId?: string;
  startedAt?: string;
}

/** Paired device. The device credential lives in the credential store, not here. */
export interface DeviceRecord {
  server: string;
  deviceId: string;
  pairedAt: string;
}

export interface DaemonState {
  seats: SeatRecord[];
  device?: DeviceRecord;
}

export function emptyState(): DaemonState {
  return { seats: [] };
}

const FORBIDDEN = ['seatKey', 'deviceCredential', 'authorization', 'secret'];

export function assertStateHasNoSecrets(state: DaemonState): void {
  const raw = JSON.stringify(state);
  if (FORBIDDEN.some(key => raw.includes(`"${key}"`))) throw new Error('secret_in_state');
}

export async function readState(path: string): Promise<DaemonState> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as DaemonState;
    if (!parsed || !Array.isArray(parsed.seats)) return emptyState();
    assertStateHasNoSecrets(parsed);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
}

/**
 * Holds the next write after JSON.stringify, still inside the per-file lock.
 * Tests use this to prove an older poll cannot overwrite a seat saved later.
 */
let stateWriteBarrier: (() => Promise<void>) | undefined;

export function setStateWriteBarrier(barrier: (() => Promise<void>) | undefined): void {
  stateWriteBarrier = barrier;
}

const writeQueues = new Map<string, Promise<void>>();

/**
 * Writes are serialized per path. JSON is captured when the write runs, not
 * when it was queued, so a poll that started before startAgent cannot land
 * `{seats:[]}` after the seat row was added.
 */
export function writeState(path: string, state: DaemonState): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => writeStateBody(path, state));
  const tail = run.then(() => undefined, () => undefined);
  writeQueues.set(path, tail);
  return run.finally(() => {
    if (writeQueues.get(path) === tail) writeQueues.delete(path);
  });
}

async function writeStateBody(path: string, state: DaemonState): Promise<void> {
  assertStateHasNoSecrets(state);
  const body = JSON.stringify(state, null, 2);
  if (stateWriteBarrier) await stateWriteBarrier();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temp, body, { mode: 0o600 });
    try { await chmod(temp, 0o600); } catch { /* Windows ignores POSIX modes. */ }
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Linux /proc check. A live PID whose command line is not the adapter is reuse. */
export function inspectProcess(pid: number): ProcessInspection {
  try {
    process.kill(pid, 0);
  } catch {
    return { alive: false, cmdline: '' };
  }
  try {
    return { alive: true, cmdline: readFileSync(`/proc/${pid}/cmdline`).toString('utf8') };
  } catch {
    return { alive: true, cmdline: '' };
  }
}

export interface ProcessInspection {
  alive: boolean;
  cmdline: string;
}

function commandBasename(command: string): string {
  const base = command.split('/').pop() ?? command;
  return base || command;
}

/** True when argv contains the adapter binary name or a path ending in that name. */
export function cmdlineMatchesAdapter(cmdline: string, adapterCommand: string): boolean {
  const base = commandBasename(adapterCommand);
  const tokens = cmdline.replace(/\0/g, ' ').split(/\s+/).filter(Boolean);
  return tokens.some(token => token === base || token.endsWith(`/${base}`));
}

/**
 * Alive processes whose command line is not that seat's adapter are PID reuse.
 * `adapterCommand` is either one command for every seat or a per-adapter lookup.
 */
export function reconcileAfterRestart(
  state: DaemonState,
  inspect: (pid: number) => ProcessInspection,
  adapterCommand: string | ((adapterId: string) => string),
): DaemonState {
  const resolve = typeof adapterCommand === 'function' ? adapterCommand : () => adapterCommand;
  return {
    seats: state.seats.map(seat => {
      if (seat.status === 'revoked') return seat;
      if (seat.status !== 'running' || !seat.pid) return { ...seat, status: 'idle', pid: undefined, wakeRunId: undefined };
      const seen = inspect(seat.pid);
      if (!seen.alive) return { ...seat, status: 'idle', pid: undefined, wakeRunId: undefined };
      // Windows has no /proc. An empty command line is not proof the PID was reused.
      if (!seen.cmdline || cmdlineMatchesAdapter(seen.cmdline, resolve(seat.adapterId))) return seat;
      return { ...seat, status: 'idle', pid: undefined, wakeRunId: undefined };
    }),
  };
}
