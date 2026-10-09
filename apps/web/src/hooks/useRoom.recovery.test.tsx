import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Room } from '@agent-room/shared';
import { useRoom } from './useRoom.js';

const room: Room = {
  code: 'ABC-DEF-GHJ',
  topic: 'Recovery test',
  createdAt: 1,
  createdBy: 'Alex',
  status: 'active',
  version: 1,
  participants: [],
};

const firstMessage: Message = {
  id: 1,
  type: 'msg',
  name: 'Alex',
  initials: 'AL',
  color: '#000000',
  role: 'host',
  text: 'Existing message',
  client: 'web',
  time: 1,
};

const roomClient = vi.hoisted(() => ({
  createClient: vi.fn(() => ({})),
  getRoom: vi.fn(),
  listMessages: vi.fn(),
  appendMessage: vi.fn(),
  updatePresence: vi.fn(),
  getMessageTotalCount: vi.fn(),
}));

vi.mock('@agent-room/upstash-client', () => roomClient);
vi.mock('../env.js', () => ({
  ENV: { upstash: { url: 'http://redis-rest-web', token: 'recovery-test-token' } },
}));

describe('useRoom transient recovery', () => {
  let current: ReturnType<typeof useRoom>;
  let renderer: ReactTestRenderer | null;
  let intervalCallbacks: Array<() => void | Promise<void>>;

  function Harness() {
    current = useRoom(room.code, 'Alex');
    return null;
  }

  async function mount() {
    await act(async () => {
      renderer = create(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    renderer = null;
    intervalCallbacks = [];
    roomClient.createClient.mockReturnValue({} as never);
    roomClient.getRoom.mockResolvedValue(room);
    roomClient.listMessages.mockResolvedValue([]);
    roomClient.appendMessage.mockResolvedValue(undefined);
    roomClient.updatePresence.mockResolvedValue(undefined);
    roomClient.getMessageTotalCount.mockResolvedValue(0);

    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('setInterval', (callback: () => void | Promise<void>) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    });
    vi.stubGlobal('clearInterval', vi.fn());
  });

  afterEach(() => {
    if (renderer) {
      act(() => renderer?.unmount());
      renderer = null;
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('clears a room-fetch 502 after the next room fetch succeeds', async () => {
    await mount();
    roomClient.getRoom
      .mockRejectedValueOnce(new Error('Upstash HTTP 502'))
      .mockResolvedValueOnce(room);

    await act(async () => current.refreshRoom());
    expect(current.error).toContain('502');

    await act(async () => current.refreshRoom());
    expect(current.room).toEqual(room);
    expect(current.error).toBeNull();
  });

  it('clears a message-fetch 502 when the next successful result is empty', async () => {
    await mount();
    roomClient.listMessages
      .mockRejectedValueOnce(new Error('Upstash HTTP 502'))
      .mockResolvedValueOnce([]);

    await act(async () => intervalCallbacks[0]?.());
    expect(current.error).toContain('502');

    await act(async () => intervalCallbacks[0]?.());
    expect(current.error).toBeNull();
    expect(roomClient.listMessages).toHaveBeenCalledTimes(3);
  });

  it('clears the old error after an empty poll and cursor self-heal with no new messages', async () => {
    roomClient.listMessages.mockResolvedValueOnce([firstMessage]);
    roomClient.getMessageTotalCount.mockResolvedValueOnce(1);
    await mount();
    expect(current.messages).toEqual([firstMessage]);

    roomClient.listMessages
      .mockRejectedValueOnce(new Error('Upstash HTTP 502'))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([firstMessage]);
    roomClient.getMessageTotalCount.mockResolvedValueOnce(0);

    await act(async () => intervalCallbacks[0]?.());
    expect(current.error).toContain('502');

    await act(async () => intervalCallbacks[0]?.());
    expect(current.error).toBeNull();
    expect(current.messages).toEqual([firstMessage]);
    expect(roomClient.listMessages).toHaveBeenLastCalledWith(expect.anything(), room.code, 0);
  });

  it('keeps forceRefresh success clearing the error', async () => {
    await mount();
    roomClient.getRoom
      .mockRejectedValueOnce(new Error('Upstash HTTP 502'))
      .mockResolvedValueOnce(room);

    await act(async () => current.refreshRoom());
    expect(current.error).toContain('502');

    await act(async () => current.forceRefresh());
    expect(current.room).toEqual(room);
    expect(current.error).toBeNull();
  });
});
