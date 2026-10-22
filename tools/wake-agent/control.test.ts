import { chmod, mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexCliAdapter, createAgyAdapter, createClaudeAdapter, createCursorAdapter, type LauncherAdapter, type ProcessSpawner, type VersionProbe } from './src/adapter.js';
import { adapterIdForMcp, installAdapterCli, officialInstallScript, resolveNpmInvocation } from './src/cliinstall.js';
import { startControlServer, type RunningControl } from './src/control.js';
import { MemoryCredentialStore, type CommandRunner } from './src/credstore.js';
import { MemoryRunLock, WakeDaemon } from './src/daemon.js';
import { DaemonLog } from './src/log.js';
import {
  forNodeArgv,
  hookLauncherBat,
  installMcp,
  mcpStatus,
  rewriteCursorStopHook,
  rewriteHookCommandsInToml,
  windowsHookInvocation,
} from './src/mcpconfig.js';
import { SecretRegistry } from './src/redact.js';

function tomlAssigned(toml: string, key: string): string {
  const line = toml.split('\n').find(entry => entry.startsWith(`${key} = `));
  if (!line) return '';
  const raw = line.slice(key.length + 3).trim();
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return raw;
}

function quietSpawner(): ProcessSpawner {
  return { spawn() { throw new Error('spawned'); } };
}

