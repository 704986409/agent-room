import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Participant, Room } from '@agent-room/shared';
import { createHash, randomUUID } from 'node:crypto';
import { HostNameTakenError, RoomNotFoundError } from '@agent-room/upstash-client';
import type { RemoteRoomClient } from './_mcpRoomClient.js';

const storeMocks = vi.hoisted(() => ({
  addHostDirected: vi.fn(),
  appendSystemMessage: vi.fn(),
  createClient: vi.fn(),
  endRoom: vi.fn(),
  getMessageTotalCount: vi.fn(),
  getRoom: vi.fn(),
  getTurnState: vi.fn(),
  joinRoom: vi.fn(),
  listMessages: vi.fn(),
  removeParticipant: vi.fn(),
  reactivateRoom: vi.fn(),
  setReplyMode: vi.fn(),
  setTurnState: vi.fn(),
  skipQueueHead: vi.fn(),
  sweepTimeouts: vi.fn(),
  verifyHostKey: vi.fn(),
}));

vi.mock('@agent-room/upstash-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-room/upstash-client')>();
  return {
    ...actual,
    addHostDirected: storeMocks.addHostDirected,
    appendSystemMessage: storeMocks.appendSystemMessage,
    createClient: storeMocks.createClient,
    setMessageCommittedHook: vi.fn(),
    endRoom: storeMocks.endRoom,
    getMessageTotalCount: storeMocks.getMessageTotalCount,
    getRoom: storeMocks.getRoom,
    getTurnState: storeMocks.getTurnState,
    joinRoom: storeMocks.joinRoom,
    listMessages: storeMocks.listMessages,
    removeParticipant: storeMocks.removeParticipant,
    reactivateRoom: storeMocks.reactivateRoom,
    setReplyMode: storeMocks.setReplyMode,
    setTurnState: storeMocks.setTurnState,
    skipQueueHead: storeMocks.skipQueueHead,
    sweepTimeouts: storeMocks.sweepTimeouts,
    verifyHostKey: storeMocks.verifyHostKey,
  };
});

