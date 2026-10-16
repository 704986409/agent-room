// What an agent that never joined is told when it sends.
//
// It used to be "the host muted you — wait via room_listen; do not retry until
// unmuted", because storage answered both "no seat" and "muted seat" with the
// same error. That is a dead end: no host action can unmute a seat that does
// not exist, so the agent waits forever on a room it is not in.
//
// Nothing is mocked below the tool layer. The room comes out of a stand-in
// Redis, so the refusal travels the real path — appendMessage's speaker gate,
// the seam's error translation, then the dispatcher's hint — and the muted
// case rides the same path to prove the two really do come apart.

import { describe, expect, it, vi } from 'vitest';
import type { Participant, Room } from '@agent-room/shared';
import type { RemoteRoomClient } from './_mcpRoomClient.js';
import { callTool } from './_mcpTools.js';

const CODE = 'AAA-BBB-CCC';

const seat = (over: Partial<Participant>): Participant => ({
  name: 'Codex', role: 'builder', color: '#002', initials: 'CO', client: 'cc',
  joinedAt: 1, lastSeenAt: 1, canSpeak: true, ...over,
});

function roomWith(participants: Participant[]): Room {
  return {
    code: CODE, topic: 'Speak gate', createdAt: Date.now(), createdBy: 'Host',
    status: 'active', version: 1, replyMode: 'open', participants,
  };
}

/** Just enough Redis to answer `getRoom`; any write would be a bug here. */
function clientFor(room: Room) {
  const pipeline = vi.fn(async () => []);
  const command = vi.fn(async (cmd: readonly (string | number)[]) =>
    (cmd[0] === 'GET' && cmd[1] === `room:${CODE}` ? JSON.stringify(room) : null));
  return {
    client: { store: { command, pipeline }, post: vi.fn() } as unknown as RemoteRoomClient,
    pipeline,
  };
}

const send = async (room: Room, name: string, args: Record<string, unknown> = {}) => {
  const { client, pipeline } = clientFor(room);
  const result = await callTool(client, 'full', 'room_send', {
    code: CODE, name, text: 'ready when you are', ...args,
  });
  return { body: JSON.parse((result.content[0] as { text: string }).text), result, pipeline };
};

describe('room_send speaker gate', () => {
  it('tells an agent that never joined to join, and writes nothing', async () => {
    const { body, result, pipeline } = await send(roomWith([]), 'Codex');

    expect(body).toMatchObject({ sent: false, error: 'not_participant' });
    expect(body.hint).toBe(
      '"Codex" is not a participant of this room — join it before sending messages. '
      + 'Call room_join with this room code and your agent name, then send again.',
    );
    expect(body.hint).not.toContain('unmuted');
    expect(result.isError).toBeUndefined();
    expect(pipeline).not.toHaveBeenCalled();
  });

  // room_status is an alias for a status-kind room_send, so it refuses the
  // same way rather than falling through to the generic webhook wording.
  it('answers a room_status ping from a non-member the same way', async () => {
    const { client } = clientFor(roomWith([]));
    const result = await callTool(client, 'full', 'room_status', {
      code: CODE, name: 'Codex', text: 'still working',
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      sent: false, error: 'not_participant',
    });
  });

  it('still tells a muted member to wait for the host', async () => {
    const { body } = await send(roomWith([seat({ canSpeak: false })]), 'Codex');

    expect(body).toMatchObject({ sent: false, error: 'muted' });
    expect(body.hint).toContain('muted by the host');
    expect(body.hint).toContain('do not retry until unmuted');
  });

  // Same display name, other client kind: the human's web seat is not a seat
  // the agent may speak from.
  it('refuses an agent whose name only holds a web seat', async () => {
    const { body } = await send(roomWith([seat({ name: 'Codex', client: 'web' })]), 'Codex');
    expect(body).toMatchObject({ sent: false, error: 'not_participant' });
  });
});
