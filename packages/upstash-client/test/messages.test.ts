import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, Room } from '@agent-room/shared';
import { MAX_MESSAGES_PER_ROOM, ROOM_TTL_SECONDS } from '@agent-room/shared';
import { appendSystemMessage, createClient, appendMessage, listMessages, NotApprovedError, NotParticipantError, NotYourTurnError, setMessageCommittedHook } from '../src/index.js';

const ENV = { url: 'https://example.upstash.io', token: 't' };
function mockResp(body: unknown) { return new Response(JSON.stringify(body)); }

/** The message JSON actually handed to RPUSH by the write pipeline. */
function pushedMessage(fetchMock: { mock: { calls: unknown[][] } }, callIndex: number): Message {
  const init = fetchMock.mock.calls[callIndex]![1] as { body: string };
  return JSON.parse(JSON.parse(init.body)[0][2]) as Message;
}

// `time` must sit inside the server's trust window or the write path restamps
// it — see normalizeMessageTime / the "stamps a server time" tests below.
const MSG: Message = {
  id: 1, type: 'msg', name: 'A', initials: 'AA', color: '#111',
  role: 'r', text: 'hi', client: 'web', time: Date.now(),
};

const APPROVED_ROOM: Room = {
  code: 'ABC-DEF-GHJ', topic: 't', createdAt: Date.now(), createdBy: 'host', status: 'active', version: 1,
  participants: [
    { name: 'A', role: 'r', color: '#111', initials: 'AA', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
  ],
};

describe('appendMessage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('RPUSHes + INCRs the absolute counter, LTRIMs to the cap, and pins TTL on both keys', async () => {
    const fetchMock = vi.fn()
      // First call: getRoom (speak gate check)
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(APPROVED_ROOM) }))
      // Second call: pipeline (RPUSH+INCR+LTRIM+EXPIREAT-LT×2)
      .mockResolvedValueOnce(mockResp([
        { result: 1 }, { result: 1 }, { result: 'OK' }, { result: 1 }, { result: 1 },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    await appendMessage(client, 'ABC-DEF-GHJ', MSG);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1]!; // pipeline call
    const cmds = JSON.parse((init as any).body);
    expect(cmds).toHaveLength(5);
    expect(cmds[0][0]).toBe('RPUSH');
    expect(cmds[0][1]).toBe('room-msgs:ABC-DEF-GHJ');
    // appendMessage enriches every message with reply-mode metadata. In an
    // 'open' room (legacy default) that's a fixed-shape stamp recording the
    // mode + role at send time. The original MSG fields must still all
    // be present, just with `metadata` added.
    expect(JSON.parse(cmds[0][2])).toEqual({
      ...MSG,
      metadata: {
        modeAtSend: 'open',
        roleAtSend: 'open',
        invocationType: 'normal_turn',
      },
    });
    expect(cmds[1][0]).toBe('INCR');
    expect(cmds[1][1]).toBe('room-msg-count:ABC-DEF-GHJ');
    expect(cmds[2][0]).toBe('LTRIM');
    expect(cmds[2][2]).toBe(-MAX_MESSAGES_PER_ROOM);
    expect(cmds[2][3]).toBe(-1);
    // EXPIREAT LT pins both keys to the fixed room deadline without extending
    // a key that already expires earlier.
    const expectedExpireAt = Math.floor(APPROVED_ROOM.createdAt / 1000) + ROOM_TTL_SECONDS;
    expect(cmds[3][0]).toBe('EXPIREAT');
    expect(cmds[3][1]).toBe('room-msgs:ABC-DEF-GHJ');
    expect(cmds[3][2]).toBe(expectedExpireAt);
    expect(cmds[3][3]).toBe('LT');
    expect(cmds[4][0]).toBe('EXPIREAT');
    expect(cmds[4][1]).toBe('room-msg-count:ABC-DEF-GHJ');
    expect(cmds[4][2]).toBe(expectedExpireAt);
    expect(cmds[4][3]).toBe('LT');
  });

  it('invokes the committed-message hook with the absolute index and ignores hook failures', async () => {
    const seen: { code: string; index: number }[] = [];
    setMessageCommittedHook(event => {
      seen.push({ code: event.code, index: event.index });
      throw new Error('hook down');
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(APPROVED_ROOM) }))
      .mockResolvedValueOnce(mockResp([
        { result: 1 }, { result: 8 }, { result: 'OK' }, { result: 1 }, { result: 1 },
      ])));
    try {
      await expect(appendMessage(createClient(ENV), 'ABC-DEF-GHJ', MSG)).resolves.toMatchObject({ appended: true });
      expect(seen).toEqual([{ code: 'ABC-DEF-GHJ', index: 7 }]);
    } finally {
      setMessageCommittedHook(undefined);
    }
  });

  it('refuses writes when the room retention deadline has passed', async () => {
    const expiredRoom = {
      ...APPROVED_ROOM,
      createdAt: Date.now() - (ROOM_TTL_SECONDS + 1) * 1000,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResp({ result: JSON.stringify(expiredRoom) }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    await expect(appendMessage(client, 'ABC-DEF-GHJ', MSG)).rejects.toMatchObject({ name: 'UpstashError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coerces a missing text field to "" before persisting', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(APPROVED_ROOM) }))
      .mockResolvedValueOnce(mockResp([
        { result: 1 }, { result: 1 }, { result: 'OK' }, { result: 1 }, { result: 1 },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const { text: _dropped, ...textless } = MSG;
    const client = createClient(ENV);
    await appendMessage(client, 'ABC-DEF-GHJ', textless as Message);

    const [, init] = fetchMock.mock.calls[1]!;
    const cmds = JSON.parse((init as any).body);
    expect(JSON.parse(cmds[0][2]).text).toBe('');
  });

  // Regression: /api/room accepted a send with no `time` (old clients omit it
  // entirely), the message was stored without one, and every web bubble that
  // rendered it printed "Invalid Date". The server is the clock now.
  it('stamps a server time when the client sent none (open mode)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(APPROVED_ROOM) }))
      .mockResolvedValueOnce(mockResp([
        { result: 1 }, { result: 1 }, { result: 'OK' }, { result: 1 }, { result: 1 },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const { time: _dropped, ...timeless } = MSG;
    const before = Date.now();
    const client = createClient(ENV);
    await appendMessage(client, 'ABC-DEF-GHJ', timeless as Message);

    const stored = pushedMessage(fetchMock, 1);
    expect(typeof stored.time).toBe('number');
    expect(stored.time).toBeGreaterThanOrEqual(before);
    expect(stored.time).toBeLessThanOrEqual(Date.now());
  });

  it('restamps a client time that is nowhere near the server clock', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(APPROVED_ROOM) }))
      .mockResolvedValueOnce(mockResp([
        { result: 1 }, { result: 1 }, { result: 'OK' }, { result: 1 }, { result: 1 },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const before = Date.now();
    const client = createClient(ENV);
    await appendMessage(client, 'ABC-DEF-GHJ', { ...MSG, time: 9_999_999_999_999 });

    expect(pushedMessage(fetchMock, 1).time).toBeGreaterThanOrEqual(before);
  });

  it('throws NotApprovedError when the sender is pending host approval', async () => {
    const pendingRoom: Room = {
      ...APPROVED_ROOM,
      participants: [
        { ...APPROVED_ROOM.participants[0]!, canSpeak: false },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp({ result: JSON.stringify(pendingRoom) })));
    const client = createClient(ENV);
    await expect(appendMessage(client, 'ABC-DEF-GHJ', MSG)).rejects.toBeInstanceOf(NotApprovedError);
  });

  // A sender with no seat was told the host had muted them, which sent agents
  // into a wait that nothing could end. They are not muted; they never joined.
  it('throws NotParticipantError when the sender is not in the participants list', async () => {
    const emptyRoom: Room = { ...APPROVED_ROOM, participants: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp({ result: JSON.stringify(emptyRoom) })));
    const client = createClient(ENV);
    const error = await appendMessage(client, 'ABC-DEF-GHJ', MSG).catch(e => e);
    expect(error).toBeInstanceOf(NotParticipantError);
    expect(error).not.toBeInstanceOf(NotApprovedError);
    expect(error.message).toContain('join it before sending messages');
  });

  // Same name, wrong client: the web seat does not let an agent speak as itself.
  it('throws NotParticipantError when only the other client kind holds the seat', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp({ result: JSON.stringify(APPROVED_ROOM) })));
    const client = createClient(ENV);
    await expect(appendMessage(client, 'ABC-DEF-GHJ', { ...MSG, client: 'cc' }))
      .rejects.toBeInstanceOf(NotParticipantError);
  });
});

