import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Message, Participant, Room } from '@agent-room/shared';

const mocks = vi.hoisted(() => ({
  client: {
    store: {},
    post: vi.fn(async (_payload: Record<string, unknown>) => ({ forwarded: true })),
  },
  createRemoteRoomClient: vi.fn(),
  appendMessage: vi.fn(),
  appendSystemMessage: vi.fn(),
  createRoom: vi.fn(),
  createRoomReport: vi.fn(),
  endRoom: vi.fn(),
  getCurrentTurnState: vi.fn(),
  getMessagesWithTotal: vi.fn(),
  getRoom: vi.fn(),
  joinRoom: vi.fn(),
  reactivateRoom: vi.fn(),
  removeParticipant: vi.fn(),
  setListenUntil: vi.fn(),
  sweepRoom: vi.fn(),
}));

vi.mock('./_mcpRoomClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_mcpRoomClient.js')>();
  return {
    ...actual,
    createRemoteRoomClient: mocks.createRemoteRoomClient,
    appendMessage: mocks.appendMessage,
    appendSystemMessage: mocks.appendSystemMessage,
    createRoom: mocks.createRoom,
    createRoomReport: mocks.createRoomReport,
    endRoom: mocks.endRoom,
    getCurrentTurnState: mocks.getCurrentTurnState,
    getMessagesWithTotal: mocks.getMessagesWithTotal,
    getRoom: mocks.getRoom,
    joinRoom: mocks.joinRoom,
    reactivateRoom: mocks.reactivateRoom,
    removeParticipant: mocks.removeParticipant,
    setListenUntil: mocks.setListenUntil,
    sweepRoom: mocks.sweepRoom,
  };
});

import handler from './room.js';
import { RemoteRoomApiError } from './_mcpRoomClient.js';

const room: Room & { hostKey: string } = {
  code: 'ABC-DEF-GHJ',
  topic: 'Test',
  createdAt: 1,
  createdBy: 'Alice',
  status: 'active',
  version: 1,
  participants: [],
  hostKey: 'host-secret',
};

const participant: Participant = {
  name: 'Codex',
  client: 'cc',
  role: 'Developer',
  color: '#5B6AFF',
  initials: 'CO',
  joinedAt: 0,
  lastSeenAt: 0,
};

const message: Message = {
  id: 1,
  type: 'msg',
  name: 'Codex',
  initials: 'CO',
  color: '#5B6AFF',
  role: 'Developer',
  text: 'hello',
  client: 'cc',
  time: 1,
};

function makeResponse() {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return response;
}

async function callHandler(method: string, body?: unknown) {
  const req = {
    method,
    headers: { host: 'selfhost.example' },
    body,
  } as unknown as VercelRequest;
  const res = makeResponse();
  await handler(req, res as unknown as VercelResponse);
  return res;
}

