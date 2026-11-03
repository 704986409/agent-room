import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeSeatFiles } from './src/seatFiles.js';

describe('agy seat MCP plugin', () => {
  it('writes a seat-local plugin pointing at the loopback shim with env-ref seat key', async () => {
    const roomsDir = await mkdtemp(join(tmpdir(), 'agy-'));
    const { seatDir } = await writeSeatFiles({ roomsDir, code: 'ABC-DEF-GHI', name: 'Gemini', seatId: 's-g', adapterId: 'agy', seatKey: 'sk_secret', mcpAlias: 'agent-room', mcpShimUrl: 'http://127.0.0.1:7777/mcp-shim' });
    const cfg = await readFile(join(seatDir, '.agents/plugins/agent-room-seat/mcp_config.json'), 'utf8');
    expect(cfg).toContain('http://127.0.0.1:7777/mcp-shim');
    expect(cfg).toContain('${AGENT_ROOM_SEAT_KEY}');
    expect(cfg).not.toContain('sk_secret');
  });
  it('refuses a non-loopback shim URL', async () => {
    const roomsDir = await mkdtemp(join(tmpdir(), 'agy-'));
    const { seatDir } = await writeSeatFiles({ roomsDir, code: 'ABC-DEF-GHI', name: 'Gemini', seatId: 's-g', adapterId: 'agy', seatKey: 'k', mcpShimUrl: 'http://10.0.0.5:7777/mcp-shim' });
    await expect(readFile(join(seatDir, '.agents/plugins/agent-room-seat/mcp_config.json'))).rejects.toThrow();
  });
});
