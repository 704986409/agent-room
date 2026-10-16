// A shared-memory proposal has to reach the reviewer, not just name them.
//
// Reported behaviour: memory_write returned code PENDING_REVIEW with a
// `notification` object naming the project-analyst seat, and that seat — parked
// in room_listen the whole time — never woke. The notification was built and
// thrown away; nothing was ever appended to the room. The proposal existed only
// for whoever thought to poll memory_review({ action: 'list' }).
//
// So these tests drive the real tool surface (callTool) over a room whose
// message list is in memory, and assert the two halves of "delivered": the
// write appends one addressed room message, and a reviewer holding room_listen
// from a cursor before the proposal gets it back.
//
// The memory service itself is stubbed here on purpose — proposal storage and
// reviewer selection are covered against real Postgres in mcp.smoke.test.ts.
// What is under test is the seam between them and the room.

import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Participant, Room } from '@agent-room/shared';
import type { MemoryIdentity } from '@agent-room/memory';

const ROOM_INSTANCE_ID = randomUUID();
const SEAT_KEYS = {
  host: 'host-seat-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  proposer: 'proposer-seat-key-bbbbbbbbbbbbbbbbbbbbbbbb',
  reviewer: 'reviewer-seat-key-ccccccccccccccccccccccccc',
};

function seat(
  name: string,
  role: string,
  seatKey: string,
  memory: Partial<Participant>,
): Participant {
  return {
    name,
    role,
    color: '#000000',
    initials: name.slice(0, 2).toUpperCase(),
    client: 'cc',
    joinedAt: 0,
    lastSeenAt: Date.now(),
    canSpeak: true,
    seatKeyHash: createHash('sha256').update(seatKey, 'utf8').digest('hex'),
    ...memory,
  };
}

const room: Room = {
  code: 'AAA-BBB-CCC',
  roomInstanceId: ROOM_INSTANCE_ID,
  topic: 'Shared memory review delivery',
  createdAt: 0,
  createdBy: 'Host',
  status: 'active',
  version: 1,
  replyMode: 'open',
  participants: [
    seat('Host', 'host', SEAT_KEYS.host, {
      memoryIdentityType: 'room_owner',
      memoryPrincipalId: ROOM_INSTANCE_ID,
      memoryIsRoomOwner: true,
    }),
    seat('Agent A', 'builder', SEAT_KEYS.proposer, {
      memoryIdentityType: 'persona',
      memoryPersonaId: 'persona-alpha',
      memoryPrincipalId: randomUUID(),
    }),
    seat('Project Analyst', 'project-analyst', SEAT_KEYS.reviewer, {
      memoryIdentityType: 'persona',
      memoryPersonaId: 'persona-reviewer',
      memoryPrincipalId: randomUUID(),
    }),
  ],
};

const PERSONA_REVIEWER: MemoryIdentity = { type: 'persona', id: 'persona-reviewer', personaId: 'persona-reviewer' };
const ROOM_OWNER: MemoryIdentity = { type: 'room_owner', id: ROOM_INSTANCE_ID };

/** The room's message list, which `appendRoomEvent` writes and `room_listen` reads. */
let messages: Message[] = [];
let appendFails = false;

/** What the stubbed MemoryService returns for the next write. */
let mutation: Record<string, unknown> = {};
/** What the stubbed MemoryReviewService.mentionReviewers returns, or throws. */
let mention: {
  mode: 'reviewers' | 'owner_fallback';
  recipients: MemoryIdentity[];
  reviewCode?: 'REVIEWER_UNAVAILABLE';
} | Error = { mode: 'reviewers', recipients: [PERSONA_REVIEWER] };

vi.mock('./_mcpRoomClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_mcpRoomClient.js')>();
  return {
    ...actual,
    createRemoteRoomClient: () => ({}),
    getRoom: async () => room,
    sweepRoom: async () => room,
    setListenUntil: async () => {},
    listMessages: async (_client: unknown, _code: string, since: number) => messages.slice(since),
    appendRoomEvent: async (_client: unknown, _code: string, message: Message) => {
      if (appendFails) throw new actual.RemoteRoomApiError('Room storage is unavailable.', 503, 'RoomNotFoundError');
      messages.push(message);
    },
  };
});

vi.mock('@agent-room/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-room/memory')>();
  return {
    ...actual,
    MemoryService: class {
      async createEntry() { return mutation; }
      async updateEntry() { return mutation; }
      async deleteEntry() { return mutation; }
    },
    MemoryReviewService: class {
      async mentionReviewers() {
        if (mention instanceof Error) throw mention;
        return {
          mode: mention.mode,
          ...(mention.reviewCode ? { reviewCode: mention.reviewCode } : {}),
          notifications: mention.recipients.map(recipient => ({
            kind: 'mention' as const,
            roomInstanceId: ROOM_INSTANCE_ID,
            proposalId: String(mutation.proposalId),
            recipient,
          })),
        };
      }
    },
  };
});

