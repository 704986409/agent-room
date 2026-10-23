import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireDaemonLock, processAlive } from './src/instanceLock.js';

describe('daemon instance lock', () => {
  it('treats this process as alive and a exited pid as dead', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(0)).toBe(false);
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(exited.status).toBe(0);
    expect(processAlive(exited.pid!)).toBe(false);
  });

  it('refuses a live owner without creating daemon.json, and takes over a dead one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'Agent Room lock '));
    const lockPath = join(directory, 'daemon.lock');
    const statePath = join(directory, 'daemon.json');
    await writeFile(lockPath, '424242\n');

    const blocked = await acquireDaemonLock(directory, () => true);
    expect(blocked).toBeUndefined();
    expect(await readFile(lockPath, 'utf8')).toBe('424242\n');
    expect(await readdir(directory)).toEqual(['daemon.lock']);
    await expect(readFile(statePath, 'utf8')).rejects.toThrow();

    const taken = await acquireDaemonLock(directory, () => false);
    expect(taken).toBeDefined();
    expect(await readFile(lockPath, 'utf8')).toBe(`${process.pid}\n`);
    expect(await readdir(directory)).toEqual(['daemon.lock']);

    await writeFile(lockPath, '7\n');
    await taken!.release();
    expect(await readdir(directory)).toEqual(['daemon.lock']);
    expect(await readFile(lockPath, 'utf8')).toBe('7\n');
  });

  it('releases only its own lock, including a path that contains spaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'Agent Room lock '));
    const held = await acquireDaemonLock(directory, () => true);
    expect(await readFile(join(directory, 'daemon.lock'), 'utf8')).toBe(`${process.pid}\n`);
    await held!.release();
    expect(await readdir(directory)).toEqual([]);
  });
});