describe('appendMessage — moderator-mode status updates', () => {
  beforeEach(() => vi.restoreAllMocks());

  const FAR_FUTURE = 9_999_999_999_999;

  // A moderator-mode room with a Moderator agent and a non-moderator worker
  // agent. Both are approved cc-client participants.
  const MOD_ROOM: Room = {
    code: 'MOD-ROO-M01', topic: 't', createdAt: Date.now(), createdBy: 'host',
    status: 'active', version: 1,
    replyMode: 'moderator',
    modeConfig: { moderatorAgentName: 'Mod', moderatorAgentClient: 'cc' },
    participants: [
      { name: 'host', role: '', color: '#111', initials: 'HO', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
      { name: 'Mod', role: '', color: '#222', initials: 'MO', client: 'cc', joinedAt: 10, lastSeenAt: 10, canSpeak: true },
      { name: 'Worker', role: '', color: '#333', initials: 'WO', client: 'cc', joinedAt: 20, lastSeenAt: 20, canSpeak: true },
    ],
  };

  // Active moderator turn — the Moderator holds the floor.
  const MOD_TURN = {
    turnId: 7777, mode: 'moderator',
    moderatorName: 'Mod', moderatorClient: 'cc',
    currentName: 'Mod', currentClient: 'cc', currentRole: 'moderator',
    deadline: FAR_FUTURE, queue: [], spoken: [],
  };

  const WORKER_MSG: Message = {
    id: 5, type: 'msg', name: 'Worker', initials: 'WO', color: '#333',
    role: '', text: '收到，正在做', client: 'cc', time: 5,
  };

  it('lets a non-moderator agent post a status update without holding the turn', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(MOD_ROOM) }))      // getRoom
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(MOD_TURN) }))      // getTurnState
      .mockResolvedValueOnce(mockResp({ result: 'OK' }))                          // setTurnState
      .mockResolvedValueOnce(mockResp([                                          // rpush pipeline
        { result: 1 }, { result: 1 }, { result: 'OK' }, { result: 1 }, { result: 1 },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const result = await appendMessage(client, 'MOD-ROO-M01', WORKER_MSG);

    // The message is appended (not swallowed) and tagged as a status update.
    expect(result.appended).toBe(true);
    expect(result.metadata).toEqual({
      modeAtSend: 'moderator',
      roleAtSend: 'status',
      invocationType: 'status_update',
      turnId: 7777,
    });

    // The RPUSHed message carries the same status-update metadata.
    const pipelineCall = fetchMock.mock.calls[3]!;
    const cmds = JSON.parse((pipelineCall[1] as any).body);
    expect(cmds[0][0]).toBe('RPUSH');
    expect(JSON.parse(cmds[0][2]).metadata).toEqual({
      modeAtSend: 'moderator',
      roleAtSend: 'status',
      invocationType: 'status_update',
      turnId: 7777,
    });

    // The turn state written back is UNCHANGED — the Moderator still holds
    // the floor; a status update never consumes a turn slot.
    const setCall = fetchMock.mock.calls[2]!;
    const setCmd = JSON.parse((setCall[1] as any).body);
    expect(setCmd[0]).toBe('SET');
    const persistedTurn = JSON.parse(setCmd[2]);
    expect(persistedTurn.currentName).toBe('Mod');
    expect(persistedTurn.currentRole).toBe('moderator');
    expect(persistedTurn.queue).toEqual([]);
    expect(persistedTurn.spoken).toEqual([]);
  });

  it('still gates non-current agents in sequential mode (status channel is moderator-only)', async () => {
    const seqRoom: Room = {
      ...MOD_ROOM, code: 'SEQ-ROO-M01', replyMode: 'sequential',
      modeConfig: { leadAgentName: 'Mod', leadAgentClient: 'cc' },
    };
    const seqTurn = {
      turnId: 8888, mode: 'sequential',
      leadName: 'Mod', leadClient: 'cc',
      currentName: 'Mod', currentClient: 'cc', currentRole: 'lead',
      deadline: FAR_FUTURE, leadGraceUntil: FAR_FUTURE, queue: [], spoken: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(seqRoom) }))   // getRoom
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(seqTurn) }));  // getTurnState
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    await expect(
      appendMessage(client, 'SEQ-ROO-M01', { ...WORKER_MSG }),
    ).rejects.toBeInstanceOf(NotYourTurnError);
  });
});

