import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
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

export async function writeState(path: string, state: DaemonState): Promise<void> {
  assertStateHasNoSecrets(state);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
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
      if (seen.alive && cmdlineMatchesAdapter(seen.cmdline, resolve(seat.adapterId))) return seat;
      return { ...seat, status: 'idle', pid: undefined, wakeRunId: undefined };
    }),
  };
}
