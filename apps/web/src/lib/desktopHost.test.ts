import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_CONTROL_ORIGIN, hostOnThisMachine, isDesktopShell, listenDesktopEvent, revealManagedTerminal } from './desktopHost.js';

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

describe('listenDesktopEvent', () => {
  it('subscribes through the event plugin and unwraps the payload', async () => {
    const invoke = vi.fn(async () => undefined);
    const box: { current: ((response: unknown) => void) | null } = { current: null };
    const unregistered: number[] = [];
    const seen: unknown[] = [];
    const unlisten = await listenDesktopEvent('managed-terminal-docked', payload => { seen.push(payload); }, {
      __TAURI_INTERNALS__: {
        invoke,
        transformCallback: (callback: (response: unknown) => void) => {
          box.current = callback;
          return 7;
        },
        unregisterCallback: (id: number) => { unregistered.push(id); },
      },
    });
    expect(invoke).toHaveBeenCalledWith('plugin:event|listen', {
      event: 'managed-terminal-docked',
      target: { kind: 'Any' },
      handler: 7,
    });
    box.current?.({ payload: 'st_1' });
    expect(seen).toEqual(['st_1']);
    unlisten?.();
    expect(unregistered).toEqual([7]);
  });

  it('returns null when the webview cannot listen', async () => {
    await expect(listenDesktopEvent('managed-terminal-docked', () => {}, {})).resolves.toBeNull();
  });
});

describe('revealManagedTerminal', () => {
  it('invokes open_managed_terminal once with the seat id', async () => {
    const invoke = vi.fn(async () => undefined);
    await expect(revealManagedTerminal('st_06eb2797', invoke)).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('open_managed_terminal', { seatId: 'st_06eb2797' });
  });

  it('returns the invoke error and does not throw', async () => {
    const invoke = vi.fn(async () => { throw new Error('daemon not ready'); });
    await expect(revealManagedTerminal('st_1', invoke)).resolves.toBe('daemon not ready');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not invoke when the host response has no seat id', async () => {
    const invoke = vi.fn(async () => undefined);
    await expect(revealManagedTerminal(undefined, invoke)).resolves.toBeNull();
    await expect(revealManagedTerminal('  ', invoke)).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
