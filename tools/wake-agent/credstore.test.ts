import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileStore,
  LinuxSecretStore,
  openCredentialStore,
  processRunner,
  resetCredentialStoreWarning,
  type CommandRunner,
} from './src/credstore.js';

describe('credential store', () => {
  it('round-trips FileStore with mode 0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-cred-'));
    const nested = join(directory, 'agent-room');
    const store = new FileStore(join(nested, 'credentials.json'));
    expect(await store.get('device:http://127.0.0.1:9')).toBeUndefined();
    await store.set('device:http://127.0.0.1:9', 'device-secret');
    await store.set('seat:st_a', 'seat-secret');
    expect(await store.get('device:http://127.0.0.1:9')).toBe('device-secret');
    await store.delete('seat:st_a');
    expect(await store.get('seat:st_a')).toBeUndefined();
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });

  it('stores through secret-tool with the secret on stdin', async () => {
    const calls: { args: string[]; input?: string }[] = [];
    let saved = '';
    const run: CommandRunner = async (_command, args, input) => {
      calls.push({ args: [...args], input });
      if (args[0] === 'store') saved = input ?? '';
      if (args[0] === 'lookup') return { code: saved ? 0 : 1, stdout: saved ? `${saved}\n` : '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const store = new LinuxSecretStore(run);
    await store.set('device:http://127.0.0.1:9', 's3cret-value');
    expect(calls[0]).toEqual({
      args: ['store', '--label', 'Agent Room device:http://127.0.0.1:9', 'service', 'agent-room', 'key', 'device:http://127.0.0.1:9'],
      input: 's3cret-value',
    });
    expect(await store.get('device:http://127.0.0.1:9')).toBe('s3cret-value');
    await store.delete('device:http://127.0.0.1:9');
    expect(calls.at(-1)?.args[0]).toBe('clear');
  });

  it('falls back to a 0600 file and warns once when the secret service is unavailable', async () => {
    resetCredentialStoreWarning();
    const directory = await mkdtemp(join(tmpdir(), 'wake-cred-fallback-'));
    const logs: string[] = [];
    const path = join(directory, 'credentials.json');
    const store = await openCredentialStore({
      dir: directory,
      commandExists: () => false,
      log: line => logs.push(line),
    });
    expect(logs).toEqual([`secret service unavailable; credentials stored in 0600 file ${path}`]);
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await openCredentialStore({ dir: directory, commandExists: () => false, log: line => logs.push(line) });
    expect(logs).toHaveLength(1);
  });

  it('pipes stdin through to the child and returns stdout', async () => {
    const result = await processRunner()(
      process.execPath,
      ['-e', 'let s=""; process.stdin.on("data", c => { s += c; }); process.stdin.on("end", () => process.stdout.write(s));'],
      'secret-value',
      5_000,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('secret-value');
    expect(result.stderr).toBe('');
  });
});
