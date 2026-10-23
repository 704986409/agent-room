import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { machineIdPath, readOrCreateMachineId } from './src/machineId.js';
import { joinRoomOverMcp } from './src/mcpJoin.js';

describe('machine id', () => {
  it('uses LOCALAPPDATA on Windows and XDG state elsewhere, not the install directory', () => {
    expect(machineIdPath({ LOCALAPPDATA: 'D:\\Agent Room\\logs' }, 'win32', 'C:\\Users\\a'))
      .toBe('D:\\Agent Room\\logs\\agent-room\\machine-id');
    expect(machineIdPath({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a'))
      .toBe('C:\\Users\\a\\AppData\\Local\\agent-room\\machine-id');
    expect(machineIdPath({ XDG_STATE_HOME: '/tmp/state' }, 'linux', '/home/a'))
      .toBe('/tmp/state/agent-room/machine-id');
    expect(machineIdPath({}, 'linux', '/home/a')).toBe('/home/a/.local/state/agent-room/machine-id');
  });

  it('reuses a machine id written next to a path that contains spaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'Agent Room id '));
    const path = join(directory, 'machine-id');
    const first = await readOrCreateMachineId(path);
    expect(await readOrCreateMachineId(path)).toBe(first);
    expect((await readFile(path, 'utf8')).trim()).toBe(first);
  });
});

describe('joinRoomOverMcp', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('passes the machine id through to room_join', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string };
      bodies.push(body);
      const result = body.method === 'initialize'
        ? {}
        : { structuredContent: { seatKey: 'seat-key-value', cursor: 4, name: 'Codex' } };
      return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const joined = await joinRoomOverMcp({
      server: 'http://127.0.0.1:9', code: 'ABC-DEF-GHJ', name: 'Codex', inviteCode: 'AI-1', machineId: 'machine-a-1111',
    });
    expect(joined).toMatchObject({ seatKey: 'seat-key-value', cursor: 4, name: 'Codex' });
    const call = bodies[1] as { params: { arguments: { machineId: string; inviteCode: string } } };
    expect(call.params.arguments).toMatchObject({ machineId: 'machine-a-1111', inviteCode: 'AI-1', name: 'Codex' });
  });
});
