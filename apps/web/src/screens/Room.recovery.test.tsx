import { create, act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Room } from '@agent-room/shared';
import { RoomRecoverySurface } from './Room.js';

vi.mock('../i18n/LocaleProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../i18n/LocaleProvider.js')>();
  const { translate } = await import('../i18n/messages.js');
  return {
    ...actual,
    useLocale: () => ({
      locale: 'en' as const,
      setLocale: () => {},
      t: (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate('en', key, values),
      formatDateTime: (value: number | Date) => new Date(value).toLocaleString('en'),
      formatTime: (value: number | Date) => new Date(value).toLocaleTimeString('en'),
      formatNumber: (value: number) => new Intl.NumberFormat('en').format(value),
    }),
  };
});

vi.mock('../env.js', () => ({
  ENV: { upstash: { url: 'http://redis-rest-web', token: 'recovery-test-token' } },
}));

const room: Room = {
  code: 'ABC-DEF-GHJ',
  topic: 'Recovery test',
  createdAt: 1,
  createdBy: 'Alex',
  status: 'active',
  version: 1,
  participants: [],
};

describe('Room recovery surface', () => {
  it('keeps the room UI and shows a temporary warning after a transient error', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <RoomRecoverySurface room={room} error="Upstash HTTP 502">
          <main>Room main UI</main>
        </RoomRecoverySurface>,
      );
    });

    expect(tree.root.findByType('main').children).toEqual(['Room main UI']);
    expect(tree.root.findByProps({ role: 'status' }).children).toContain(
      'Connection temporarily unavailable. Retrying…',
    );
  });

  it('keeps the initial full-page error when no room has loaded', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <RoomRecoverySurface room={null} error="Upstash HTTP 502">
          <main>Room main UI</main>
        </RoomRecoverySurface>,
      );
    });

    expect(tree.root.findByType('pre').children).toEqual(['Upstash HTTP 502']);
    expect(tree.root.findByType('p').children).toEqual(['Something went wrong. Please try again.']);
    expect(() => tree.root.findByType('main')).toThrow();
  });
});
