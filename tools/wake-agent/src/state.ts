import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type SeatRuntime = 'idle' | 'running';

/** Local seat row. seatKey and device credentials are never stored here. */
export interface SeatRecord {
  seatId: string;
  code: string;
  name: string;
  adapterId: string;
  sessionId?: string;
  cwd: string;
  pid?: number;
  status: SeatRuntime;
  wakeRunId?: string;
}

export interface DaemonState {
  seats: SeatRecord[];
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

export interface ProcessInspection {
  alive: boolean;
  cmdline: string;
}

/** Alive processes whose command line is not this adapter are treated as PID reuse. */
export function reconcileAfterRestart(state: DaemonState, inspect: (pid: number) => ProcessInspection, adapterCommand: string): DaemonState {
  const base = adapterCommand.split('/').pop() ?? adapterCommand;
  return {
    seats: state.seats.map(seat => {
      if (seat.status !== 'running' || !seat.pid) return { ...seat, status: 'idle', pid: undefined, wakeRunId: undefined };
      const seen = inspect(seat.pid);
      const cmdline = seen.cmdline.replace(/\0/g, ' ');
      const matches = cmdline.split(/\s+/).includes(base);
      if (seen.alive && matches) return seat;
      return { ...seat, status: 'idle', pid: undefined, wakeRunId: undefined };
    }),
  };
}