describe('local control server', () => {
  it('requires the token, rejects a foreign Origin, and exposes status and pair', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-control-'));
    const statePath = join(directory, 'daemon.json');
    const secrets = new SecretRegistry();
    const log = new DaemonLog(secrets);
    const credentials = new MemoryCredentialStore();
    let tokenHolder = '';
    const paired: { server: string; code: string }[] = [];
    const adapters = new Map([['codex', new CodexCliAdapter(quietSpawner(), {
      probe: async () => ({ installed: true, version: 'codex-cli 0.162', path: '/bin/codex' }),
    })]]);
    const daemon = new WakeDaemon({
      api: {
        async register() { return { roomInstanceId: 'ri', seatId: 'st', scanFrom: 0 }; },
        async poll() { return { seats: [] }; },
        async claim() { return { wakeRunId: 'wr', claims: [] }; },
        async renew() { return {}; },
        async progress() { return {}; },
      },
      adapters,
      state: { seats: [] },
      lock: new MemoryRunLock(),
      inspect: () => ({ alive: false, cmdline: '' }),
    });
    const control = await startControlServer({
      daemon,
      credentials,
      statePath,
      stateDir: directory,
      server: 'http://127.0.0.1:9',
      adapters,
      secrets,
      log,
      home: directory,
      run: async () => { throw new Error('unexpected command'); },
      getToken: async () => tokenHolder,
      setToken: value => { tokenHolder = value; },
      whoami: async () => ({ username: '杰', userId: 'u1' }),
      pairComplete: async (server, code) => {
        paired.push({ server, code });
        return { deviceId: 'dev_9', deviceCredential: 'control-secret-value' };
      },
    });
    try {
      const missing = await fetch(`http://127.0.0.1:${control.port}/api/status`);
      expect(missing.status).toBe(401);
      const foreign = await fetch(`http://127.0.0.1:${control.port}/api/status`, {
        headers: { origin: 'https://evil.example', 'x-agent-room-control': control.token },
      });
      expect(foreign.status).toBe(403);
      const status = await fetch(`http://127.0.0.1:${control.port}/api/status?t=${control.token}`);
      expect(status.status).toBe(200);
      const body = await status.json() as { paired: boolean; auth: string; seats: unknown[]; adapters: { id: string; version?: string; models: string[] }[] };
      expect(body).toMatchObject({
        paired: false,
        auth: 'unpaired',
        server: 'http://127.0.0.1:9',
        seats: [],
      });
      expect(body.adapters[0]).toMatchObject({ id: 'codex', version: 'codex-cli 0.162', models: ['default', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol'] });
      expect(JSON.stringify(body)).not.toContain('control-secret-value');

      const page = await fetch(`http://127.0.0.1:${control.port}/?t=${control.token}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('绑定本机');
      expect(html).toContain('托管座位');
      expect(html).toContain('MCP 一键配置');
      expect(html).toContain('data-adapter-install');
      expect(html).toContain('需先安装 CLI');

      const pair = await fetch(`http://127.0.0.1:${control.port}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-room-control': control.token, origin: `http://127.0.0.1:${control.port}` },
        body: JSON.stringify({ pairingCode: 'CODE-1' }),
      });
      expect(pair.status).toBe(200);
      const pairBody = await pair.text();
      expect(pairBody).not.toContain('control-secret-value');
      expect(JSON.parse(pairBody)).toEqual({ ok: true, deviceId: 'dev_9' });
      expect(paired).toEqual([{ server: 'http://127.0.0.1:9', code: 'CODE-1' }]);
      expect(tokenHolder).toBe('control-secret-value');

      secrets.add('control-secret-value');
      log.write('token control-secret-value leaked');
      const logs = await fetch(`http://127.0.0.1:${control.port}/api/logs`, {
        headers: { 'x-agent-room-control': control.token },
      });
      const logBody = await logs.text();
      expect(logBody).toContain('[redacted]');
      expect(logBody).not.toContain('control-secret-value');
      expect((await stat(join(directory, 'control.json'))).mode & 0o777).toBe(0o600);
    } finally {
      await control.close();
    }
  });
});

describe('mcp config', () => {
  it('detects local config files and lists agy without installing anything', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-mcp-'));
    await mkdir(join(home, '.codex'), { recursive: true });
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(join(home, '.codex/config.toml'), '[mcp_servers.agent-room]\ncommand = "agent-room-mcp"\n');
    await writeFile(join(home, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { 'agent-room': { command: 'agent-room-mcp' } } }));
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }));
    const calls: string[][] = [];
    const tools = await mcpStatus({
      home,
      run: async (command, args) => {
        calls.push([command, ...args]);
        return { code: 0, stdout: 'agent-room  connected\n', stderr: '' };
      },
    });
    expect(calls).toEqual([['agy', 'mcp', 'list']]);
    expect(tools.find(tool => tool.id === 'codex')?.configured).toBe(true);
    expect(tools.find(tool => tool.id === 'cursor-agent')?.configured).toBe(true);
    expect(tools.find(tool => tool.id === 'agy')?.configured).toBe(true);
    expect(tools.find(tool => tool.id === 'claude')?.configured).toBe(false);
  });

  it('backs up the target config and restores it when init fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-mcp-init-'));
    const file = join(home, '.codex/config.toml');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'original\n');
    const missing = await installMcp('codex', {
      home,
      env: {},
      commandExists: () => false,
      run: async () => { throw new Error('ran'); },
    });
    expect(missing).toEqual({
      error: 'agent_room_mcp_not_installed',
      hint: '未找到安装包内的 MCP 运行时。请重新安装 Agent Room 桌面端。',
    });
    const failed = await installMcp('codex', {
      home,
      env: {},
      commandExists: () => true,
      now: 123,
      run: async (command, args) => {
        expect([command, ...args]).toEqual(['agent-room-mcp', 'init', 'codex']);
        await writeFile(file, 'broken\n');
        return { code: 1, stdout: '', stderr: 'nope' };
      },
    });
    expect(failed).toMatchObject({ error: 'mcp_init_failed' });
    expect(await readFile(file, 'utf8')).toBe('original\n');
    expect(await readFile(`${file}.bak-123`, 'utf8')).toBe('original\n');
  });

  it('runs bundled node + mcp entry without a global agent-room-mcp', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-mcp-bundled-'));
    const nodePath = join(home, 'node');
    const mcpEntry = join(home, 'mcp', 'dist', 'index.js');
    await mkdir(dirname(mcpEntry), { recursive: true });
    await writeFile(nodePath, '');
    await writeFile(mcpEntry, '');
    const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const result = await installMcp('cursor-agent', {
      home,
      nodePath,
      mcpEntry,
      server: 'http://127.0.0.1:9',
      commandExists: () => { throw new Error('global lookup'); },
      run: async (command, args, _input, _timeout, env) => {
        calls.push({ command, args: [...args], env });
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(nodePath);
    expect(calls[0]?.args).toEqual([mcpEntry, 'init', 'cursor']);
    expect(calls[0]?.args.join(' ')).not.toContain('agent-room-mcp');
    expect(calls[0]?.env?.AGENT_ROOM_MCP_COMMAND).toBe(nodePath);
    expect(JSON.parse(calls[0]?.env?.AGENT_ROOM_MCP_ARGS ?? 'null')).toEqual([mcpEntry]);
    expect(calls[0]?.env?.HOME).toBe(home);
    expect(calls[0]?.env?.AGENT_ROOM_BASE_URL).toBe('http://127.0.0.1:9');
  });

  it('strips Win32 verbatim prefixes before they reach Node', () => {
    expect(forNodeArgv('\\\\?\\D:\\Agent Room\\node.exe')).toBe('D:\\Agent Room\\node.exe');
    expect(forNodeArgv('\\\\?\\UNC\\server\\share\\node.exe')).toBe('\\\\server\\share\\node.exe');
    expect(forNodeArgv('/usr/bin/node')).toBe('/usr/bin/node');
  });

  it('writes a space-free Windows stop-hook launcher and migrates old call commands', async () => {
    const nodePath = 'D:\\Agent Room\\resources\\node\\node.exe';
    const mcpEntry = 'D:\\Agent Room\\resources\\mcp\\dist\\index.js';
    const bat = hookLauncherBat(nodePath, mcpEntry, 'https://ai-room.pupgo.top');
    expect(bat).toContain(`"${nodePath}"`);
    expect(bat).toContain(`"${mcpEntry}" hook`);
    expect(bat).not.toContain('call ');
    expect(bat).not.toContain('.\\.agent-room');
    expect(bat).not.toContain('%~dp0');
    const spaced = windowsHookInvocation('D:\\Agent Room\\resources\\mcp\\hook.cmd');
    expect(spaced).toBe('call "D:\\Agent Room\\resources\\mcp\\hook.cmd"');
    const bare = windowsHookInvocation('C:\\ProgramData\\AgentRoom\\hook.cmd');
    expect(bare).toBe('C:\\ProgramData\\AgentRoom\\hook.cmd');
    expect(bare.includes(' ')).toBe(false);
    expect(bare.includes('call')).toBe(false);
    expect(bare.startsWith('"')).toBe(false);

    const home = await mkdtemp(join(tmpdir(), 'wake-mcp-space-'));
    const programData = join(home, 'ProgramData');
    const install = join(home, 'Agent Room', 'resources');
    const nodeFile = join(install, 'node', 'node.exe');
    const entry = join(install, 'mcp', 'dist', 'index.js');
    await mkdir(dirname(nodeFile), { recursive: true });
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(nodeFile, '');
    await writeFile(entry, '');
    const tomlPath = join(home, '.codex', 'config.toml');
    const hooksPath = join(home, '.cursor', 'hooks.json');
    await mkdir(dirname(tomlPath), { recursive: true });
    await mkdir(dirname(hooksPath), { recursive: true });
    const oldCall = 'call "D:\\Agent Room\\resources\\mcp\\hook.cmd"';
    await writeFile(tomlPath, [
      'command = \'call "D:\\Agent Room\\resources\\mcp\\hook.cmd"\'',
      'command_windows = \'call "D:\\Agent Room\\resources\\mcp\\hook.cmd"\'',
      '',
    ].join('\n'));
    await writeFile(hooksPath, JSON.stringify({
      version: 1,
      hooks: { stop: [{ command: oldCall, loop_limit: null }] },
    }));
    const result = await installMcp('codex', {
      home,
      nodePath: nodeFile,
      mcpEntry: entry,
      platform: 'win32',
      server: 'https://ai-room.pupgo.top',
      env: { ProgramData: programData },
      commandExists: () => { throw new Error('global lookup'); },
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(result).toMatchObject({ ok: true });
    const launcher = join(programData, 'AgentRoom', 'hook.cmd');
    const body = await readFile(launcher, 'utf8');
    expect(body).toContain(`"${nodeFile}"`);
    expect(body).toContain(`"${entry}" hook`);
    expect(body).toContain('AGENT_ROOM_BASE_URL=https://ai-room.pupgo.top');
    expect(body).not.toContain('.\\.agent-room');
    const rewritten = await readFile(tomlPath, 'utf8');
    expect(rewritten).not.toContain('call ');
    expect(rewritten).not.toContain('Agent Room');
    expect(rewritten).toContain('hook.cmd');
    expect(rewritten).not.toMatch(/^\s*command(?:_windows)?\s*=\s*['"]call /m);
    const commandValue = tomlAssigned(rewritten, 'command');
    const windowsValue = tomlAssigned(rewritten, 'command_windows');
    for (const value of [commandValue, windowsValue]) {
      expect(value.includes(' ')).toBe(false);
      expect(value.startsWith('"')).toBe(false);
      expect(value.includes('call')).toBe(false);
      expect(value.endsWith('hook.cmd')).toBe(true);
    }
    const hooks = JSON.parse(await readFile(hooksPath, 'utf8')) as { hooks: { stop: Array<{ command: string }> } };
    const cursorCommand = hooks.hooks.stop[0]!.command;
    expect(cursorCommand.includes(' ')).toBe(false);
    expect(cursorCommand.includes('call')).toBe(false);
    expect(cursorCommand.startsWith('"')).toBe(false);
    expect(cursorCommand.endsWith('hook.cmd') || cursorCommand.endsWith('hook.cmd'.replace(/\\/g, '/'))).toBe(true);
    expect(rewriteHookCommandsInToml('command = "other"\n', 'C:\\ProgramData\\AgentRoom\\hook.cmd')).toBe('command = "other"\n');
    expect(rewriteCursorStopHook('{"hooks":{"stop":[{"command":"echo"}]}}', bare))
      .toBe('{"hooks":{"stop":[{"command":"echo"}]}}');
  });

  it('falls back to call when every space-free hook directory is unusable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-mcp-fallback-'));
    const install = join(home, 'Agent Room', 'resources');
    const nodeFile = join(install, 'node', 'node.exe');
    const entry = join(install, 'mcp', 'dist', 'index.js');
    await mkdir(dirname(nodeFile), { recursive: true });
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(nodeFile, '');
    await writeFile(entry, '');
    const tomlPath = join(home, '.codex', 'config.toml');
    await mkdir(dirname(tomlPath), { recursive: true });
    await writeFile(tomlPath, 'command = "npx -y agent-room-mcp hook"\n');
    const warnings: string[] = [];
    const prev = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message ?? '')); };
    try {
      const result = await installMcp('codex', {
        home,
        nodePath: nodeFile,
        mcpEntry: entry,
        platform: 'win32',
        server: 'https://ai-room.pupgo.top',
        env: { ProgramData: 'D:\\Program Data', LOCALAPPDATA: 'D:\\Local Data', TEMP: 'D:\\Temp Dir' },
        commandExists: () => { throw new Error('global lookup'); },
        run: async () => ({ code: 0, stdout: '', stderr: '' }),
      });
      expect(result).toMatchObject({ ok: true });
    } finally {
      console.warn = prev;
    }
    expect(warnings.join('\n')).toContain('no space-free directory');
    const rewritten = await readFile(tomlPath, 'utf8');
    expect(rewritten).toContain('call ');
    expect(rewritten).toContain('hook.cmd');
  });
});

