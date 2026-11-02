import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cursorSeatMcpConfig,
  defaultRoomsDir,
  deleteSeatStateFiles,
  ensureSharedRules,
  isLoopbackMcpShimUrl,
  resolveMcpShimUrl,
  seatDirPath,
  seatFolderName,
  seatStatePath,
  sharedRulesPath,
  writeSeatFiles,
} from './src/seatFiles.js';

describe('seatFiles layout', () => {
  it('derives rooms next to stateDir (…/logs → …/rooms)', () => {
    expect(defaultRoomsDir('D:\\Agent Room\\logs')).toMatch(/rooms$/);
    expect(defaultRoomsDir('/var/agent-room/logs', {})).toBe('/var/agent-room/rooms');
    expect(defaultRoomsDir('/x/logs', { AGENT_ROOM_ROOMS_DIR: '/custom/rooms' })).toBe('/custom/rooms');
  });

  it('builds stable seat folders and writes shared rules + AGENTS (no state.md)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ar-rooms-'));
    const roomsDir = join(root, 'rooms');
    const leftover = join(
      seatDirPath(roomsDir, 'ABC-DEF-GHJ', 'codex', '开发工程师', 'st_a'),
      'state.md',
    );
    // Pretend an older build left state.md behind.
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(leftover, '..'), { recursive: true });
    await writeFile(leftover, 'legacy seatKey: should-be-deleted\n', 'utf8');

    const written = await writeSeatFiles({
      roomsDir,
      code: 'ABC-DEF-GHJ',
      name: '开发工程师',
      seatId: 'st_a',
      adapterId: 'codex',
      seatKey: 'seat-key-secret',
    });
    expect(written.rulesPath).toBe(sharedRulesPath(roomsDir));
    expect(written.seatDir).toBe(seatDirPath(roomsDir, 'ABC-DEF-GHJ', 'codex', '开发工程师', 'st_a'));
    expect(seatFolderName('codex', '开发工程师', 'st_a')).toContain('codex');
    expect(seatFolderName('codex', '开发工程师', 'st_a')).toContain('st_a');
    expect(seatStatePath(written.seatDir)).toBe(join(written.seatDir, 'state.md'));

    const rules = await readFile(written.rulesPath, 'utf8');
    expect(rules).toContain('动作游标');
    expect(rules).toContain('唤醒监听');
    expect(rules).toContain('追历史只用一次');
    expect(rules).toContain('禁止 `managed: {}`');
    expect(rules).toContain('默认 hold');
    expect(rules).toContain('不要读 `state.md`');
    expect(rules).toContain('AGENT_ROOM_MCP_ALIAS');
    expect(rules).toContain('禁止主动发「已上线」');
    expect(rules).toContain('启动后立刻 `room_listen`');
    expect(rules).toMatch(/禁止[\s\S]*timeoutMs: 0/);
    expect(rules).not.toContain('seat-key-secret');
    expect(rules).not.toContain('**座位状态文件**');

    await expect(access(seatStatePath(written.seatDir))).rejects.toMatchObject({ code: 'ENOENT' });

    const agents = await readFile(join(written.seatDir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('动作游标');
    expect(agents).toContain('AGENT_ROOM_SEAT_KEY');
    expect(agents).toContain('追历史只用一次');
    expect(agents).toContain('不要读 `state.md`');
    expect(agents).not.toContain('座位状态：同目录');
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
    await expect(readFile(join(written.seatDir, 'AGENTS.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    // Shared rules kept
    expect(await readFile(written.rulesPath, 'utf8')).toContain('动作游标');
  });

  it('writes Cursor seat .cursor/mcp.json to loopback mcp-shim and cleans it on delete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ar-rooms-cursor-'));
    const roomsDir = join(root, 'rooms');
    expect(isLoopbackMcpShimUrl('http://127.0.0.1:17421/mcp-shim')).toBe(true);
    expect(isLoopbackMcpShimUrl('https://www.agent-room.com/mcp')).toBe(false);
    expect(resolveMcpShimUrl({ AGENT_ROOM_CONTROL_PORT: '18000' })).toBe('http://127.0.0.1:18000/mcp-shim');

    const written = await writeSeatFiles({
      roomsDir,
      code: 'ABC-DEF-GHJ',
      name: '测试工程师',
      seatId: 'st_c',
      adapterId: 'cursor-agent',
      seatKey: 'seat-key-secret',
      mcpShimUrl: 'http://127.0.0.1:17421/mcp-shim',
    });
    const mcpPath = join(written.seatDir, '.cursor', 'mcp.json');
    const mcp = await readFile(mcpPath, 'utf8');
    expect(mcp).toBe(cursorSeatMcpConfig('http://127.0.0.1:17421/mcp-shim'));
    expect(mcp).toContain('"type": "http"');
    expect(mcp).toContain('http://127.0.0.1:17421/mcp-shim');
    expect(mcp).toContain('${env:AGENT_ROOM_SEAT_KEY}');
    expect(mcp).not.toContain('www.agent-room.com');
    expect(mcp).not.toContain('seat-key-secret');

    // Codex seats do not get a project mcp.json (they use -c overrides).
    const codex = await writeSeatFiles({
      roomsDir,
      code: 'ABC-DEF-GHJ',
      name: '开发工程师',
      seatId: 'st_x',
      adapterId: 'codex',
      seatKey: 'seat-key-secret',
      mcpShimUrl: 'http://127.0.0.1:17421/mcp-shim',
    });
    await expect(access(join(codex.seatDir, '.cursor', 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    await deleteSeatStateFiles({
      roomsDir,
      code: 'ABC-DEF-GHJ',
      name: '测试工程师',
      seatId: 'st_c',
      adapterId: 'cursor-agent',
      seatDir: written.seatDir,
    });
    await expect(access(mcpPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
