import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface DaemonLock {
  release: () => Promise<void>;
}

/** `process.kill(pid, 0)` is the Windows-safe liveness check. EPERM means the pid exists. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readPid(path: string): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(path, 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Exclusive daemon lock. The file holds our pid. A live owner makes this
 * return undefined without writing anything else. A dead owner's file is
 * removed and taken over. Release unlinks only when the file still has our pid.
 */
export async function acquireDaemonLock(
  directory: string,
  alive: (pid: number) => boolean = processAlive,
): Promise<DaemonLock | undefined> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'daemon.lock');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          const current = Number(readFileSync(path, 'utf8').trim());
          if (current === process.pid) unlinkSync(path);
        } catch { /* already gone */ }
      };
      process.once('exit', release);
      return { release: async () => { release(); } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readPid(path);
      if (owner === process.pid) return { release: async () => undefined };
      if (owner !== undefined && alive(owner)) return undefined;
      // Empty file: the owner may still be writing the pid. One retry, then take it.
      if (owner === undefined && attempt === 0) continue;
      await rm(path, { force: true });
    }
  }
  return undefined;
}