function adapterMap(probe: VersionProbe, ids: string[]): Map<string, LauncherAdapter> {
  const spawner = quietSpawner();
  const options = { probe };
  const factories: Record<string, () => LauncherAdapter> = {
    codex: () => new CodexCliAdapter(spawner, options),
    'cursor-agent': () => createCursorAdapter(spawner, options),
    agy: () => createAgyAdapter(spawner, options),
    claude: () => createClaudeAdapter(spawner, options),
  };
  return new Map(ids.map(id => [id, factories[id]!()]));
}

async function bootControl(input: {
  adapters: Map<string, LauncherAdapter>;
  run: CommandRunner;
  home?: string;
  env?: NodeJS.ProcessEnv;
  mcpEntry?: string;
  nodePath?: string;
}): Promise<{ control: RunningControl; directory: string }> {
  const directory = input.home ?? await mkdtemp(join(tmpdir(), 'wake-control-'));
  const secrets = new SecretRegistry();
  const log = new DaemonLog(secrets);
  const daemon = new WakeDaemon({
    api: {
      async register() { return { roomInstanceId: 'ri', seatId: 'st', scanFrom: 0 }; },
      async poll() { return { seats: [] }; },
      async claim() { return { wakeRunId: 'wr', claims: [] }; },
      async renew() { return {}; },
      async progress() { return {}; },
    },
    adapters: input.adapters,
    state: { seats: [] },
    lock: new MemoryRunLock(),
    inspect: () => ({ alive: false, cmdline: '' }),
  });
  const control = await startControlServer({
    daemon,
    credentials: new MemoryCredentialStore(),
    statePath: join(directory, 'daemon.json'),
    stateDir: directory,
    server: 'http://127.0.0.1:9',
    adapters: input.adapters,
    secrets,
    log,
    home: directory,
    run: input.run,
    env: input.env,
    mcpEntry: input.mcpEntry,
    nodePath: input.nodePath,
    getToken: async () => '',
    setToken: () => undefined,
  });
  return { control, directory };
}