describe('appendMessage — sequential status heartbeat', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renews the current sequential speaker deadline on a kind=status ping', async () => {
    const now = Date.now();
    const seqRoom: Room = {
      code: 'SEQ-HBT-001', topic: 't', createdAt: Date.now(), createdBy: 'host',
      status: 'active', version: 1,
      replyMode: 'sequential',
      modeConfig: { leadAgentName: 'Lead', leadAgentClient: 'cc' },
      participants: [
        { name: 'host', role: '', color: '#111', initials: 'HO', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
        { name: 'Lead', role: '', color: '#222', initials: 'LE', client: 'cc', joinedAt: 10, lastSeenAt: 10, canSpeak: true },
      ],
    };
    // Lead is the current speaker with a deadline that's still in the future
    // (so advanceOnTimeout doesn't skip them before the heartbeat is seen).
    const seqTurn = {
      turnId: 5000, mode: 'sequential',
      leadName: 'Lead', leadClient: 'cc',
      currentName: 'Lead', currentClient: 'cc', currentRole: 'lead',
      deadline: now + 5_000, hardDeadline: now + 600_000, queue: [], spoken: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(seqRoom) }))   // getRoom
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(seqTurn) }))   // getTurnState
      .mockResolvedValueOnce(mockResp({ result: 'OK' }))                      // setTurnState
      .mockResolvedValueOnce(mockResp([
        { result: 1 }, { result: 1 }, { result: 'OK' }, { result: 1 }, { result: 1 },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const leadMsg: Message = {
      id: 5, type: 'msg', name: 'Lead', initials: 'LE', color: '#222',
      role: '', text: 'still running the build', client: 'cc', time: 5,
    };
    const result = await appendMessage(client, 'SEQ-HBT-001', leadMsg, 'status');

    // The ping is appended as a status message and flagged as a renewal.
    expect(result.appended).toBe(true);
    expect(result.metadata.roleAtSend).toBe('status');
    expect(result.metadata.invocationType).toBe('status_update');
    expect(result.metadata.extendsTurn).toBe(true);

    // The turn did NOT advance — Lead keeps the floor, queue/spoken untouched
    // — and the deadline was pushed forward by the heartbeat.
    const setCmd = JSON.parse((fetchMock.mock.calls[2]![1] as any).body);
    expect(setCmd[0]).toBe('SET');
    const persisted = JSON.parse(setCmd[2]);
    expect(persisted.currentName).toBe('Lead');
    expect(persisted.currentRole).toBe('lead');
    expect(persisted.spoken).toEqual([]);
    expect(persisted.deadline).toBeGreaterThan(seqTurn.deadline);
  });
});

