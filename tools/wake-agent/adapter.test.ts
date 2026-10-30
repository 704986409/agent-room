import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CodexCliAdapter,
  createAgyAdapter,
  createClaudeAdapter,
  createCursorAdapter,
  commandCandidates,
  isWindowsAppsPath,
  openAiCodexExeCandidates,
  detectCli,
  newestAgyConversationId,
  newestCodexSessionId,
  nodeSpawner,
  probeVersion,
  resolveCommand,
  CODEX_MANAGED_MCP_APPROVAL,
  CODEX_SUPPRESS_UNSTABLE_FEATURES_WARNING,
  managedApprovalArgs,
  CODEX_MANAGED_MCP_NAMES,
  codexMcpApprovalArg,
  shouldDirectSpawn,
  spawnCommand,
  winCmdLine,
  wrapInTerminal,
  windowsCmdEscape,
  type ProcessSpawner,
  type SpawnedProcess,
} from './src/adapter.js';

function fake(): ProcessSpawner & { calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    spawn(command: string, args: readonly string[]): SpawnedProcess {
      calls.push({ command, args: [...args] });
      return {
        pid: 7,
        stdout: (async function* () { /* interactive: no JSON stream */ })(),
        exited: new Promise(() => {}),
      };
    },
  };
}

const opts = { cwd: '/work', env: { AGENT_ROOM_MANAGED: '1' }, prompt: 'hello room', title: 'Agent Room · test' };