describe('POST /api/room', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRemoteRoomClient.mockReturnValue(mocks.client);
    mocks.appendMessage.mockResolvedValue({ appended: true });
    mocks.appendSystemMessage.mockResolvedValue(undefined);
    mocks.createRoom.mockResolvedValue(room);
    mocks.createRoomReport.mockResolvedValue({ code: room.code });
    mocks.endRoom.mockResolvedValue({ ...room, status: 'ended' });
    mocks.getCurrentTurnState.mockResolvedValue(null);
    mocks.getMessagesWithTotal.mockResolvedValue({ messages: [], total: 0 });
    mocks.getRoom.mockResolvedValue(room);
    mocks.joinRoom.mockResolvedValue({ ...room, participant });
    mocks.reactivateRoom.mockResolvedValue(room);
    mocks.removeParticipant.mockResolvedValue(room);
    mocks.setListenUntil.mockResolvedValue(undefined);
    mocks.sweepRoom.mockResolvedValue(room);
    mocks.client.post.mockResolvedValue({ forwarded: true });
  });

  it('returns 405 for GET', async () => {
    const res = await callHandler('GET');
    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'MethodNotAllowed', message: 'POST only' });
  });

  it('returns 204 to OPTIONS and sets CORS headers', async () => {
    const res = await callHandler('OPTIONS');
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.headers).toMatchObject({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    });
  });

  it('creates a room and returns the room host key', async () => {
    const res = await callHandler('POST', {
      action: 'create', topic: 'Test', createdBy: 'Alice',
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.createRemoteRoomClient).toHaveBeenCalledWith('selfhost.example');
    expect(mocks.createRoom).toHaveBeenCalledWith(mocks.client, {
      topic: 'Test', createdBy: 'Alice',
    });
    expect(res.body).toEqual({ room, hostKey: room.hostKey });
  });

  it('rejects durable project attachment', async () => {
    const res = await callHandler('POST', {
      action: 'create', topic: 'Test', createdBy: 'Alice', projectId: 'p1', projectKey: 'secret',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'ProjectAttachUnsupported',
      message: 'Durable project attachment is not supported by this self-hosted build.',
    });
    expect(mocks.createRoom).not.toHaveBeenCalled();
  });

  it('joins using the full participant and forwards priorIdentity', async () => {
    const priorIdentity = { name: 'Old Codex', client: 'web' as const };
    const res = await callHandler('POST', {
      action: 'join', code: room.code, participant, hostKey: 'hk', priorIdentity,
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.joinRoom).toHaveBeenCalledWith(mocks.client, room.code, participant, {
      hostKey: 'hk', priorIdentity,
    });
    expect(res.body).toEqual({ room: { ...room, participant }, participant });
  });

  it('preserves the absolute message total returned by the cursor helper', async () => {
    const messages = [message];
    mocks.getMessagesWithTotal.mockResolvedValue({ messages, total: 650 });
    const res = await callHandler('POST', { action: 'messages', code: room.code, cursor: 649 });
    expect(mocks.getMessagesWithTotal).toHaveBeenCalledWith(mocks.client, room.code, 649);
    expect(res.body).toEqual({ messages, total: 650 });
  });

  it('sweeps the room through sweepRoom', async () => {
    const res = await callHandler('POST', { action: 'sweep', code: room.code });
    expect(mocks.sweepRoom).toHaveBeenCalledWith(mocks.client, room.code);
    expect(res.body).toEqual({ room });
  });

  it('sends messages and preserves the status kind', async () => {
    const result = { appended: true };
    mocks.appendMessage.mockResolvedValue(result);
    const res = await callHandler('POST', {
      action: 'send', code: room.code, message, kind: 'status',
    });
    expect(mocks.appendMessage).toHaveBeenCalledWith(mocks.client, room.code, message, 'status');
    expect(res.body).toEqual({ result });
  });

  it('returns a host authorization error for systemMessage', async () => {
    mocks.appendSystemMessage.mockRejectedValue(
      new RemoteRoomApiError('Only host', 403, 'NotHostError'),
    );
    const res = await callHandler('POST', {
      action: 'systemMessage', code: room.code, requesterName: 'Guest', message,
    });
    expect(mocks.appendSystemMessage).toHaveBeenCalledWith(
      mocks.client, room.code, 'Guest', undefined, message,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'NotHostError', message: 'Only host' });
  });

  it('updates presence with the requested lease end', async () => {
    const res = await callHandler('POST', {
      action: 'presence', code: room.code, name: 'Codex', until: 12345,
    });
    expect(mocks.setListenUntil).toHaveBeenCalledWith(mocks.client, room.code, 'Codex', 12345);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns turn state and accepts web participant removal', async () => {
    mocks.getCurrentTurnState.mockResolvedValue({ queue: [] });
    const stateRes = await callHandler('POST', { action: 'turnState', code: room.code });
    expect(stateRes.body).toEqual({ turnState: { queue: [] } });

    const removeRes = await callHandler('POST', {
      action: 'removeParticipant', code: room.code,
      requesterName: 'Alice', targetName: 'Guest', targetClient: 'web',
    });
    expect(mocks.removeParticipant).toHaveBeenCalledWith(
      mocks.client, room.code, 'Alice', 'Guest', 'web',
    );
    expect(removeRes.body).toEqual({ room });
  });

  it('routes end, reactivate, and createReport to the existing client helpers', async () => {
    await callHandler('POST', {
      action: 'end', code: room.code, requesterName: 'Alice', hostKey: 'hk',
    });
    await callHandler('POST', {
      action: 'reactivate', code: room.code, requesterName: 'Alice', hostKey: 'hk',
    });
    await callHandler('POST', { action: 'createReport', code: room.code });

    expect(mocks.endRoom).toHaveBeenCalledWith(mocks.client, room.code, 'Alice', 'hk');
    expect(mocks.reactivateRoom).toHaveBeenCalledWith(mocks.client, room.code, 'Alice', 'hk');
    expect(mocks.createRoomReport).toHaveBeenCalledWith(mocks.client, room.code);
  });

  it('passes task and reply-mode actions through client.post', async () => {
    const actions = [
      'setReplyMode', 'directInvoke', 'skipCurrent',
      'taskBoard', 'taskCreate', 'taskClaim', 'taskSubmit', 'taskVerify', 'taskReassign', 'taskCancel',
    ];
    for (const action of actions) {
      const payload = { action, code: room.code, title: 'task' };
      const res = await callHandler('POST', payload);
      expect(mocks.client.post).toHaveBeenLastCalledWith(payload);
      expect(res.body).toEqual({ forwarded: true });
    }
    expect(mocks.client.post).toHaveBeenCalledTimes(actions.length);
  });

  it('rejects gameAction and unknown actions with the unsupported_action shape', async () => {
    const game = await callHandler('POST', { action: 'gameAction' });
    expect(game.statusCode).toBe(400);
    expect(game.body).toEqual({
      error: 'unsupported_action',
      message: 'gameAction is not supported by this self-hosted build.',
    });

    const unknown = await callHandler('POST', { action: 'abc' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toEqual({
      error: 'unsupported_action',
      message: 'Unsupported room action "abc".',
    });
  });

  it('maps ordinary business errors to their HTTP status', async () => {
    mocks.getRoom.mockRejectedValue(Object.assign(new Error('missing'), { name: 'RoomNotFoundError' }));
    const res = await callHandler('POST', { action: 'get', code: room.code });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'RoomNotFoundError', message: 'missing' });
  });
});