// The turn-taking path and the system-event path do their own RPUSH calls.
// Both funnel through rpushMessage, so neither can store a timeless message.
describe('message time is stamped on every write path', () => {
  beforeEach(() => vi.restoreAllMocks());

  const SEQ_ROOM: Room = {
    code: 'SEQ-TIM-001', topic: 't', createdAt: Date.now(), createdBy: 'host',
    status: 'active', version: 1,
    replyMode: 'sequential',
    modeConfig: { leadAgentName: 'Lead', leadAgentClient: 'cc' },
    participants: [
      { name: 'host', role: '', color: '#111', initials: 'HO', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
      { name: 'Lead', role: '', color: '#222', initials: 'LE', client: 'cc', joinedAt: 10, lastSeenAt: 10, canSpeak: true },
    ],
  };

  it('sequential mode: a lead reply with no time is stored with a server time', async () => {
    const now = Date.now();
    const seqTurn = {
      turnId: 6000, mode: 'sequential',
      leadName: 'Lead', leadClient: 'cc',
      currentName: 'Lead', currentClient: 'cc', currentRole: 'lead',
      deadline: now + 5_000, hardDeadline: now + 600_000, queue: [], spoken: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(SEQ_ROOM) }))  // getRoom
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(seqTurn) }))   // getTurnState
      .mockResolvedValueOnce(mockResp({ result: 'OK' }))                      // setTurnState
      .mockResolvedValueOnce(mockResp([
        { result: 1 }, { result: 1 }, { result: 'OK' }, { result: 1 }, { result: 1 },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    await appendMessage(client, 'SEQ-TIM-001', {
      id: 7, type: 'msg', name: 'Lead', initials: 'LE', color: '#222',
      role: '', text: 'done', client: 'cc',
    } as Message);

    const stored = pushedMessage(fetchMock, 3);
    expect(Number.isFinite(stored.time)).toBe(true);
    expect(stored.time).toBeGreaterThanOrEqual(now);
  });

  it('a system message with no time gets one', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(APPROVED_ROOM) }))
      .mockResolvedValueOnce(mockResp([
        { result: 1 }, { result: 1 }, { result: 'OK' }, { result: 1 }, { result: 1 },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const before = Date.now();
    const client = createClient(ENV);
    await appendSystemMessage(client, 'ABC-DEF-GHJ', {
      id: 99, type: 'sys', name: 'system', initials: 'AR', color: '#5B6AFF',
      role: 'System', text: 'reply mode changed', client: 'cc',
    } as Message);

    const stored = pushedMessage(fetchMock, 1);
    expect(typeof stored.time).toBe('number');
    expect(stored.time).toBeGreaterThanOrEqual(before);
  });
});

