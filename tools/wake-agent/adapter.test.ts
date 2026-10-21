import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CodexCliAdapter,
  createAgyAdapter,
  createClaudeAdapter,
  createCursorAdapter,
  newestAgyConversationId,
  newestCodexSessionId,
  nodeSpawner,
  probeVersion,
  resolveCommand,
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
    const launched = await codex.launch({ ...opts, model: 'gpt-6.1-sol' });
    expect(launched.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(codexSpawn.calls[0]!.args).toEqual(['-m', 'gpt-6.1-sol', '--skip-git-repo-check', 'hello room']);
    expect(codexSpawn.calls[0]!.args).not.toContain('exec');
    expect(codexSpawn.calls[0]!.args).not.toContain('--json');
    codexSpawn.calls.length = 0;
    await codex.resume({ ...opts, model: 'gpt-6-luna', sessionId: '11111111-1111-4111-8111-111111111111' });
    expect(codexSpawn.calls[0]!.args).toEqual(['resume', '11111111-1111-4111-8111-111111111111', '-m', 'gpt-6-luna', '--skip-git-repo-check', 'hello room']);
    await expect(codex.launch({ ...opts, model: 'gpt-4' })).rejects.toThrow('model_not_allowed');

    const cursorSpawn = fake();
    const cursor = createCursorAdapter(cursorSpawn, {
      directSpawn: true,
      createChat: async () => '22222222-2222-4222-8222-222222222222',
    });
    expect((await cursor.launch({ ...opts, model: 'grok-4.7-high' })).sessionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(cursorSpawn.calls[0]!.args).toEqual(['--resume', '22222222-2222-4222-8222-222222222222', '--model', 'grok-4.7-high', '--trust', 'hello room']);
    expect(cursorSpawn.calls[0]!.args).not.toContain('-p');
    expect(cursorSpawn.calls[0]!.args).not.toContain('--approve-mcps');
    await cursor.resume({ ...opts, model: 'grok-4.7', sessionId: '22222222-2222-4222-8222-222222222222' });
    expect(cursorSpawn.calls[1]!.args).toContain('--resume');
    expect(cursorSpawn.calls[1]!.args).toContain('grok-4.7');
    await expect(cursor.launch({ ...opts, model: 'gpt-6.1-sol' })).rejects.toThrow('model_not_allowed');

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
    await expect(codex.launch({ ...opts, model: 'gpt-6.1-sol', prompt: '--yolo' })).rejects.toThrow('launcher_unavailable');
    await expect(codex.launch({ ...opts, model: 'gpt-6.1-sol', prompt: '--force' })).rejects.toThrow('launcher_unavailable');
    await expect(codex.launch({ ...opts, model: 'gpt-6.1-sol', prompt: '--dangerously-skip-permissions' })).rejects.toThrow('launcher_unavailable');
    await expect(codex.resume({ ...opts, model: 'gpt-6.1-sol', sessionId: 'thr', prompt: '--full-auto' })).rejects.toThrow('launcher_unavailable');
    expect(spawn.calls).toHaveLength(0);
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

  it('wraps the CLI in a terminal emulator when DISPLAY is set', () => {
    const prev = process.env.DISPLAY;
    process.env.DISPLAY = process.env.DISPLAY || ':0';
    try {
      const wrapped = wrapInTerminal('codex', ['-m', 'gpt-6.1-sol', 'hi'], 'Agent Room · Desk');
      expect(wrapped.command).toMatch(/terminal|xterm/i);
      expect(wrapped.args.join(' ')).toContain('codex');
      expect(wrapped.args.join(' ')).toContain('gpt-6.1-sol');
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