const repository = { close: async () => {} } as never;
const dependencies = {
  openRepository: async () => repository,
  redis: { sendCommand: async () => null },
};

const body = (result: { content: { type: string }[] }) =>
  JSON.parse((result.content[0] as unknown as { text: string }).text) as Record<string, any>;

async function invoke(name: string, args: Record<string, unknown>) {
  const { callTool } = await import('./_mcpTools.js');
  const client = { store: {}, post: async () => { throw new Error('no board'); } } as never;
  const result = await callTool(client, 'full', name, args, undefined, dependencies as never);
  if (name.startsWith('memory_')) {
    // Memory tools declare an object outputSchema: structuredContent must mirror the text payload.
    expect(result.structuredContent).toEqual(body(result as never));
  }
  return body(result as never);
}

const propose = (overrides: Record<string, unknown> = {}) => invoke('memory_write', {
  code: room.code,
  seatKey: SEAT_KEYS.proposer,
  scope: 'room',
  title: 'Shared decision',
  preview: 'The room keeps the shared index.',
  content: 'The room decided to retain the shared index.',
  searchText: 'shared-index-decision',
  requestId: `write-${randomUUID()}`,
  ...overrides,
});

const noticeTexts = () => messages
  .filter(message => message.text.includes('Memory review needed'))
  .map(message => message.text);

