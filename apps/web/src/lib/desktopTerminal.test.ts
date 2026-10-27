import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_CONTROL_ORIGIN } from './desktopHost.js';
import { desktopTerminalWsUrl, listDesktopTerminals, terminalsForRoom } from './desktopTerminal.js';

describe('desktopTerminalWsUrl', () => {
  it('targets the desktop-auth socket and does not carry a control token', () => {
    const url = desktopTerminalWsUrl('st_06eb2797');
    expect(url).toBe('ws://127.0.0.1:17421/api/desktop/terminals/st_06eb2797/ws?desktop=1');
    expect(url.includes('t=')).toBe(false);
    expect(desktopTerminalWsUrl('a/b c')).toBe(
      'ws://127.0.0.1:17421/api/desktop/terminals/a%2Fb%20c/ws?desktop=1',
    );
  });
});

describe('terminalsForRoom', () => {
  const rows = [
    { seatId: 'st_here', pid: 1, cols: 80, rows: 24, name: '开发工程师', code: 'ABC-DEF' },
    { seatId: 'st_other', pid: 2, cols: 80, rows: 24, name: 'writer', code: 'OLD-ROOM' },
    { seatId: 'st_untagged', pid: 3, cols: 80, rows: 24 },
  ];

  it('keeps seats that belong to this room', () => {
    expect(terminalsForRoom(rows, 'ABC-DEF').map(row => row.seatId)).toEqual(['st_here']);
  });

  it('falls back to every live terminal when none are tagged for the room', () => {
    expect(terminalsForRoom(rows, 'MISSING').map(row => row.seatId)).toEqual(['st_here', 'st_other', 'st_untagged']);
  });
});

describe('listDesktopTerminals', () => {
  it('asks the loopback daemon with the desktop mark and no token', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      terminals: [{ seatId: 'st_1', pid: 4, cols: 80, rows: 24, name: '开发工程师', code: 'ABC-DEF' }],
      mode: 'embedded',
    }), { status: 200 }));
    const result = await listDesktopTerminals(fetchImpl as unknown as typeof fetch);
    expect(result.terminals[0]?.seatId).toBe('st_1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DESKTOP_CONTROL_ORIGIN}/api/desktop/terminals`);
    expect(url.includes('t=')).toBe(false);
    expect((init.headers as Record<string, string>)['x-agent-room-desktop']).toBe('1');
  });
});