function post(control: RunningControl, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${control.port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-room-control': control.token,
      origin: `http://127.0.0.1:${control.port}`,
    },
    body: JSON.stringify(body),
  });
}

describe('cli install gate', () => {
  it('refuses MCP install when the matching CLI is not installed and does not run init', async () => {
    let ran = false;
    const { control } = await bootControl({
      adapters: adapterMap(async () => ({ installed: false }), ['codex']),
      run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' }; },
    });
    try {
      const response = await post(control, '/api/mcp/install', { target: 'codex' });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string; hint: string };
      expect(body.error).toBe('cli_not_installed');
      expect(body.hint).toContain('请先在上方「本机 Agent」安装 codex CLI');
      expect(ran).toBe(false);
    } finally {
      await control.close();
    }
  });

  it('installs MCP after the matching CLI is detected', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-mcp-gate-'));
    const nodePath = join(home, 'node');
    const mcpEntry = join(home, 'mcp.js');
    await writeFile(nodePath, '');
    await writeFile(mcpEntry, '');
    const calls: string[][] = [];
    const { control } = await bootControl({
      home,
      adapters: adapterMap(async () => ({ installed: true, version: 'codex 1', path: '/bin/codex' }), ['codex']),
      mcpEntry,
      nodePath,
      run: async (command, args) => {
        calls.push([command, ...args]);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    try {
      const response = await post(control, '/api/mcp/install', { target: 'codex' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(calls).toEqual([[nodePath, mcpEntry, 'init', 'codex']]);
    } finally {
      await control.close();
    }
  });

  it('installs a known CLI, logs the recipe, and reports the new detect result', async () => {
    let installed = false;
    const calls: string[][] = [];
    const adapters = adapterMap(async () => (
      installed
        ? { installed: true, version: 'cursor-agent 1', path: '/home/me/.local/bin/agent' }
        : { installed: false }
    ), ['cursor-agent']);
    const { control } = await bootControl({
      adapters,
      run: async (command, args) => {
        calls.push([command, ...args]);
        installed = true;
        return { code: 0, stdout: 'install-stdout', stderr: '' };
      },
    });
    try {
      const response = await post(control, '/api/adapters/install', { id: 'cursor-agent' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        installed: true,
        version: 'cursor-agent 1',
        path: '/home/me/.local/bin/agent',
      });
      expect(calls).toEqual([['bash', '-lc', 'set -o pipefail; curl https://cursor.com/install -fsS | bash']]);
      const logs = await fetch(`http://127.0.0.1:${control.port}/api/logs`, {
        headers: { 'x-agent-room-control': control.token },
      });
      const text = await logs.text();
      expect(text).toContain('curl https://cursor.com/install -fsS | bash');
      expect(text).toContain('install-stdout');
    } finally {
      await control.close();
    }
  });

  it('installs codex with npm i -g @openai/codex', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-npm-'));
    const npm = join(directory, 'npm');
    await writeFile(npm, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await chmod(npm, 0o755);
    let installed = false;
    const calls: string[][] = [];
    const { control } = await bootControl({
      adapters: adapterMap(async () => (
        installed ? { installed: true, version: 'codex 1', path: '/bin/codex' } : { installed: false }
      ), ['codex']),
      env: { PATH: directory },
      run: async (command, args) => {
        calls.push([command, ...args]);
        installed = true;
        return { code: 0, stdout: 'added', stderr: '' };
      },
    });
    try {
      const response = await post(control, '/api/adapters/install', { id: 'codex' });
      expect(response.status).toBe(200);
      expect(calls).toEqual([[npm, 'i', '-g', '@openai/codex']]);
      expect(await response.json()).toMatchObject({ ok: true, installed: true, version: 'codex 1' });
    } finally {
      await control.close();
    }
  });

  it('rejects an unknown adapter id', async () => {
    let ran = false;
    const { control } = await bootControl({
      adapters: adapterMap(async () => ({ installed: false }), ['codex']),
      run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' }; },
    });
    try {
      const response = await post(control, '/api/adapters/install', { id: 'gemini' });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'unknown_adapter' });
      expect(ran).toBe(false);
    } finally {
      await control.close();
    }
  });

  it('returns the install command when the agy script fails', async () => {
    const { control } = await bootControl({
      adapters: adapterMap(async () => ({ installed: false }), ['agy']),
      run: async () => ({ code: 1, stdout: '', stderr: 'network blocked' }),
    });
    try {
      const response = await post(control, '/api/adapters/install', { id: 'agy' });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string; hint: string; ok?: boolean };
      expect(body.error).toBe('cli_install_failed');
      expect(body.ok).toBeUndefined();
      expect(body.hint).toContain('network blocked');
      expect(body.hint).toContain('curl -fsSL https://antigravity.google/cli/install.sh | bash');
    } finally {
      await control.close();
    }
  });

  it('reports a failed version probe instead of claiming the CLI installed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-probe-'));
    const npm = join(directory, 'npm');
    await writeFile(npm, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await chmod(npm, 0o755);
    const { control } = await bootControl({
      adapters: adapterMap(async () => ({ installed: false, path: 'C:\\nvm4w\\nodejs\\codex', detail: 'probe-broke' }), ['codex']),
      env: { PATH: directory },
      run: async (_command, args) => ({ code: 0, stdout: args.includes('prefix') ? '' : 'added', stderr: '' }),
    });
    try {
      const response = await post(control, '/api/adapters/install', { id: 'codex' });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string; hint: string };
      expect(body.error).toBe('cli_probe_failed');
      expect(body.hint).toContain('probe-broke');
      expect(body.hint).toContain('C:\\nvm4w\\nodejs\\codex');
      expect(body.hint).toContain('重启 Agent Room');
    } finally {
      await control.close();
    }
  });

  it('falls back to npm for claude when the official script fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wake-claude-'));
    const npm = join(directory, 'npm');
    await writeFile(npm, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await chmod(npm, 0o755);
    const calls: string[][] = [];
    let installed = false;
    const { control } = await bootControl({
      adapters: adapterMap(async () => (
        installed ? { installed: true, version: 'claude 1', path: '/bin/claude' } : { installed: false }
      ), ['claude']),
      env: { PATH: directory },
      run: async (command, args) => {
        calls.push([command, ...args]);
        if (command === 'bash') return { code: 1, stdout: '', stderr: 'script failed' };
        installed = true;
        return { code: 0, stdout: 'npm ok', stderr: '' };
      },
    });
    try {
      const response = await post(control, '/api/adapters/install', { id: 'claude' });
      expect(response.status).toBe(200);
      expect(calls[0]).toEqual(['bash', '-lc', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash']);
      expect(calls[1]).toEqual([npm, 'i', '-g', '@anthropic-ai/claude-code']);
      expect(await response.json()).toMatchObject({ ok: true, installed: true });
    } finally {
      await control.close();
    }
  });

  it('documents official install scripts and maps MCP ids onto adapters', () => {
    expect(adapterIdForMcp('codex')).toBe('codex');
    expect(adapterIdForMcp('cursor-agent')).toBe('cursor-agent');
    expect(adapterIdForMcp('agy')).toBe('agy');
    expect(adapterIdForMcp('claude')).toBe('claude');
    expect(adapterIdForMcp('cursor')).toBeUndefined();
    expect(officialInstallScript('cursor-agent', 'linux')).toBe('curl https://cursor.com/install -fsS | bash');
    expect(officialInstallScript('cursor-agent', 'darwin')).toBe('curl https://cursor.com/install -fsS | bash');
    expect(officialInstallScript('cursor-agent', 'win32')).toBe("irm 'https://cursor.com/install?win32=true' | iex");
    expect(officialInstallScript('claude', 'win32')).toBe('irm https://claude.ai/install.ps1 | iex');
    expect(officialInstallScript('agy', 'win32')).toBe('irm https://antigravity.google/cli/install.ps1 | iex');
    expect(officialInstallScript('codex', 'linux')).toBeUndefined();
  });

  it('uses powershell for the Windows cursor-agent recipe', async () => {
    const calls: string[][] = [];
    const result = await installAdapterCli('cursor-agent', {
      platform: 'win32',
      adapters: adapterMap(async () => ({ installed: true, version: 'agent 2', path: 'C:\\agent.cmd' }), ['cursor-agent']),
      run: async (command, args) => {
        calls.push([command, ...args]);
        return { code: 0, stdout: '', stderr: '' };
      },
      log: { write() {} },
    });
    expect(result).toEqual({ ok: true, installed: true, version: 'agent 2', path: 'C:\\agent.cmd' });
    expect(calls).toEqual([[
      'powershell.exe',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "$ErrorActionPreference='Stop'; irm 'https://cursor.com/install?win32=true' | iex",
    ]]);
  });

  it('resolves npm-cli.js next to a bundled node when npm is not on PATH', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-npm-cli-'));
    const nodePath = join(home, 'node');
    const cli = join(home, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await mkdir(dirname(cli), { recursive: true });
    await writeFile(nodePath, '');
    await writeFile(cli, '');
    const found = await resolveNpmInvocation({ env: { PATH: '' }, nodePath, platform: 'linux' });
    expect(found).toEqual({ command: nodePath, prefix: [cli] });
  });

  it('prefers node + npm-cli.js over PATH npm.cmd on Windows', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-npm-win-'));
    const bundled = join(home, 'Agent Room', 'node.exe');
    const nvm = join(home, 'nvm');
    const node = join(nvm, 'node.exe');
    const cli = join(nvm, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npmCmd = join(nvm, 'npm.cmd');
    await mkdir(dirname(bundled), { recursive: true });
    await mkdir(dirname(cli), { recursive: true });
    await writeFile(bundled, '');
    await writeFile(node, '');
    await writeFile(cli, '');
    await writeFile(npmCmd, '@echo off\r\n');
    await chmod(node, 0o755);
    await chmod(npmCmd, 0o755);
    const found = await resolveNpmInvocation({
      env: { PATH: nvm },
      nodePath: bundled,
      platform: 'win32',
    });
    expect(found).toEqual({ command: node, prefix: [cli] });
  });

  it('uses npm-cli.js next to nodePath before a PATH shim on Windows', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-npm-nodepath-'));
    const nodePath = join(home, 'runtime', 'node.exe');
    const cli = join(home, 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const bin = join(home, 'bin');
    const npmCmd = join(bin, 'npm.cmd');
    await mkdir(dirname(cli), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(nodePath, '');
    await writeFile(cli, '');
    await writeFile(npmCmd, '@echo off\r\n');
    await chmod(npmCmd, 0o755);
    const found = await resolveNpmInvocation({
      env: { PATH: bin },
      nodePath,
      platform: 'win32',
    });
    expect(found).toEqual({ command: nodePath, prefix: [cli] });
  });

  it('falls back to npm.cmd on Windows when npm-cli.js is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-npm-cmd-'));
    const nodePath = join(home, 'node.exe');
    const bin = join(home, 'bin');
    const npmCmd = join(bin, 'npm.cmd');
    await mkdir(bin, { recursive: true });
    await writeFile(nodePath, '');
    await writeFile(npmCmd, '@echo off\r\n');
    await chmod(npmCmd, 0o755);
    const found = await resolveNpmInvocation({
      env: { PATH: bin },
      nodePath,
      platform: 'win32',
    });
    expect(found).toEqual({ command: npmCmd, prefix: [] });
  });

  it('keeps PATH npm ahead of npm-cli.js off Windows', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-npm-posix-'));
    const nodePath = join(home, 'node');
    const cli = join(home, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const bin = join(home, 'bin');
    const npm = join(bin, 'npm');
    await mkdir(dirname(cli), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(nodePath, '');
    await writeFile(cli, '');
    await writeFile(npm, '#!/bin/sh\nexit 0\n');
    await chmod(npm, 0o755);
    const found = await resolveNpmInvocation({
      env: { PATH: bin },
      nodePath,
      platform: 'linux',
    });
    expect(found).toEqual({ command: npm, prefix: [] });
  });
});