describe('interactive launcher adapters', () => {
  it('builds interactive argv, resolves session ids without headless JSON, and enforces allowlists', async () => {
    const codexSpawn = fake();
    const codex = new CodexCliAdapter(codexSpawn, {
      directSpawn: true,
      waitCodexSession: async () => '11111111-1111-4111-8111-111111111111',
    });
    const launched = await codex.launch({ ...opts, model: 'gpt-6-sol' });
    expect(launched.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(codexSpawn.calls[0]!.args).toEqual(['-m', 'gpt-6-sol', '-c', CODEX_SUPPRESS_UNSTABLE_FEATURES_WARNING, ...CODEX_MANAGED_MCP_NAMES.flatMap(name => ['-c', codexMcpApprovalArg(name)]), 'hello room']);
    expect(codexSpawn.calls[0]!.args).not.toContain('exec');
    expect(codexSpawn.calls[0]!.args).not.toContain('--json');
    codexSpawn.calls.length = 0;
    await codex.resume({ ...opts, model: 'gpt-6-luna', sessionId: '11111111-1111-4111-8111-111111111111' });
    expect(codexSpawn.calls[0]!.args).toEqual(['resume', '11111111-1111-4111-8111-111111111111', '-m', 'gpt-6-luna', '-c', CODEX_SUPPRESS_UNSTABLE_FEATURES_WARNING, ...CODEX_MANAGED_MCP_NAMES.flatMap(name => ['-c', codexMcpApprovalArg(name)]), 'hello room']);
    await expect(codex.launch({ ...opts, model: 'gpt-4' })).rejects.toThrow('model_not_allowed');

    const cursorSpawn = fake();
    const cursor = createCursorAdapter(cursorSpawn, {
      directSpawn: true,
      createChat: async () => '22222222-2222-4222-8222-222222222222',
    });
    expect((await cursor.launch({ ...opts, model: 'grok-4.7-high' })).sessionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(cursorSpawn.calls[0]!.args).toEqual(['--resume', '22222222-2222-4222-8222-222222222222', '--model', 'grok-4.7-high', '--trust', '--approve-mcps', 'hello room']);
    expect(cursorSpawn.calls[0]!.args).not.toContain('-p');
    expect(cursorSpawn.calls[0]!.args).not.toContain('--force');
    expect(cursorSpawn.calls[0]!.args).not.toContain('--yolo');
    await cursor.resume({ ...opts, model: 'grok-4.7', sessionId: '22222222-2222-4222-8222-222222222222' });
    expect(cursorSpawn.calls[1]!.args).toContain('--resume');
    expect(cursorSpawn.calls[1]!.args).toContain('grok-4.7');
    await expect(cursor.launch({ ...opts, model: 'gpt-6-sol' })).rejects.toThrow('model_not_allowed');

    const agySpawn = fake();
    const agy = createAgyAdapter(agySpawn, {
      directSpawn: true,
      waitAgyConversation: async () => '33333333-3333-4333-8333-333333333333',
    });
    expect((await agy.launch({ ...opts, model: 'gemini-3.8-flash-high' })).sessionId).toBe('33333333-3333-4333-8333-333333333333');
    expect(agySpawn.calls[0]!.args).toEqual(['-i', 'hello room', '--model', 'gemini-3.8-flash-high']);
    expect(agySpawn.calls[0]!.args).not.toContain('-p');
    await agy.resume({ ...opts, model: 'gemini-3.8-flash-high', sessionId: '33333333-3333-4333-8333-333333333333' });
    expect(agySpawn.calls[1]!.args).toEqual(['-i', 'hello room', '--model', 'gemini-3.8-flash-high', '--conversation', '33333333-3333-4333-8333-333333333333']);

    const claude = createClaudeAdapter(fake(), { directSpawn: true });
    expect(claude.launchArgv('claude-opus', 'hello room')).toEqual(['--model', 'claude-opus', 'hello room']);
    expect(claude.resumeArgv('44444444-4444-4444-8444-444444444444', 'claude-opus', 'hello room')).toContain('--resume');
    await expect(claude.launch({ ...opts, model: 'claude-opus' })).rejects.toThrow('model_not_allowed');
  });

  it('rejects unsafe flags before spawn', async () => {
    const spawn = fake();
    const codex = new CodexCliAdapter(spawn, {
      directSpawn: true,
      waitCodexSession: async () => 'x',
    });
    await expect(codex.launch({ ...opts, model: 'gpt-6-sol', prompt: '--yolo' })).rejects.toThrow('launcher_unavailable');
    await expect(codex.launch({ ...opts, model: 'gpt-6-sol', prompt: '--force' })).rejects.toThrow('launcher_unavailable');
    await expect(codex.launch({ ...opts, model: 'gpt-6-sol', prompt: '--dangerously-skip-permissions' })).rejects.toThrow('launcher_unavailable');
    await expect(codex.resume({ ...opts, model: 'gpt-6-sol', sessionId: 'thr', prompt: '--full-auto' })).rejects.toThrow('launcher_unavailable');
    expect(spawn.calls).toHaveLength(0);
  });

  it('auto-approves MCP tools only for managed seats, without yolo or full-auto', async () => {
    const approvals = [
      '-c', CODEX_SUPPRESS_UNSTABLE_FEATURES_WARNING,
      ...CODEX_MANAGED_MCP_NAMES.flatMap(name => ['-c', codexMcpApprovalArg(name)]),
    ];
    expect(managedApprovalArgs('codex')).toEqual(approvals);
    expect(approvals).toContain('-c');
    expect(approvals).toContain(CODEX_MANAGED_MCP_APPROVAL);
    expect(approvals).toContain(CODEX_SUPPRESS_UNSTABLE_FEATURES_WARNING);
    expect(approvals).toContain('mcp_servers.airoom-e2e.default_tools_approval_mode="approve"');
    expect(managedApprovalArgs('codex', { AGENT_ROOM_SERVER: 'http://127.0.0.1:3300/' })).toEqual([
      ...approvals,
      '-c', 'mcp_servers.agent-room.url="http://127.0.0.1:3300/mcp"',
      '-c', 'mcp_servers.airoom-e2e.url="http://127.0.0.1:3300/mcp"',
      '-c', 'mcp_servers.airoom.url="http://127.0.0.1:3300/mcp"',
    ]);
    expect(managedApprovalArgs('codex', { AGENT_ROOM_SERVER: 'not a url' })).toEqual(approvals);
    expect(managedApprovalArgs('cursor-agent')).toEqual(['--approve-mcps']);
    expect(CODEX_MANAGED_MCP_APPROVAL).not.toMatch(/yolo|full-auto|--force/);

    const cursorSpawn = fake();
    const cursor = createCursorAdapter(cursorSpawn, {
      directSpawn: true,
      createChat: async () => '22222222-2222-4222-8222-222222222222',
    });
    await cursor.launch({ ...opts, env: {}, model: 'grok-4.7-high' });
    expect(cursorSpawn.calls[0]!.args).toEqual(['--resume', '22222222-2222-4222-8222-222222222222', '--model', 'grok-4.7-high', '--trust', 'hello room']);
    expect(cursorSpawn.calls[0]!.args).not.toContain('--approve-mcps');
  });

  it('does not direct-spawn on win32 unless AGENT_ROOM_DIRECT_SPAWN=1', () => {
    expect(shouldDirectSpawn({}, 'win32')).toBe(false);
    expect(shouldDirectSpawn({ DISPLAY: '' }, 'win32')).toBe(false);
    expect(shouldDirectSpawn({ WAYLAND_DISPLAY: '' }, 'win32')).toBe(false);
    expect(shouldDirectSpawn({ AGENT_ROOM_DIRECT_SPAWN: '1' }, 'win32')).toBe(true);
    expect(shouldDirectSpawn({}, 'linux')).toBe(true);
    expect(shouldDirectSpawn({ DISPLAY: ':0' }, 'linux')).toBe(false);
    expect(shouldDirectSpawn({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(false);
    expect(shouldDirectSpawn({ AGENT_ROOM_DIRECT_SPAWN: '0' }, 'linux')).toBe(false);
    expect(shouldDirectSpawn({ AGENT_ROOM_DIRECT_SPAWN: '1', DISPLAY: ':0' }, 'linux')).toBe(true);
  });

  it('opens a Windows console on the launcher path and does not embed CLI args', () => {
    const launcher = 'D:\\Agent Room\\logs\\st_b5e09cd0.cmd';
    const wrapped = wrapInTerminal(launcher, ['-m', 'gpt-6-sol', 'hello\nroom'], 'Agent Room · Desk', 'win32', {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(wrapped.windowsHide).toBe(false);
    expect(wrapped.windowsVerbatimArguments).toBe(true);
    expect(wrapped.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(wrapped.args.slice(0, 3)).toEqual(['/d', '/s', '/k']);
    expect(wrapped.args[3]).toBe('""D:\\Agent Room\\logs\\st_b5e09cd0.cmd" & if not errorlevel 1 exit"');
    expect(wrapped.args[3]).not.toContain('hello');
    expect(wrapped.args[3]).not.toContain('\n');
    expect(wrapped.args.join(' ')).not.toContain('.\\.agent-room');
  });

  it('detects with --version only and resolves the command on PATH', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-bin-'));
    const bin = join(directory, 'fakecodex');
    await writeFile(bin, '#!/bin/sh\necho codex-cli 0.162\n', { mode: 0o755 });
    await chmod(bin, 0o755);
    expect(resolveCommand('fakecodex', directory)).toBe(bin);
    const detected = await probeVersion('fakecodex', 2_000, directory);
    expect(detected).toMatchObject({ installed: true, version: 'codex-cli 0.162', path: bin });

    const slow = join(directory, 'slowcodex');
    await writeFile(slow, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    await chmod(slow, 0o755);
    const timed = await probeVersion(slow, 200);
    expect(timed.installed).toBe(false);
    expect(timed.detail).toBe('timeout');

    const broken = join(directory, 'brokencodex');
    await writeFile(broken, '#!/bin/sh\necho probe-broke >&2\nexit 3\n', { mode: 0o755 });
    await chmod(broken, 0o755);
    const failed = await probeVersion(broken, 2_000);
    expect(failed.installed).toBe(false);
    expect(failed.path).toBe(broken);
    expect(failed.detail).toContain('probe-broke');
  });

  it('treats ~/.local/bin/agent as an installed cursor-agent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-agent-home-'));
    const binDir = join(home, '.local', 'bin');
    await mkdir(binDir, { recursive: true });
    const agent = join(binDir, 'agent');
    await writeFile(agent, '#!/bin/sh\necho agent 9\n', { mode: 0o755 });
    await chmod(agent, 0o755);
    const detected = await detectCli({
      id: 'cursor-agent',
      command: 'cursor-agent',
      home,
      platform: 'linux',
      pathEnv: '',
      timeoutMs: 2_000,
    });
    expect(detected).toMatchObject({ installed: true, version: 'agent 9', path: agent });
    const windows = commandCandidates('cursor-agent', 'cursor-agent', home, 'win32', {
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      APPDATA: join(home, 'AppData', 'Roaming'),
    });
    expect(windows).toContain(join(home, 'AppData', 'Local', 'cursor-agent', 'agent.cmd'));
  });

  it('finds session ids from Codex rollout files and agy conversation dbs', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-sess-'));
    const day = join(home, '.codex', 'sessions', '2026', '10', '21');
    await mkdir(day, { recursive: true });
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const file = join(day, `rollout-2026-10-21T00-00-00-${id}.jsonl`);
    await writeFile(file, '{}\n');
    expect(newestCodexSessionId(join(home, '.codex', 'sessions'), Date.now() - 60_000)).toBe(id);

    const conv = join(home, '.gemini', 'antigravity-cli', 'conversations');
    await mkdir(conv, { recursive: true });
    const cid = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    await writeFile(join(conv, `${cid}.db`), '');
    expect(newestAgyConversationId(conv, Date.now() - 60_000)).toBe(cid);
  });

  it('escapes cmd.exe arguments for Windows console spawn', () => {
    expect(windowsCmdEscape('plain')).toBe('plain');
    expect(windowsCmdEscape('a b')).toBe('"a b"');
    expect(windowsCmdEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it('spawns Windows .cmd/.bat through cmd.exe and quotes paths with spaces', () => {
    const npm = spawnCommand(
      'D:\\Agent Room\\npm.cmd',
      ['i', '-g', '@openai/codex'],
      'win32',
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    );
    expect(npm.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(npm.windowsHide).toBe(true);
    expect(npm.windowsVerbatimArguments).toBe(true);
    expect(npm.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""D:\\Agent Room\\npm.cmd" i -g @openai/codex"',
    ]);

    const prefix = spawnCommand(
      'C:\\nvm4w\\nodejs\\npm.cmd',
      ['--prefix', 'D:\\Agent Room'],
      'win32',
      {},
    );
    expect(prefix.command).toBe('cmd.exe');
    expect(prefix.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(prefix.args[3]).toBe(winCmdLine('C:\\nvm4w\\nodejs\\npm.cmd', ['--prefix', 'D:\\Agent Room']));
    expect(prefix.args[3]).toBe('"C:\\nvm4w\\nodejs\\npm.cmd --prefix "D:\\Agent Room""');

    const bat = spawnCommand('C:\\Temp\\install.BAT', ['D:\\Agent Room'], 'win32', {});
    expect(bat.command).toBe('cmd.exe');
    expect(bat.args[2]).toBe('/c');
    expect(bat.args[3]).toContain('"D:\\Agent Room"');

    const node = spawnCommand(
      'D:\\Agent Room\\node.exe',
      ['D:\\Agent Room\\node_modules\\npm\\bin\\npm-cli.js', 'i', '-g', '@openai/codex'],
      'win32',
      {},
    );
    expect(node.command).toBe('D:\\Agent Room\\node.exe');
    expect(node.args).toEqual([
      'D:\\Agent Room\\node_modules\\npm\\bin\\npm-cli.js',
      'i',
      '-g',
      '@openai/codex',
    ]);
    expect(node.windowsHide).toBe(true);
    expect(node.windowsVerbatimArguments).toBeUndefined();

    expect(spawnCommand('npm.cmd', ['i'], 'linux', {}).command).toBe('npm.cmd');
    expect(spawnCommand('C:\\nvm4w\\nodejs\\npm.cmd', ['--version'], 'win32', {}).args[3])
      .toBe('"C:\\nvm4w\\nodejs\\npm.cmd --version"');
  });

  it('wraps the CLI in a terminal emulator when DISPLAY is set', () => {
    const prev = process.env.DISPLAY;
    process.env.DISPLAY = process.env.DISPLAY || ':0';
    try {
      const wrapped = wrapInTerminal('codex', ['-m', 'gpt-6-sol', 'hi'], 'Agent Room · Desk');
      expect(wrapped.command).toMatch(/terminal|xterm/i);
      expect(wrapped.args.join(' ')).toContain('codex');
      expect(wrapped.args.join(' ')).toContain('gpt-6-sol');
    } finally {
      if (prev === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = prev;
    }
  });

  it('detaches a process group and appends stdout to a 0600 log', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-spawn-'));
    const logFile = join(directory, 'logs', 'seat.log');
    const child = nodeSpawner().spawn(process.execPath, ['-e', 'console.log("hello-from-child"); setInterval(() => {}, 1000);'], {
      cwd: directory,
      env: {},
      logFile,
    });
    try {
      expect(child.pid).toBeGreaterThan(1);
      const statText = await readFile(`/proc/${child.pid}/stat`, 'utf8');
      const fields = statText.slice(statText.lastIndexOf(')') + 1).trim().split(/\s+/);
      expect(Number(fields[2])).toBe(child.pid);
      let text = '';
      for (let attempt = 0; attempt < 50 && !text.includes('hello-from-child'); attempt += 1) {
        text = await readFile(logFile, 'utf8').catch(() => '');
        if (!text.includes('hello-from-child')) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(text).toContain('hello-from-child');
      expect((await stat(logFile)).mode & 0o777).toBe(0o600);
    } finally {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { process.kill(child.pid, 'SIGTERM'); } catch { /* already exited */ } }
    }
  });
});

describe('Windows Codex resolve preference', () => {
  it('marks Store alias paths', () => {
    expect(isWindowsAppsPath('C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\codex.cmd')).toBe(true);
    expect(isWindowsAppsPath('C:\\nvm4w\\nodejs\\codex.cmd')).toBe(false);
  });

  it('lists OpenAI desktop codex.exe under Local\\OpenAI\\Codex\\bin', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-openai-'));
    const hash = join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin', 'abc123');
    await mkdir(hash, { recursive: true });
    const exe = join(hash, 'codex.exe');
    await writeFile(exe, 'MZ');
    expect(openAiCodexExeCandidates(home, { LOCALAPPDATA: join(home, 'AppData', 'Local') })).toEqual([exe]);
    const candidates = commandCandidates('codex', 'codex', home, 'win32', {
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      APPDATA: join(home, 'AppData', 'Roaming'),
    });
    expect(candidates[0]).toBe(exe);
  });

  it('prefers ~/.local/bin over a WindowsApps PATH hit', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-store-'));
    const realDir = join(home, '.local', 'bin');
    const storeDir = join(home, 'WindowsApps');
    await mkdir(realDir, { recursive: true });
    await mkdir(storeDir, { recursive: true });
    const real = join(realDir, 'codex');
    const store = join(storeDir, 'codex');
    await writeFile(real, '#!/bin/sh\necho codex-cli 0.156.1\n', { mode: 0o755 });
    await writeFile(store, '#!/bin/sh\necho store-alias 1\n', { mode: 0o755 });
    await chmod(real, 0o755);
    await chmod(store, 0o755);
    const detected = await detectCli({
      id: 'codex',
      command: 'codex',
      home,
      platform: 'linux',
      pathEnv: storeDir,
      timeoutMs: 2_000,
    });
    expect(detected.installed).toBe(true);
    expect(detected.path).toBe(real);
    expect(detected.version).toContain('0.156.1');
    expect(isWindowsAppsPath(detected.path)).toBe(false);
  });

  it('falls back to WindowsApps when it is the only working install', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-store-only-'));
    const storeDir = join(home, 'WindowsApps');
    await mkdir(storeDir, { recursive: true });
    const store = join(storeDir, 'codex');
    await writeFile(store, '#!/bin/sh\necho store-alias 1\n', { mode: 0o755 });
    await chmod(store, 0o755);
    const detected = await detectCli({
      id: 'codex',
      command: 'codex',
      home,
      platform: 'linux',
      pathEnv: storeDir,
      timeoutMs: 2_000,
    });
    expect(detected.installed).toBe(true);
    expect(detected.path).toBe(store);
    expect(isWindowsAppsPath(detected.path)).toBe(true);
  });
});
