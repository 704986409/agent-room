import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Participant, Room } from '@agent-room/shared';
import { HostNameTakenError } from '@agent-room/upstash-client';
import type { RemoteRoomClient } from './_mcpRoomClient.js';

const storeMocks = vi.hoisted(() => ({
  appendSystemMessage: vi.fn(),
  getMessageTotalCount: vi.fn(),
  getRoom: vi.fn(),
  getTurnState: vi.fn(),
  joinRoom: vi.fn(),
  listMessages: vi.fn(),
  removeParticipant: vi.fn(),
  sweepTimeouts: vi.fn(),
  verifyHostKey: vi.fn(),
}));

vi.mock('@agent-room/upstash-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-room/upstash-client')>();
  return {
    ...actual,
    appendSystemMessage: storeMocks.appendSystemMessage,
    getMessageTotalCount: storeMocks.getMessageTotalCount,
    getRoom: storeMocks.getRoom,
    getTurnState: storeMocks.getTurnState,
    joinRoom: storeMocks.joinRoom,
    listMessages: storeMocks.listMessages,
    removeParticipant: storeMocks.removeParticipant,
    sweepTimeouts: storeMocks.sweepTimeouts,
    verifyHostKey: storeMocks.verifyHostKey,
  };
});

import {
  appendSystemMessage,
  getCurrentTurnState,
  getMessagesWithTotal,
  joinRoom,
  removeParticipant,
  sweepRoom,
} from './_mcpRoomClient.js';

const room: Room = {
  code: 'ABC-DEF-GHJ',
  topic: 'Test',
  createdAt: 1,
  createdBy: 'Alice',
  status: 'active',
  version: 1,
  participants: [],
};

const participant: Participant = {
  name: 'Codex',
  client: 'cc',
  role: 'Developer',
  color: '#5B6AFF',
  initials: 'CO',
  joinedAt: 1,
  lastSeenAt: 1,
};

const message: Message = {
  id: 1,
  type: 'sys',
  name: 'system',
  initials: 'SY',
  color: '#000000',
  role: 'System',
  text: 'swept',
  client: 'cc',
  time: 1,
};

const client = { store: {}, post: vi.fn() } as unknown as RemoteRoomClient;

describe('_mcpRoomClient HTTP helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.appendSystemMessage.mockResolvedValue(undefined);
    storeMocks.getMessageTotalCount.mockResolvedValue(650);
    storeMocks.getRoom.mockResolvedValue(room);
    storeMocks.getTurnState.mockResolvedValue({ queue: [] });
    storeMocks.joinRoom.mockResolvedValue({ ...room, participant });
    storeMocks.listMessages.mockResolvedValue([message]);
    storeMocks.removeParticipant.mockResolvedValue(room);
    storeMocks.sweepTimeouts.mockResolvedValue({ state: null, skipped: [] });
    storeMocks.verifyHostKey.mockResolvedValue(false);
  });

  it('reads messages and the absolute total count', async () => {
    await expect(getMessagesWithTotal(client, room.code, 649)).resolves.toEqual({
      messages: [message],
      total: 650,
    });
    expect(storeMocks.listMessages).toHaveBeenCalledWith(client.store, room.code, 649);
    expect(storeMocks.getMessageTotalCount).toHaveBeenCalledWith(client.store, room.code);
  });

  it('loads room, sweeps turn timeouts, then reloads the room', async () => {
    const afterSweep = { ...room, version: 2 };
    const order: string[] = [];
    storeMocks.getRoom
      .mockImplementationOnce(async () => { order.push('getRoom'); return room; })
      .mockImplementationOnce(async () => { order.push('getRoom'); return afterSweep; });
    storeMocks.sweepTimeouts.mockImplementationOnce(async () => { order.push('sweepTimeouts'); });

    await expect(sweepRoom(client, room.code)).resolves.toEqual(afterSweep);
    expect(order).toEqual(['getRoom', 'sweepTimeouts', 'getRoom']);
    expect(storeMocks.sweepTimeouts).toHaveBeenCalledWith(client.store, room.code, room);
  });

  it('passes priorIdentity through to the storage join', async () => {
    const priorIdentity = { name: 'Codex Web', client: 'web' as const };
    await joinRoom(client, room.code, participant, {
      hostKey: 'host-key',
      seatKey: 'seat-key',
      priorIdentity,
    });
    expect(storeMocks.joinRoom).toHaveBeenCalledWith(client.store, room.code, participant, {
      hostKey: 'host-key',
      seatKey: 'seat-key',
      priorIdentity,
    });
  });

  it('rejects a host-name claim when hostKey verification fails before storage join', async () => {
    const hostParticipant = { ...participant, name: 'alice', client: 'web' as const };
    const error = new HostNameTakenError(room.createdBy);
    storeMocks.verifyHostKey.mockRejectedValueOnce(error);

    await expect(
      joinRoom(client, room.code, hostParticipant, { hostKey: 'wrong-host-key' }),
    ).rejects.toMatchObject({ status: 409, code: 'HostNameTakenError' });

    expect(storeMocks.verifyHostKey).toHaveBeenCalledWith(
      client.store, room.code, 'wrong-host-key',
    );
    expect(storeMocks.joinRoom).not.toHaveBeenCalled();
  });

  it('verifies the host key before joining under the creator name', async () => {
    const order: string[] = [];
    storeMocks.verifyHostKey.mockImplementationOnce(async () => { order.push('verifyHostKey'); });
    storeMocks.joinRoom.mockImplementationOnce(async () => {
      order.push('joinRoom');
      return { ...room, participant: { ...participant, name: room.createdBy, client: 'web' } };
    });

    await joinRoom(client, room.code, { ...participant, name: room.createdBy, client: 'web' }, {
      hostKey: 'host-key',
    });

    expect(order).toEqual(['verifyHostKey', 'joinRoom']);
    expect(storeMocks.verifyHostKey).toHaveBeenCalledWith(
      client.store, room.code, 'host-key',
    );
  });

  it('passes a web targetClient through to storage removal', async () => {
    await removeParticipant(client, room.code, 'Alice', 'Guest', 'web');
    expect(storeMocks.removeParticipant).toHaveBeenCalledWith(
      client.store, room.code, 'Alice', 'Guest', 'web',
    );
  });

  it('does not append a system message when the requester is not host', async () => {
    await expect(
      appendSystemMessage(client, room.code, 'Guest', undefined, message),
    ).rejects.toMatchObject({
      status: 403,
      code: 'NotHostError',
    });
    expect(storeMocks.appendSystemMessage).not.toHaveBeenCalled();
  });

  it('appends a system message for the verified host', async () => {
    await appendSystemMessage(client, room.code, 'Alice', undefined, message);
    expect(storeMocks.appendSystemMessage).toHaveBeenCalledWith(client.store, room.code, message);
  });

  it('reads the current turn state for the requested room', async () => {
    await expect(getCurrentTurnState(client, room.code)).resolves.toEqual({ queue: [] });
    expect(storeMocks.getTurnState).toHaveBeenCalledWith(client.store, room.code);
  });
});