describe('listMessages', () => {
  beforeEach(() => vi.restoreAllMocks());

  // Helper: mock the GET-count + LLEN pipeline that listMessages issues first,
  // then the LRANGE that follows.
  function mockListMessagesFlow(opts: {
    countRaw: string | number | null;
    listLen: number;
    rangeResult: string[];
  }) {
    return vi.fn()
      .mockResolvedValueOnce(mockResp([
        { result: opts.countRaw },
        { result: opts.listLen },
      ]))
      .mockResolvedValueOnce(mockResp({ result: opts.rangeResult }));
  }

  it('uses GET-count + LLEN to compute LRANGE start, then parses the range', async () => {
    const msg1: Message = { id: 1, type: 'msg', name: 'A', initials: 'AA', color: '#111', role: '', text: 'hi', client: 'web', time: 1 };
    const msg2: Message = { ...msg1, id: 2, text: 'yo' };
    // Room has 7 messages ever appended, list currently holds 7 (no LTRIM yet).
    // Caller's cursor=5 → start = 5 - (7 - 7) = 5.
    const fetchMock = mockListMessagesFlow({
      countRaw: '7',
      listLen: 7,
      rangeResult: [JSON.stringify(msg1), JSON.stringify(msg2)],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const got = await listMessages(client, 'ABC-DEF-GHJ', 5);
    expect(got.messages).toEqual([msg1, msg2]);
    expect(got.cursor).toBe(7);
    expect(got.oldestRetained).toBe(0);

    // Sanity: the LRANGE call we issued used start=5, end=-1.
    const [, rangeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse((rangeInit as any).body)).toEqual(['LRANGE', 'room-msgs:ABC-DEF-GHJ', 5, -1]);
  });

  it('returns [] when the list is empty (skips LRANGE entirely)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp([{ result: null }, { result: 0 }]));
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient(ENV);
    expect(await listMessages(client, 'ABC-DEF-GHJ', 0)).toEqual({ messages: [], cursor: 0, oldestRetained: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // metadata only, no LRANGE
  });

  it('heals a stored message with no text (crashed every web viewer of the room)', async () => {
    // Regression: an older MCP client posted a status_update with no `text`
    // field. Persisted verbatim, it crashed the room page for every viewer
    // ("Cannot read properties of undefined (reading 'length')" in Bubble).
    const { text: _dropped, ...textless } = MSG;
    const fetchMock = mockListMessagesFlow({
      countRaw: '1',
      listLen: 1,
      rangeResult: [JSON.stringify(textless)],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const got = await listMessages(client, 'ABC-DEF-GHJ', 0);
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0]!.text).toBe('');
    expect(got.cursor).toBe(1);
    expect(got.oldestRetained).toBe(0);
  });

  it('legacy room (no count key): falls back to using fromIndex as a list-index', async () => {
    // Pre-fix room — counter never INCRed. listMessages must not break, just
    // behave like the old code would (LRANGE fromIndex -1).
    const fetchMock = mockListMessagesFlow({
      countRaw: null,
      listLen: 100,
      rangeResult: [],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const got = await listMessages(client, 'XYZ-123-ABC', 42);
    expect(got.cursor).toBe(100);
    expect(got.oldestRetained).toBe(0);

    const [, rangeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse((rangeInit as any).body)).toEqual(['LRANGE', 'room-msgs:XYZ-123-ABC', 42, -1]);
  });

  // Regression test for the LTRIM cursor-drift bug. Before the fix:
  //   list had 999 entries → +2 RPUSH → list=1001 → LTRIM keeps last 1000
  //   → first new message is now at index 998, second at 999
  //   → an agent at cursor=999 LRANGE 999 -1 returns ONE message instead of two
  //   → first new message silently lost
  // After the fix the counter compensates the offset and the agent gets BOTH.
  it('LTRIM cursor-drift regression: returns ALL unread messages even after head was trimmed', async () => {
    const newMsg1: Message = { id: 9001, type: 'msg', name: 'A', initials: 'AA', color: '#111', role: '', text: 'first-new', client: 'web', time: 9001 };
    const newMsg2: Message = { ...newMsg1, id: 9002, text: 'second-new', time: 9002 };

    // totalCount = 1001 (999 old + 2 new), listLen = 1000 (LTRIM dropped 1 head entry).
    // Caller's cursor = 999 (had read all 999 originals).
    // Correct start = 999 - (1001 - 1000) = 998. LRANGE 998 -1 → both new messages.
    const fetchMock = mockListMessagesFlow({
      countRaw: '1001',
      listLen: 1000,
      rangeResult: [JSON.stringify(newMsg1), JSON.stringify(newMsg2)],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const got = await listMessages(client, 'ABC-DEF-GHJ', 999);

    expect(got.messages).toEqual([newMsg1, newMsg2]); // would have been [newMsg2] under the old code
    expect(got.cursor).toBe(1001);
    expect(got.oldestRetained).toBe(1);

    const [, rangeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse((rangeInit as any).body)).toEqual(['LRANGE', 'room-msgs:ABC-DEF-GHJ', 998, -1]);
  });

  it('cursor far behind LTRIM horizon: clamps start to 0 and hands back surviving prefix', async () => {
    // Cursor 50 but 200 head entries have already been LTRIMmed away. start
    // would be 50 - 200 = -150, which we clamp to 0. The very-old messages
    // are unrecoverable (LTRIM is destructive — see msgsKey comment).
    const fetchMock = mockListMessagesFlow({
      countRaw: '1200',
      listLen: 1000,
      rangeResult: [],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const got = await listMessages(client, 'ABC-DEF-GHJ', 50);
    expect(got.cursor).toBe(1200);
    expect(got.oldestRetained).toBe(200);

    const [, rangeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse((rangeInit as any).body)).toEqual(['LRANGE', 'room-msgs:ABC-DEF-GHJ', 0, -1]);
  });

  it('room with 1200 messages: returns cursor 1200 and oldestRetained 200 when since is in trimmed range', async () => {
    // 1200 messages total, cap=1000, 200 trimmed.
    // list has 1000 messages (representing message 200 to 1199).
    const msg200: Message = { id: 200, type: 'msg', name: 'A', initials: 'AA', color: '#111', role: '', text: 'msg-200', client: 'web', time: 200 };
    const msg1199: Message = { id: 1199, type: 'msg', name: 'B', initials: 'BB', color: '#222', role: '', text: 'msg-1199', client: 'web', time: 1199 };
    const fetchMock = mockListMessagesFlow({
      countRaw: '1200',
      listLen: 1000,
      rangeResult: [JSON.stringify(msg200), JSON.stringify(msg1199)],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    // Caller asks since 150 (inside trimmed range 0..199)
    const got = await listMessages(client, 'ABC-DEF-GHJ', 150);

    expect(got.cursor).toBe(1200);
    expect(got.oldestRetained).toBe(200);
    expect(got.messages[0]).toEqual(msg200);
    expect(got.messages[1]).toEqual(msg1199);

    // Sanity: start clamped to 0
    const [, rangeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse((rangeInit as any).body)).toEqual(['LRANGE', 'room-msgs:ABC-DEF-GHJ', 0, -1]);
  });

  it('cursor at or past totalCount: skips LRANGE and returns []', async () => {
    // start = 1200 - (1200 - 1000) = 1000; listLen = 1000 → start >= listLen → [].
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp([{ result: '1200' }, { result: 1000 }]));
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient(ENV);
    expect(await listMessages(client, 'ABC-DEF-GHJ', 1200)).toEqual({ messages: [], cursor: 1200, oldestRetained: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no LRANGE issued
  });
});
