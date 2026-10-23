import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';

/**
 * Shared with the local MCP. Not the desktop log directory: that path may sit
 * inside an install folder that contains spaces, and a second copy of the id
 * would make the same PC look like two machines.
 */
export function machineIdPath(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir(),
): string {
  const path = platform === 'win32' ? win32 : posix;
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || env.APPDATA || path.join(home, 'AppData', 'Local');
    return path.join(base, 'agent-room', 'machine-id');
  }
  const base = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return path.join(base, 'agent-room', 'machine-id');
}

export async function readOrCreateMachineId(path = machineIdPath()): Promise<string> {
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (existing.length >= 8 && existing.length <= 128 && !/[\u0000-\u001f\u007f]/.test(existing)) return existing;
  } catch { /* create below */ }
  const id = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${id}\n`, { mode: 0o600 });
  return id;
}
