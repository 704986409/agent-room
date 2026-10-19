import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CodexCliAdapter,
  createAgyAdapter,
  createClaudeAdapter,
  createCursorAdapter,
  nodeSpawner,
  probeVersion,
  resolveCommand,
  type ProcessSpawner,
  type SpawnedProcess,
} from './src/adapter.js';

const CODEX_LINE = '{"type":"thread.started","thread_id":"11111111-1111-4111-8111-111111111111"}';
const CURSOR_LINE = '{"type":"system","subtype":"init","model":"grok-4.7-high","session_id":"22222222-2222-4222-8222-222222222222"}';
const AGY_LINE = '{"event":"init","conversation_id":"33333333-3333-4333-8333-333333333333","cwd":"/work"}';
const CLAUDE_LINE = '{"type":"system","subtype":"init","session_id":"44444444-4444-4444-8444-444444444444"}';

function fake(chunks: string[]): ProcessSpawner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    spawn(_command: string, args: readonly string[]): SpawnedProcess {
      calls.push([...args]);
      const output = chunks;
      return {
        pid: 7,
        stdout: (async function* () { for (const chunk of output) yield chunk; })(),
        exited: new Promise(() => {}),
      };
    },
  };
}

const opts = { cwd: '/work', env: { AGENT_ROOM_MANAGED: '1' }, prompt: 'hello room' };

describe('launcher adapters', () => {
  it('builds verified argv, parses session ids across chunks, and enforces allowlists', async () => {
    const codexChunks = [CODEX_LINE.slice(0, 20), CODEX_LINE.slice(20) + '\n'];
    const codexSpawn = fake(codexChunks);
    const codex = new CodexCliAdapter(codexSpawn);
    const launched = await codex.launch({ ...opts, model: 'gpt-6.1-sol' });
    expect(launched.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(codexSpawn.calls[0]).toEqual(['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-m', 'gpt-6.1-sol', 'hello room']);
    codexSpawn.calls.length = 0;
    await codex.resume({ ...opts, model: 'gpt-6-luna', sessionId: '11111111-1111-4111-8111-111111111111' });
    expect(codexSpawn.calls[0]).toEqual(['exec', 'resume', '11111111-1111-4111-8111-111111111111', '--json', '--skip-git-repo-check', '-m', 'gpt-6-luna', 'hello room']);
    await expect(codex.launch({ ...opts, model: 'gpt-4' })).rejects.toThrow('model_not_allowed');
    expect(codexSpawn.calls).toHaveLength(1);

    const cursorSpawn = fake([CURSOR_LINE.slice(0, 15), CURSOR_LINE.slice(15)]);
    const cursor = createCursorAdapter(cursorSpawn);
    expect((await cursor.launch({ ...opts, model: 'grok-4.7-high' })).sessionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(cursorSpawn.calls[0]).toEqual(['-p', '--output-format', 'stream-json', '--trust', '--approve-mcps', '--model', 'grok-4.7-high', 'hello room']);
    await cursor.resume({ ...opts, model: 'grok-4.7', sessionId: '22222222-2222-4222-8222-222222222222' });
    expect(cursorSpawn.calls[1]).toContain('--resume');
    expect(cursorSpawn.calls[1]).toContain('--model');
    expect(cursorSpawn.calls[1]).toContain('grok-4.7');
    await expect(cursor.launch({ ...opts, model: 'gpt-6.1-sol' })).rejects.toThrow('model_not_allowed');

    const agySpawn = fake([AGY_LINE + '\n']);
    const agy = createAgyAdapter(agySpawn);
    expect((await agy.launch({ ...opts, model: 'gemini-3.8-flash-high' })).sessionId).toBe('33333333-3333-4333-8333-333333333333');
    expect(agySpawn.calls[0]).toEqual(['-p', 'hello room', '--model', 'gemini-3.8-flash-high', '--output-format', 'stream-json']);
    await agy.resume({ ...opts, model: 'gemini-3.8-flash-high', sessionId: '33333333-3333-4333-8333-333333333333' });
    expect(agySpawn.calls[1]).toEqual(['-p', 'hello room', '--model', 'gemini-3.8-flash-high', '--output-format', 'stream-json', '--conversation', '33333333-3333-4333-8333-333333333333']);

    const claude = createClaudeAdapter(fake([]));
    expect(claude.launchArgv('claude-opus', 'hello room')).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus', 'hello room']);
    expect(claude.resumeArgv('44444444-4444-4444-8444-444444444444', 'claude-opus', 'hello room')).toContain('--resume');
    expect(claude.parseSessionId(CLAUDE_LINE)).toBe('44444444-4444-4444-8444-444444444444');
    await expect(claude.launch({ ...opts, model: 'claude-opus' })).rejects.toThrow('model_not_allowed');
    await expect(claude.resume({ ...opts, model: 'claude-opus', sessionId: 'abc' })).rejects.toThrow('model_not_allowed');
  });

  it('rejects unsafe flags before spawn', async () => {
    const spawn = fake([CODEX_LINE]);
    const codex = new CodexCliAdapter(spawn);
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

    const seen: string[] = [];
    const adapter = new CodexCliAdapter(fake([]), {
      probe: async command => { seen.push(command); return { installed: true, version: 'codex-cli 0.162', path: '/bin/codex' }; },
    });
    expect(await adapter.detect()).toMatchObject({ installed: true, version: 'codex-cli 0.162' });
    expect(seen).toEqual(['codex']);
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
