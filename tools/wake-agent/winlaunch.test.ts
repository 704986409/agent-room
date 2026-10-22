import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CODEX_MANAGED_MCP_APPROVAL } from './src/adapter.js';
import { prepareWindowsSeatLaunch, splitPromptArg, windowsConsoleArg } from './src/winlaunch.js';

const PROMPT = '你是房间 "甲"\n1) room_listen({ code: "ABC", name: "席" })\n说 ""你好""\n第二行';

const NPM_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\codex.mjs" %*\r
`;

const CURSOR_SHIM = `@echo off\r\n"%~dp0node.exe" "%~dp0codex.mjs" %*\r\n`;

const RECORDER = `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.ARGV_OUT, JSON.stringify({
  argv: process.argv.slice(2),
  name: process.env.AGENT_ROOM_NAME ?? '',
  seatKey: process.env.AGENT_ROOM_SEAT_KEY ?? '',
}));
`;

async function deliver(kind: 'npm' | 'cursor') {
  const directory = await mkdtemp(join(tmpdir(), 'Agent Room '));
  const shim = join(directory, kind === 'npm' ? 'codex.cmd' : 'cursor-agent.cmd');
  const script = join(directory, 'codex.mjs');
  const argvOut = join(directory, 'argv.json');
  await writeFile(shim, kind === 'npm' ? NPM_SHIM : CURSOR_SHIM);
  await writeFile(script, RECORDER);
  await chmod(script, 0o755);
  const args = ['-m', 'gpt-6-luna', '-c', CODEX_MANAGED_MCP_APPROVAL, PROMPT];
  const split = splitPromptArg(args, PROMPT);
  const prepared = prepareWindowsSeatLaunch({
    directory,
    seatId: 'st_b5e09cd0',
    command: shim,
    args: split.args,
    promptIndex: split.promptIndex,
    prompt: PROMPT,
    cwd: directory,
    env: {
      AGENT_ROOM_MANAGED: '1',
      AGENT_ROOM_SEAT_KEY: 'sekret',
      AGENT_ROOM_NAME: '中文席',
      ARGV_OUT: argvOut,
    },
    nodePath: 'D:\\Agent Room\\node\\node.exe',
    title: 'Agent Room · codex',
    comspec: 'C:\\Windows\\System32\\cmd.exe',
  });
  return { directory, prepared, argvOut, shim };
}

describe('windows seat launcher', () => {
  it('quotes a launcher path that contains spaces and never puts the prompt on the cmd line', async () => {
    expect(windowsConsoleArg('D:\\Agent Room\\logs\\st_b5e09cd0.cmd'))
      .toBe('""D:\\Agent Room\\logs\\st_b5e09cd0.cmd" & if not errorlevel 1 exit"');
    const { prepared } = await deliver('npm');
    expect(prepared.launcherPath).toContain('Agent Room ');
    expect(prepared.launcherPath.endsWith('st_b5e09cd0.cmd')).toBe(true);
    expect(prepared.spawn.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(prepared.spawn.args.slice(0, 3)).toEqual(['/d', '/s', '/k']);
    expect(prepared.spawn.args[3]).toBe(windowsConsoleArg(prepared.launcherPath));
    expect(prepared.spawn.args[3]).not.toContain(PROMPT);
    expect(prepared.spawn.args[3]).not.toContain('你是');
    expect(prepared.spawn.args[3]).not.toContain('\n');
    expect(prepared.spawn.windowsHide).toBe(false);
    expect(prepared.spawn.windowsVerbatimArguments).toBe(true);

    const cmd = await readFile(prepared.launcherPath, 'utf8');
    expect(cmd.startsWith('@echo off\r\nchcp 65001>nul\r\n')).toBe(true);
    expect(cmd).toContain('title Agent Room - codex');
    expect(cmd).toContain('set "AGENT_ROOM_SEAT_KEY=sekret"');
    expect(cmd).toContain('"D:\\Agent Room\\node\\node.exe"');
    expect(cmd).not.toContain(PROMPT);
    expect(cmd).not.toContain('中文席');
    expect([...cmd].every(ch => ch.charCodeAt(0) < 128)).toBe(true);

    expect(await readFile(prepared.promptPath, 'utf8')).toBe(PROMPT);
    const spec = JSON.parse(await readFile(prepared.specPath, 'utf8')) as {
      args: string[];
      promptIndex: number;
      env: { AGENT_ROOM_NAME: string };
    };
    expect(spec.args).toEqual(['-m', 'gpt-6-luna', '-c', CODEX_MANAGED_MCP_APPROVAL]);
    expect(spec.args[3]).toBe('mcp_servers.agent-room.default_tools_approval_mode="approve"');
    expect(spec.promptIndex).toBe(4);
    expect(spec.env.AGENT_ROOM_NAME).toBe('中文席');
    expect(JSON.stringify(spec)).not.toContain('你是房间');
  });

  it('delivers a prompt with newlines, Chinese, and quotes as one argv element', async () => {
    for (const kind of ['npm', 'cursor'] as const) {
      const { prepared, argvOut } = await deliver(kind);
      const result = spawnSync(process.execPath, [prepared.scriptPath, prepared.specPath], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      const recorded = JSON.parse(await readFile(argvOut, 'utf8')) as { argv: string[]; name: string; seatKey: string };
      expect(recorded.argv).toEqual([
        '-m', 'gpt-6-luna', '-c', CODEX_MANAGED_MCP_APPROVAL, PROMPT,
      ]);
      expect(recorded.argv[4]).toBe(PROMPT);
      expect(recorded.argv[4]).toContain('\n');
      expect(recorded.argv[4]).toContain('你是房间');
      expect(recorded.argv[4]).toContain('""你好""');
      expect(recorded.name).toBe('中文席');
      expect(recorded.seatKey).toBe('sekret');
    }
  });

  it('puts an agy prompt back in the middle of argv', () => {
    const prompt = '你好\n"next"';
    const split = splitPromptArg(['-i', prompt, '--model', 'gemini-3.8-flash-high'], prompt);
    expect(split).toEqual({ args: ['-i', '--model', 'gemini-3.8-flash-high'], promptIndex: 1 });
  });
});
