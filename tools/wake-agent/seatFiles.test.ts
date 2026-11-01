import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultRoomsDir,
  deleteSeatStateFiles,
  ensureSharedRules,
  seatDirPath,
  seatFolderName,
  seatStatePath,
  sharedRulesPath,
  writeSeatFiles,
} from './src/seatFiles.js';

describe('seatFiles layout', () => {
  it('derives rooms next to stateDir (…/logs → …/rooms)', () => {
    expect(defaultRoomsDir('D:\\\\Agent Room\\\\logs')).toMatch(/rooms$/);
    expect(defaultRoomsDir('/var/agent-room/logs', {})).toBe('/var/agent-room/rooms');
    expect(defaultRoomsDir('/x/logs', { AGENT_ROOM_ROOMS_DIR: '/custom/rooms' })).toBe('/custom/rooms');
  });

  it('builds stable seat folders and writes shared rules + private state.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ar-rooms-'));
    const roomsDir = join(root, 'rooms');
    const written = await writeSeatFiles({
      roomsDir,
      code: 'ABC-DEF-GHJ',
      name: '开发工程师',
      seatId: 'st_a',
      adapterId: 'codex',
      seatKey: 'seat-key-secret',
    });
    expect(written.rulesPath).toBe(sharedRulesPath(roomsDir));
    expect(written.statePath).toBe(seatStatePath(written.seatDir));
    expect(written.seatDir).toBe(seatDirPath(roomsDir, 'ABC-DEF-GHJ', 'codex', '开发工程师', 'st_a'));
    expect(seatFolderName('codex', '开发工程师', 'st_a')).toContain('codex');
    expect(seatFolderName('codex', '开发工程师', 'st_a')).toContain('st_a');

    const rules = await readFile(written.rulesPath, 'utf8');
    expect(rules).toContain('动作游标');
    expect(rules).toContain('唤醒监听');
    expect(rules).not.toContain('seat-key-secret');

    const state = await readFile(written.statePath, 'utf8');
    expect(state).toContain('职位: 开发工程师');
    expect(state).toContain('房间码: ABC-DEF-GHJ');
    expect(state).toContain('seatKey: seat-key-secret');
    expect(state).toContain('MCP 别名: agent-room');
    expect((await stat(written.statePath)).mode & 0o777).toBe(0o600);

    const agents = await readFile(join(written.seatDir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('动作游标');
    expect(agents).toContain('AGENT_ROOM_SEAT_KEY');
    expect(agents).toContain('state.md');
    expect(agents).not.toContain('seat-key-secret');

    const again = await ensureSharedRules(roomsDir);
    expect(again).toBe(written.rulesPath);

    await deleteSeatStateFiles({
      roomsDir,
      code: 'ABC-DEF-GHJ',
      name: '开发工程师',
      seatId: 'st_a',
      adapterId: 'codex',
      seatDir: written.seatDir,
    });
    await expect(readFile(written.statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    // Shared rules kept
    expect(await readFile(written.rulesPath, 'utf8')).toContain('动作游标');
  });
});
