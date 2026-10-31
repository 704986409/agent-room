import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REACHABILITY_POLL_MS } from '../lib/networkReachability.js';
import { useNetworkOffline } from './useNetworkOffline.js';

const listeners = new Map<string, Set<() => void>>();

function Probe() {
  const offline = useNetworkOffline();
  return <div>{offline ? 'offline' : 'online'}</div>;
}

function text(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

describe('useNetworkOffline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    listeners.clear();
  });

  it('shows after two failed poll cycles and hides on the next success', async () => {
    vi.useFakeTimers();
    let online = true;
    vi.stubGlobal('navigator', {
      get onLine() { return online; },
    });
    vi.stubGlobal('window', {
      addEventListener: (type: string, handler: () => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(handler);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, handler: () => void) => {
        listeners.get(type)?.delete(handler);
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return new Response('ok', { status: 200 });
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Probe />); });
    expect(text(renderer)).toContain('online');

    online = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(REACHABILITY_POLL_MS); });
    expect(text(renderer)).toContain('online');

    await act(async () => { await vi.advanceTimersByTimeAsync(REACHABILITY_POLL_MS); });
    expect(text(renderer)).toContain('offline');

    online = true;
    listeners.get('online')?.forEach(handler => handler());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(text(renderer)).toContain('online');

    await act(async () => renderer.unmount());
  });

  it('does not show on a single offline blip that recovers before the next cycle', async () => {
    vi.useFakeTimers();
    let online = false;
    vi.stubGlobal('navigator', {
      get onLine() { return online; },
    });
    vi.stubGlobal('window', {
      addEventListener: (type: string, handler: () => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(handler);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, handler: () => void) => {
        listeners.get(type)?.delete(handler);
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return new Response('ok', { status: 200 });
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Probe />); });

    listeners.get('offline')?.forEach(handler => handler());
    await act(async () => { await Promise.resolve(); });
    expect(text(renderer)).toContain('online');

    online = true;
    listeners.get('online')?.forEach(handler => handler());
    await act(async () => { await vi.advanceTimersByTimeAsync(REACHABILITY_POLL_MS * 2); });
    expect(text(renderer)).toContain('online');

    await act(async () => renderer.unmount());
  });
});
