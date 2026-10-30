import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandEnvVars, resolveCli } from './src/seat-launch.mjs';

describe('expandEnvVars', () => {
  it('expands %SystemRoot% case-insensitively', () => {
    expect(expandEnvVars('%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', {
      SystemRoot: 'C:\\Windows',
    })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('leaves %~dp0 for expandDp0', () => {
    expect(expandEnvVars('"%~dp0node.exe"', { SystemRoot: 'C:\\Windows' })).toBe('"%~dp0node.exe"');
  });
});

describe('resolveCli PowerShell Cursor shim', () => {
  it('does not treat -NoProfile as the executable after expanding %SystemRoot%', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seat-launch-ps-'));
    const shim = join(directory, 'agent.cmd');
    const ps1 = join(directory, 'agent.ps1');
    await writeFile(ps1, '# stub\r\n');
    await writeFile(shim, [
      '@echo off',
      '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0agent.ps1" %*',
      '',
    ].join('\r\n'));
    const resolved = resolveCli(shim, { SystemRoot: 'C:\\Windows' });
    expect(resolved.command.toLowerCase()).toContain('powershell.exe');
    expect(resolved.command.toLowerCase()).not.toBe('-noprofile');
    expect(resolved.args[0]).toBe('-NoProfile');
    expect(resolved.args.some(arg => /agent\.ps1$/i.test(arg))).toBe(true);
  });
});
