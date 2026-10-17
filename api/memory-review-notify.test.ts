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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Participant, Room } from '@agent-room/shared';
import type { MemoryIdentity } from '@agent-room/memory';
type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

const ROOM_INSTANCE_ID = randomUUID();
const SUPERSEDED_PROPOSAL_ID = '00000000-0000-4000-8000-0000000000aa';
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
let appendCalls = 0;

/** What the stubbed MemoryService returns for the next write. */
let mutation: Record<string, unknown> = {};
/** What the stubbed MemoryReviewService.mentionReviewers returns, or throws. */
let mention: {
  mode: 'reviewers' | 'owner_fallback';
  recipients: MemoryIdentity[];
  reviewCode?: 'REVIEWER_UNAVAILABLE';
} | Error = { mode: 'reviewers', recipients: [PERSONA_REVIEWER] };
let reviewerSet: { mode: 'reviewers' | 'owner_fallback' | 'none'; reviewers: MemoryIdentity[]; offlineReviewers: MemoryIdentity[] } = {
  mode: 'reviewers', reviewers: [PERSONA_REVIEWER], offlineReviewers: [],
};
let systemReviewCalls: unknown[][] = [];

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
      appendCalls += 1;
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
      async review(_context: unknown, proposalId: unknown, decision: unknown, _requestId: unknown, reason: unknown) {
        return {
          status: decision === 'approve' ? 'approved' : 'rejected',
          proposalId,
          ...(decision === 'approve' ? { superseded: [SUPERSEDED_PROPOSAL_ID] } : {}),
          ...(decision === 'reject' ? { reason } : {}),
        };
      }
      async reviewAsSystem(...args: unknown[]) {
        systemReviewCalls.push(args);
        const [roomInstanceId, proposalId, decision, reason] = args;
        return {
          status: decision === 'approve' ? 'approved' : 'rejected',
          proposalId,
          ...(decision === 'reject' ? { reason } : {}),
          ...(roomInstanceId ? { version: 1 } : {}),
        };
      }
      async reviewerSetForProposal() { return reviewerSet; }
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
  openRepository: async () => ({
    ...repository,
    async getRoomProposal(_roomInstanceId: string, proposalId: string) {
      return {
        id: proposalId,
        room_instance_id: ROOM_INSTANCE_ID,
        action: 'create',
        target_memory_id: null,
        target_version: null,
        target_updated_at: null,
        payload: {
          title: '共享索引决定', preview: '房间保留共享索引。',
          content: '房间决定保留共享索引。', searchText: 'shared-index-decision',
        },
        proposer_persona_id: 'persona-alpha',
        proposer_identity_type: 'persona',
        proposer_identity_id: 'persona-alpha',
        status: 'pending',
        reviewer_identity_type: null,
        reviewer_identity_id: null,
        review_reason: null,
        request_id: 'write-test',
        created_at: new Date(0),
        reviewed_at: null,
      };
    },
    async readEntry() { return null; },
    async findRoomCreateDuplicateCandidates() { return []; },
  }),
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
const ZH = { title: '共享索引决定', preview: '房间保留共享索引。', content: '房间决定保留共享索引。' };

const noticeTexts = () => messages
  .filter(message => message.text.includes('Memory review needed'))
  .map(message => message.text);

