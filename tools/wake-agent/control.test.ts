import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexCliAdapter, type ProcessSpawner } from './src/adapter.js';
import { startControlServer } from './src/control.js';
import { MemoryCredentialStore } from './src/credstore.js';
import { MemoryRunLock, WakeDaemon } from './src/daemon.js';
import { DaemonLog } from './src/log.js';
import { installMcp, mcpStatus } from './src/mcpconfig.js';
import { SecretRegistry } from './src/redact.js';

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
      expect(body.adapters[0]).toMatchObject({ id: 'codex', version: 'codex-cli 0.162', models: ['gpt-6.1-sol', 'gpt-6-luna'] });
      expect(JSON.stringify(body)).not.toContain('control-secret-value');

      const page = await fetch(`http://127.0.0.1:${control.port}/?t=${control.token}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('绑定本机');
      expect(html).toContain('托管座位');
      expect(html).toContain('MCP 一键配置');

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
    const missing = await installMcp('codex', { home, commandExists: () => false, run: async () => { throw new Error('ran'); } });
    expect(missing).toEqual({ error: 'agent_room_mcp_not_installed', hint: 'npm i -g agent-room-mcp' });
    const failed = await installMcp('codex', {
      home,
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
});