import {
  appendRoomEvent,
  appendSystemMessage,
  createRemoteRoomClient,
  endRoom,
  getCurrentTurnState,
  getMessagesWithTotal,
  joinRoom,
  reactivateRoom,
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

function createDispatchClient(): RemoteRoomClient {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'http://127.0.0.1:8079');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-token');
  return createRemoteRoomClient(undefined);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('_mcpRoomClient HTTP helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.createClient.mockReturnValue(client.store);
    storeMocks.appendSystemMessage.mockResolvedValue(undefined);
    storeMocks.addHostDirected.mockReturnValue({ queue: [] });
    storeMocks.endRoom.mockResolvedValue(room);
    storeMocks.getMessageTotalCount.mockResolvedValue(650);
    storeMocks.getRoom.mockResolvedValue(room);
    storeMocks.getTurnState.mockResolvedValue({ queue: [] });
    storeMocks.joinRoom.mockResolvedValue({ ...room, participant });
    storeMocks.listMessages.mockResolvedValue([message]);
    storeMocks.removeParticipant.mockResolvedValue(room);
    storeMocks.reactivateRoom.mockResolvedValue(room);
    storeMocks.setReplyMode.mockResolvedValue(room);
    storeMocks.setTurnState.mockResolvedValue(undefined);
    storeMocks.skipQueueHead.mockReturnValue({ queue: [] });
    storeMocks.sweepTimeouts.mockResolvedValue({ state: null, skipped: [] });
    storeMocks.verifyHostKey.mockResolvedValue(undefined);
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
    const result = await joinRoom(client, room.code, participant, {
      hostKey: 'host-key',
      seatKey: 'seat-key',
      priorIdentity,
    });
    const [storedClient, storedCode, storedParticipant, storedOptions] = storeMocks.joinRoom.mock.calls[0]!;
    expect(storedClient).toBe(client.store);
    expect(storedCode).toBe(room.code);
    expect(storedParticipant).toMatchObject({
      ...participant,
      memoryIdentityType: 'room_member',
      memoryPrincipalId: expect.any(String),
      seatKeyHash: expect.any(String),
    });
    expect(storedParticipant.seatKeyHash).toBe(createHash('sha256').update(result.seatKey!).digest('hex'));
    expect(storedOptions).toMatchObject({
      hostKey: 'host-key',
      priorIdentity,
    });
    expect(storedOptions).not.toHaveProperty('roomInstanceId');
    expect(storedOptions).not.toHaveProperty('seatKey');
    expect(result.seatKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rotates a valid returning seat key while preserving its stored Persona', async () => {
    const oldKey = 'old-server-issued-seat-key';
    const previous = {
      ...participant,
      memoryIdentityType: 'persona' as const,
      memoryPersonaId: 'persona-stable',
      memoryPrincipalId: randomUUID(),
      seatId: 'st_kept',
      seatKeyHash: createHash('sha256').update(oldKey).digest('hex'),
    };
    storeMocks.getRoom.mockResolvedValueOnce({ ...room, roomInstanceId: randomUUID(), participants: [previous] });
    storeMocks.joinRoom.mockImplementationOnce(async (_client, _code, next) => ({
      ...room,
      roomInstanceId: randomUUID(),
      participant: next,
      participants: [next],
    }));

    const result = await joinRoom(client, room.code, participant, { seatKey: oldKey });
    expect(result.seatKey).not.toBe(oldKey);
    expect(storeMocks.joinRoom.mock.calls[0]![2]).toMatchObject({
      memoryIdentityType: 'persona', memoryPersonaId: 'persona-stable', seatId: 'st_kept',
    });
    expect(storeMocks.joinRoom.mock.calls[0]![3]).toMatchObject({
      priorIdentity: { name: participant.name, client: 'cc' },
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

  it('requires a host key before removing another participant', async () => {
    await expect(
      removeParticipant(client, room.code, 'Alice', 'Guest', 'web'),
    ).rejects.toMatchObject({ status: 403, code: 'NotHostError' });
    expect(storeMocks.removeParticipant).not.toHaveBeenCalled();
    expect(storeMocks.verifyHostKey).not.toHaveBeenCalled();
  });

  it('rejects a wrong host key before removing another participant', async () => {
    storeMocks.verifyHostKey.mockRejectedValueOnce(new HostNameTakenError(room.createdBy));

    await expect(
      removeParticipant(client, room.code, 'Alice', 'Guest', 'web', 'wrong-host-key'),
    ).rejects.toMatchObject({ status: 403, code: 'NotHostError' });
    expect(storeMocks.removeParticipant).not.toHaveBeenCalled();
  });

  it('passes a web targetClient through after verifying the host key', async () => {
    await removeParticipant(client, room.code, 'Alice', 'Guest', 'web', 'valid-host-key');
    expect(storeMocks.removeParticipant).toHaveBeenCalledWith(
      client.store, room.code, 'Alice', 'Guest', 'web',
    );
    expect(storeMocks.verifyHostKey).toHaveBeenCalledWith(
      client.store, room.code, 'valid-host-key',
    );
  });

  it('allows a participant to remove itself without a host key', async () => {
    await removeParticipant(client, room.code, 'Codex', 'Codex', 'cc', undefined);
    expect(storeMocks.verifyHostKey).not.toHaveBeenCalled();
    expect(storeMocks.removeParticipant).toHaveBeenCalledWith(
      client.store, room.code, 'Codex', 'Codex', 'cc',
    );
  });

  it('rejects a host-named system message when the host key is missing', async () => {
    await expect(
      appendSystemMessage(client, room.code, 'Alice', undefined, message),
    ).rejects.toMatchObject({
      status: 403,
      code: 'NotHostError',
    });
    expect(storeMocks.appendSystemMessage).not.toHaveBeenCalled();
    expect(storeMocks.verifyHostKey).not.toHaveBeenCalled();
  });

  it('rejects a host-named system message when the host key is wrong', async () => {
    storeMocks.verifyHostKey.mockRejectedValueOnce(new HostNameTakenError(room.createdBy));

    await expect(
      appendSystemMessage(client, room.code, 'Alice', 'wrong-host-key', message),
    ).rejects.toMatchObject({ status: 403, code: 'NotHostError' });
    expect(storeMocks.appendSystemMessage).not.toHaveBeenCalled();
  });

  it('appends a system message for a host with a valid key', async () => {
    await appendSystemMessage(client, room.code, 'Alice', 'valid-host-key', message);
    expect(storeMocks.appendSystemMessage).toHaveBeenCalledWith(client.store, room.code, message);
    expect(storeMocks.verifyHostKey).toHaveBeenCalledWith(
      client.store, room.code, 'valid-host-key',
    );
  });

  // Server-originated events (a memory review request, for one) have no
  // requester and no hostKey to present — the server is the sender.
  it('appends a server-originated room event without a host key', async () => {
    await appendRoomEvent(client, room.code, message);
    expect(storeMocks.appendSystemMessage).toHaveBeenCalledWith(client.store, room.code, message);
    expect(storeMocks.verifyHostKey).not.toHaveBeenCalled();
  });

  it('translates a storage failure on a room event into the tool layer error', async () => {
    storeMocks.appendSystemMessage.mockRejectedValueOnce(new RoomNotFoundError(room.code));
    await expect(appendRoomEvent(client, room.code, message))
      .rejects.toMatchObject({ status: 404, code: 'RoomNotFoundError' });
  });

  it('requires a valid host key before ending a room', async () => {
    await expect(
      endRoom(client, room.code, 'Alice', undefined),
    ).rejects.toMatchObject({ status: 403, code: 'NotHostError' });
    expect(storeMocks.endRoom).not.toHaveBeenCalled();

    storeMocks.verifyHostKey.mockRejectedValueOnce(new HostNameTakenError(room.createdBy));
    await expect(
      endRoom(client, room.code, 'Alice', 'wrong-host-key'),
    ).rejects.toMatchObject({ status: 403, code: 'NotHostError' });
    expect(storeMocks.endRoom).not.toHaveBeenCalled();

    await expect(endRoom(client, room.code, 'Alice', 'valid-host-key')).resolves.toEqual(room);
    expect(storeMocks.endRoom).toHaveBeenCalledWith(client.store, room.code);
  });

  it('requires a valid host key before reactivating a room', async () => {
    await expect(
      reactivateRoom(client, room.code, 'Alice', undefined),
    ).rejects.toMatchObject({ status: 403, code: 'NotHostError' });
    expect(storeMocks.reactivateRoom).not.toHaveBeenCalled();

    storeMocks.verifyHostKey.mockRejectedValueOnce(new HostNameTakenError(room.createdBy));
    await expect(
      reactivateRoom(client, room.code, 'Alice', 'wrong-host-key'),
    ).rejects.toMatchObject({ status: 403, code: 'NotHostError' });
    expect(storeMocks.reactivateRoom).not.toHaveBeenCalled();

    await expect(reactivateRoom(client, room.code, 'Alice', 'valid-host-key')).resolves.toEqual(room);
    expect(storeMocks.reactivateRoom).toHaveBeenCalledWith(client.store, room.code);
  });

  it('requires a host key for setReplyMode before running the update', async () => {
    const dispatchClient = createDispatchClient();
    const payload = { action: 'setReplyMode', code: room.code, requesterName: 'Alice', mode: 'sequential' };

    await expect(dispatchClient.post(payload)).rejects.toMatchObject({
      status: 403, code: 'NotHostError',
    });
    storeMocks.verifyHostKey.mockRejectedValueOnce(new HostNameTakenError(room.createdBy));
    await expect(dispatchClient.post({ ...payload, hostKey: 'wrong-host-key' })).rejects.toMatchObject({
      status: 403, code: 'NotHostError',
    });
    expect(storeMocks.setReplyMode).not.toHaveBeenCalled();

    await expect(dispatchClient.post({ ...payload, hostKey: 'valid-host-key' })).resolves.toEqual({ room });
    expect(storeMocks.setReplyMode).toHaveBeenCalledWith(
      client.store, room.code, 'Alice', 'sequential', undefined,
    );
  });

  it('requires a host key for directInvoke before reading or writing turn state', async () => {
    const dispatchClient = createDispatchClient();
    const payload = {
      action: 'directInvoke', code: room.code, requesterName: 'Alice',
      target: { name: 'CodexA', client: 'cc' },
    };

    await expect(dispatchClient.post(payload)).rejects.toMatchObject({
      status: 403, code: 'NotHostError',
    });
    storeMocks.verifyHostKey.mockRejectedValueOnce(new HostNameTakenError(room.createdBy));
    await expect(dispatchClient.post({ ...payload, hostKey: 'wrong-host-key' })).rejects.toMatchObject({
      status: 403, code: 'NotHostError',
    });
    expect(storeMocks.getTurnState).not.toHaveBeenCalled();
    expect(storeMocks.addHostDirected).not.toHaveBeenCalled();
    expect(storeMocks.setTurnState).not.toHaveBeenCalled();

    await expect(dispatchClient.post({ ...payload, hostKey: 'valid-host-key' })).resolves.toEqual({ added: true });
    expect(storeMocks.addHostDirected).toHaveBeenCalled();
    expect(storeMocks.setTurnState).toHaveBeenCalled();
  });

  it('requires a host key for skipCurrent before reading or writing turn state', async () => {
    const dispatchClient = createDispatchClient();
    const payload = { action: 'skipCurrent', code: room.code, requesterName: 'Alice' };

    await expect(dispatchClient.post(payload)).rejects.toMatchObject({
      status: 403, code: 'NotHostError',
    });
    storeMocks.verifyHostKey.mockRejectedValueOnce(new HostNameTakenError(room.createdBy));
    await expect(dispatchClient.post({ ...payload, hostKey: 'wrong-host-key' })).rejects.toMatchObject({
      status: 403, code: 'NotHostError',
    });
    expect(storeMocks.getTurnState).not.toHaveBeenCalled();
    expect(storeMocks.skipQueueHead).not.toHaveBeenCalled();
    expect(storeMocks.setTurnState).not.toHaveBeenCalled();

    await expect(dispatchClient.post({ ...payload, hostKey: 'valid-host-key' })).resolves.toEqual({ skipped: null });
    expect(storeMocks.skipQueueHead).toHaveBeenCalled();
    expect(storeMocks.setTurnState).toHaveBeenCalled();
  });

  it('reads the current turn state for the requested room', async () => {
    await expect(getCurrentTurnState(client, room.code)).resolves.toEqual({ queue: [] });
    expect(storeMocks.getTurnState).toHaveBeenCalledWith(client.store, room.code);
  });
});

describe('isMemorySeatOnline', () => {
  const base = { name: 'A', role: 'r', color: '#000', initials: 'A', client: 'cc' as const, joinedAt: 0 };
  it('treats <=120s since last seen as online and >120s as offline', async () => {
    const { isMemorySeatOnline } = await import('./_mcpRoomClient.js');
    const now = 1_000_000_000;
    expect(isMemorySeatOnline({ ...base, lastSeenAt: now - 120_000 }, now)).toBe(true);
    expect(isMemorySeatOnline({ ...base, lastSeenAt: now - 120_001 }, now)).toBe(false);
  });
  it('treats a live listen lease as online even when lastSeenAt is old', async () => {
    const { isMemorySeatOnline } = await import('./_mcpRoomClient.js');
    const now = 1_000_000_000;
    expect(isMemorySeatOnline({ ...base, lastSeenAt: now - 600_000, listenLeases: { x: now + 30_000 } }, now)).toBe(true);
    expect(isMemorySeatOnline({ ...base, lastSeenAt: now - 600_000, listenLeases: { x: now - 1 } }, now)).toBe(false);
  });
});
