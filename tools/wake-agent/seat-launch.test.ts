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

describe('resolveCli WindowsApps call shim', () => {
  it('unwraps a Store codex.cmd that only calls an npm codex.cmd', async () => {
    const { mkdir } = await import('node:fs/promises');
    const directory = await mkdtemp(join(tmpdir(), 'seat-launch-store-'));
    const npmDir = join(directory, 'nvm');
    const storeDir = join(directory, 'WindowsApps');
    await mkdir(npmDir, { recursive: true });
    await mkdir(join(npmDir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    await mkdir(storeDir, { recursive: true });
    const script = join(npmDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    await writeFile(script, 'export {}\n');
    const npmShim = join(npmDir, 'codex.cmd');
    await writeFile(npmShim, [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
      '',
    ].join('\r\n'));
    const storeShim = join(storeDir, 'codex.cmd');
    await writeFile(storeShim, [
      '@echo off',
      'setlocal',
      `call "${npmShim}" %*`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n'));
    const resolved = resolveCli(storeShim);
    expect(resolved.command.toLowerCase()).toMatch(/node(\.exe)?$/);
    expect(resolved.args.some(arg => /codex\.js$/i.test(arg))).toBe(true);
    expect(resolved.command.toLowerCase()).not.toMatch(/\.cmd$/);
  });
});