describe('shared memory proposals reach the reviewer through the room', () => {
  beforeEach(() => {
    vi.stubEnv('MEMORY_ENABLED', 'true');
    vi.stubEnv('MEMORY_DATABASE_URL', 'postgresql://memory-tools-test/none');
    vi.stubEnv('JEV_API_KEY', '');
    vi.stubEnv('MEMORY_JEV_REVIEW', '');
    vi.stubEnv('MEMORY_DEDUP_VERIFIER', 'false');
    messages = [{
      id: 1, type: 'msg', name: 'Host', initials: 'HO', color: '#000', role: 'host',
      text: 'Let us agree on the shared index.', client: 'web', time: 1,
    }];
    appendCalls = 0;
    appendFails = false;
    mutation = { code: 'PENDING_REVIEW', proposalId: randomUUID() };
    mention = { mode: 'reviewers', recipients: [PERSONA_REVIEWER] };
    reviewerSet = { mode: 'reviewers', reviewers: [PERSONA_REVIEWER], offlineReviewers: [] };
    systemReviewCalls = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses Jev first, commits the decision, and posts no room message for an approval', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-je-v-key');
    reviewerSet = { mode: 'owner_fallback', reviewers: [ROOM_OWNER], offlineReviewers: [] };
    vi.stubGlobal('fetch', vi.fn<FetchArgs, Promise<Response>>(async () => new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        is_chinese: { type: 'noul', noul: 0.9 },
        durable: { type: 'noul', noul: 0.9 },
        concise: { type: 'noul', noul: 0.9 },
        named_rule: { type: 'noul', noul: 0.9 },
        already_known: { type: 'noul', noul: 0.1 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const result = await propose(ZH);
    expect(result).toMatchObject({
      code: 'APPROVED',
      status: 'approved',
      reviewer: 'jev',
      proposalId: mutation.proposalId,
    });
    expect(systemReviewCalls).toHaveLength(1);
    expect(mention instanceof Error).toBe(false);
    expect(messages.some(message => String(message.text).includes('记忆提议已通过'))).toBe(false);
    expect(messages.some(message => String(message.text).includes('记忆提议'))).toBe(false);
    expect(noticeTexts()).toHaveLength(0);
  });

  it('does not call Jev when an online reviewer role seat exists', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-je-v-key');
    const fetchMock = vi.fn<FetchArgs, Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
    const result = await propose();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(systemReviewCalls).toHaveLength(0);
    expect(result).toMatchObject({ code: 'PENDING_REVIEW', notificationDelivered: true });
  });

  it('does not call Jev when the reviewer role exists only on offline seats', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-je-v-key');
    reviewerSet = { mode: 'owner_fallback', reviewers: [ROOM_OWNER], offlineReviewers: [PERSONA_REVIEWER] };
    mention = { mode: 'owner_fallback', recipients: [ROOM_OWNER], reviewCode: 'REVIEWER_UNAVAILABLE' };
    const fetchMock = vi.fn<FetchArgs, Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
    const result = await propose();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ code: 'PENDING_REVIEW', notificationDelivered: true });
  });

  it('posts no room message when an agent reviewer approves', async () => {
    const before = messages.length;
    const result = await invoke('memory_review', {
      code: room.code,
      seatKey: SEAT_KEYS.reviewer,
      action: 'approve',
      proposalId: randomUUID(),
      requestId: 'agent-approve-1',
    });
    expect(result).toMatchObject({ status: 'approved' });
    expect(result).not.toHaveProperty('notificationDelivered');
    expect(messages.slice(before).some(message => String(message.text).includes('记忆提议'))).toBe(false);
  });

  it('returns the selected agent rejection reason and posts it to the proposer', async () => {
    const result = await invoke('memory_review', {
      code: room.code,
      seatKey: SEAT_KEYS.reviewer,
      action: 'reject',
      proposalId: randomUUID(),
      requestId: 'agent-reject-1',
      reason: '重复记忆',
    });
    expect(result).toMatchObject({ status: 'rejected', reason: '重复记忆', notificationDelivered: true });
    expect(messages.at(-1)?.text).toBe('@Agent A 记忆提议被驳回（重复记忆）：共享索引决定（审核员：Project Analyst）');
  });

  it.each([
    ['is_chinese', 0.49, '格式不合规'],
    ['durable', 0.59, '无关记忆'],
    ['concise', 0.49, '格式不合规'],
    ['named_rule', 0.49, '格式不合规'],
    ['already_known', 0.6, '重复记忆'],
  ] as const)('lets Jev reject a proposal with the required reason code', async (key, score, reason) => {
    vi.stubEnv('JEV_API_KEY', 'test-je-v-key');
    reviewerSet = { mode: 'owner_fallback', reviewers: [ROOM_OWNER], offlineReviewers: [] };
    const scores = { is_chinese: 0.9, durable: 0.9, concise: 0.9, named_rule: 0.9, already_known: 0.1, [key]: score };
    vi.stubGlobal('fetch', vi.fn<FetchArgs, Promise<Response>>(async () => new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: Object.fromEntries(Object.entries(scores).map(([id, noul]) => [id, { type: 'noul', noul }])),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const result = await propose(ZH);
    expect(result).toMatchObject({ code: 'REJECTED', status: 'rejected', reviewer: 'jev', reason });
    expect(messages.at(-1)?.text).toBe(`@Agent A 记忆提议被驳回（${reason}）：共享索引决定（审核员：Jev）`);
  });

  it('falls back to reviewer notifications after a Jev API error', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-je-v-key');
    reviewerSet = { mode: 'owner_fallback', reviewers: [ROOM_OWNER], offlineReviewers: [] };
    mention = { mode: 'owner_fallback', recipients: [ROOM_OWNER], reviewCode: 'REVIEWER_UNAVAILABLE' };
    vi.stubGlobal('fetch', vi.fn<FetchArgs, Promise<Response>>(async () => new Response('', { status: 429 })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await propose(ZH);
      expect(result).toMatchObject({ code: 'PENDING_REVIEW', reviewCode: 'REVIEWER_UNAVAILABLE', notificationDelivered: true });
      expect(systemReviewCalls).toHaveLength(0);
      expect(mention instanceof Error).toBe(false);
      expect(noticeTexts()).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith('Jev memory review failed; falling back to the existing review flow.');
    } finally {
      warn.mockRestore();
    }
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
    expect(posted.text).toContain('memory_review({ action: "approve"');
    expect(posted.text).toContain('"无关记忆" | "重复记忆" | "格式不合规"');
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
  it.each(['exact', 'near'] as const)('posts nothing for an %s duplicate of a pending proposal', async () => {
    const first = await propose();
    const before = messages.length;
    const appendsBefore = appendCalls;
    mutation = { code: 'PENDING_REVIEW', proposalId: first.proposalId, duplicateOf: first.proposalId };
    const duplicate = await propose({ seatKey: SEAT_KEYS.proposer });
    expect(duplicate).toMatchObject({ code: 'PENDING_REVIEW', duplicateOf: first.proposalId });
    expect(duplicate.notificationDelivered).toBeUndefined();
    expect(messages).toHaveLength(before);
    expect(appendCalls).toBe(appendsBefore);
  });

  it('posts nothing for a DUPLICATE of an approved entry', async () => {
    await propose();
    const before = messages.length;
    const appendsBefore = appendCalls;
    mutation = { code: 'DUPLICATE', duplicateOf: randomUUID(), duplicateKind: 'memory' };
    const duplicate = await propose();
    expect(duplicate).toMatchObject({ code: 'DUPLICATE', duplicateOf: mutation.duplicateOf });
    expect(duplicate.notificationDelivered).toBeUndefined();
    expect(messages).toHaveLength(before);
    expect(appendCalls).toBe(appendsBefore);
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

  it('posts no supersede room event when an approval replaces other pending proposals', async () => {
    const before = messages.length;
    const result = await invoke('memory_review', {
      code: room.code,
      seatKey: SEAT_KEYS.reviewer,
      action: 'approve',
      proposalId: randomUUID(),
      requestId: `approve-superseding-${randomUUID()}`,
    });
    expect(result).toMatchObject({ status: 'approved', superseded: [SUPERSEDED_PROPOSAL_ID] });
    expect(result).not.toHaveProperty('supersededNotificationDelivered');
    expect(messages.slice(before)).toHaveLength(0);
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