describe('shared memory proposals reach the reviewer through the room', () => {
  beforeEach(() => {
    process.env.MEMORY_ENABLED = 'true';
    process.env.MEMORY_DATABASE_URL = 'postgresql://memory-tools-test/none';
    messages = [{
      id: 1, type: 'msg', name: 'Host', initials: 'HO', color: '#000', role: 'host',
      text: 'Let us agree on the shared index.', client: 'web', time: 1,
    }];
    appendFails = false;
    mutation = { code: 'PENDING_REVIEW', proposalId: randomUUID() };
    mention = { mode: 'reviewers', recipients: [PERSONA_REVIEWER] };
  });

  it('appends exactly one room message that @-mentions the reviewer and carries the proposalId', async () => {
    const before = messages.length;
    const result = await propose();
    expect(result).toMatchObject({ code: 'PENDING_REVIEW', notificationDelivered: true });
    expect(messages).toHaveLength(before + 1);
    const posted = messages[before]!;
    expect(posted.type).toBe('sys');
    expect(posted.text).toContain('@Project Analyst');
    expect(posted.text).toContain(String(result.proposalId));
    expect(posted.text).toContain('(create)');
    expect(posted.text).toContain('Agent A proposes a shared room memory');
    expect(posted.text).toContain('memory_review({ action: "approve" | "reject"');
    // The seatKey that authorized the write, and the memory body, stay out of the room.
    expect(posted.text).not.toContain(SEAT_KEYS.proposer);
    expect(posted.text).not.toContain('The room decided to retain the shared index.');
  });

  it('keeps the existing notification fields the tool result already promised', async () => {
    mention = { mode: 'reviewers', recipients: [PERSONA_REVIEWER, { type: 'persona', id: 'persona-reviewer-2', personaId: 'persona-reviewer-2' }] };
    const result = await propose();
    expect(result.notification).toMatchObject({ kind: 'mention', recipient: PERSONA_REVIEWER });
    expect(result.notifications).toHaveLength(2);
    expect(result.reviewCode).toBeUndefined();
    // Only the seats this room can name get mentioned; persona-reviewer-2 has no seat here.
    expect(noticeTexts()[0]).toContain('@Project Analyst');
  });

  it('wakes a reviewer holding room_listen from a cursor before the proposal', async () => {
    const cursorBefore = messages.length;
    const proposal = await propose();
    const heard = await invoke('room_listen', {
      code: room.code, name: 'Project Analyst', since: cursorBefore, timeoutMs: 1500, wakeOn: 'addressed',
    });
    expect(heard.addressedYou).toBe(true);
    expect(heard.messages.map((message: { text: string }) => message.text).join('\n'))
      .toContain(String(proposal.proposalId));
  });

  // The proposal already exists; re-announcing it would wake every reviewer twice.
  it('posts nothing for a duplicate of a pending proposal', async () => {
    const first = await propose();
    const before = messages.length;
    mutation = { code: 'PENDING_REVIEW', proposalId: first.proposalId, duplicateOf: first.proposalId };
    const duplicate = await propose({ seatKey: SEAT_KEYS.proposer });
    expect(duplicate).toMatchObject({ code: 'PENDING_REVIEW', duplicateOf: first.proposalId });
    expect(duplicate.notificationDelivered).toBeUndefined();
    expect(messages).toHaveLength(before);
  });

  it('addresses the host when every reviewer seat is offline', async () => {
    mention = { mode: 'owner_fallback', recipients: [ROOM_OWNER], reviewCode: 'REVIEWER_UNAVAILABLE' };
    const result = await propose();
    expect(result).toMatchObject({ reviewCode: 'REVIEWER_UNAVAILABLE', notificationDelivered: true });
    const posted = noticeTexts()[0]!;
    expect(posted).toContain('@Host');
    expect(posted).toContain('No reviewer seat is online');
    expect(posted).not.toContain('@Project Analyst');
  });

  // A host who only ever spoke from the web has no `cc` seat to match on.
  it('falls back to the room creator when the owner identity has no seat', async () => {
    const host = room.participants[0]!;
    const { memoryIdentityType, memoryPrincipalId, memoryIsRoomOwner } = host;
    Object.assign(host, { memoryIdentityType: undefined, memoryPrincipalId: undefined, memoryIsRoomOwner: undefined });
    try {
      mention = { mode: 'owner_fallback', recipients: [ROOM_OWNER], reviewCode: 'REVIEWER_UNAVAILABLE' };
      expect((await propose()).notificationDelivered).toBe(true);
      expect(noticeTexts()[0]).toContain('@Host');
    } finally {
      Object.assign(host, { memoryIdentityType, memoryPrincipalId, memoryIsRoomOwner });
    }
  });

  it('posts nothing when no reviewer is configured at all', async () => {
    const { MemoryServiceError } = await import('@agent-room/memory');
    mention = new MemoryServiceError('REVIEW_REQUIRED');
    const before = messages.length;
    const result = await propose();
    expect(result).toMatchObject({ code: 'PENDING_REVIEW', reviewCode: 'REVIEW_REQUIRED' });
    expect(result.notificationDelivered).toBeUndefined();
    expect(messages).toHaveLength(before);
  });

  // The proposal is committed before we get here: a room that refuses the
  // message loses the wake, not the write.
  it('still returns the write when the append fails, reporting notificationDelivered false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      appendFails = true;
      const before = messages.length;
      const result = await propose();
      expect(result).toMatchObject({ code: 'PENDING_REVIEW', notificationDelivered: false });
      expect(result.proposalId).toBe(mutation.proposalId);
      expect(result.notification).toMatchObject({ kind: 'mention', recipient: PERSONA_REVIEWER });
      expect(messages).toHaveLength(before);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('posts one supersede room event mentioning the affected proposer', async () => {
    const { notifySupersededMemoryProposals } = await import('./_memoryTools.js');
    const winningProposalId = randomUUID();
    const supersededProposalId = randomUUID();
    const result = await notifySupersededMemoryProposals(
      {} as never,
      room.code,
      room,
      {
        supersededProposalNotices: async () => [{
          id: supersededProposalId,
          title: 'Shared decision',
          proposer: { type: 'persona', id: 'persona-alpha', personaId: 'persona-alpha' },
        }],
      } as never,
      winningProposalId,
      [supersededProposalId],
    );
    const event = messages.at(-1)!;
    expect(result).toBe(true);
    expect(messages.filter(message => message.text.includes('superseded'))).toHaveLength(1);
    expect(event.text).toContain('@Agent A');
    expect(event.text).toContain(supersededProposalId);
    expect(event.text).toContain(winningProposalId);
    expect(event.text).toContain('Re-propose against the latest version');
  });

  it('announces update and delete proposals with their own kind', async () => {
    await invoke('memory_update', {
      code: room.code, seatKey: SEAT_KEYS.proposer, scope: 'room', id: randomUUID(),
      preview: 'Updated shared preview', requestId: `update-${randomUUID()}`,
    });
    expect(noticeTexts()[0]).toContain('(update)');
    expect(noticeTexts()[0]).toContain('preview: "Updated shared preview".');

    mutation = { code: 'PENDING_REVIEW', proposalId: randomUUID() };
    await invoke('memory_delete', {
      code: room.code, seatKey: SEAT_KEYS.proposer, scope: 'room', id: randomUUID(),
      requestId: `delete-${randomUUID()}`,
    });
    expect(noticeTexts()[1]).toContain('(delete)');
    expect(noticeTexts()[1]).not.toContain('title:');
  });

  it('leaves completed writes alone — only pending proposals announce anything', async () => {
    mutation = { status: 'created', id: randomUUID(), version: 1 };
    const before = messages.length;
    const result = await propose({ scope: 'persona' });
    expect(result).toMatchObject({ status: 'created' });
    expect(result.notificationDelivered).toBeUndefined();
    expect(messages).toHaveLength(before);
  });
});
