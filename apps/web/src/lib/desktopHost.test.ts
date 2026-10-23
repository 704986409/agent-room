import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_CONTROL_ORIGIN, hostOnThisMachine, isDesktopShell } from './desktopHost.js';

describe('isDesktopShell', () => {
  it('is false in a normal browser window', () => {
    expect(isDesktopShell({})).toBe(false);
    expect(isDesktopShell(undefined)).toBe(false);
  });

  it('is true when Tauri or the desktop flag is present', () => {
    expect(isDesktopShell({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(isDesktopShell({ __TAURI__: {} })).toBe(true);
    expect(isDesktopShell({ __AGENT_ROOM_DESKTOP__: true })).toBe(true);
  });
});

describe('hostOnThisMachine', () => {
  it('posts the room code and invite to the loopback daemon', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, seat: { seatId: 'st_1', name: '开发工程师' } }), { status: 200 }));
    const result = await hostOnThisMachine(
      { code: 'ABC-DEF-GHJ', inviteCode: 'AI-ONE', name: '开发工程师' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.seat.seatId).toBe('st_1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DESKTOP_CONTROL_ORIGIN}/api/desktop/host`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-agent-room-desktop']).toBe('1');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'ABC-DEF-GHJ', inviteCode: 'AI-ONE', name: '开发工程师' });
  });

  it('explains a missing daemon', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('Failed to fetch'); });
    await expect(hostOnThisMachine(
      { code: 'ABC', inviteCode: 'AI', name: '开发工程师' },
      fetchImpl as unknown as typeof fetch,
    )).rejects.toThrow('本机后台没有响应');
  });
});
