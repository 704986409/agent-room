import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MemoryRedis } from './_memoryRedis.js';
import { runCreateAdmin } from './_createAdmin.js';
import { login } from './_accounts.js';

function io(argv: string[], password: string, client: MemoryRedis) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdin = Readable.from([`${password}\n`]);
  stdin.isTTY = false;
  return {
    argv,
    stdin,
    stdout: { write: (chunk: string) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: (chunk: string) => { stderr.push(String(chunk)); return true; } },
    env: {},
    client,
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
  };
}

describe('create-admin command', () => {
  it('creates the first admin from stdin and does not print the password', async () => {
    const client = new MemoryRedis();
    const password = 'stdin-secret-value';
    const first = io(['--username', 'root'], password, client);
    expect(await runCreateAdmin(first)).toBe(0);
    expect(first.stdoutText()).toContain('Created admin root.');
    expect(first.stdoutText()).not.toContain(password);
    expect(first.stderrText()).not.toContain(password);
    await expect(login(client, { username: 'root', password, ip: '127.0.0.1', ua: 'cli-test' }))
      .resolves.toMatchObject({ user: { role: 'admin', username: 'root' } });

    const secondPassword = 'another-secret-value';
    const second = io(['--username', 'other'], secondPassword, client);
    expect(await runCreateAdmin(second)).toBe(1);
    expect(second.stderrText()).toContain('without --add');
    expect(second.stdoutText() + second.stderrText()).not.toContain(secondPassword);
    expect(second.stdoutText() + second.stderrText()).not.toContain(password);

    const added = io(['--username', 'other', '--add'], secondPassword, client);
    expect(await runCreateAdmin(added)).toBe(0);
    expect(added.stdoutText()).not.toContain(secondPassword);
  });

  it('prints usage when --username is missing', async () => {
    const client = new MemoryRedis();
    const run = io([], 'unused-password-value', client);
    expect(await runCreateAdmin(run)).toBe(1);
    expect(run.stderrText()).toContain('--username');
    expect(run.stderrText()).not.toContain('unused-password-value');
  });
});
