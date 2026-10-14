import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { AVATAR_PALETTE, ROOM_TTL_SECONDS, type Room } from '@agent-room/shared';
import { createClient, createRoom, getRoom, RoomNotFoundError, casRoom, ConcurrencyError, joinRoom, InterviewRoomBusyError, setListenUntil, updatePresence, removeParticipant, endRoom } from '../src/index.js';

const ENV = { url: 'https://example.upstash.io', token: 't' };

function mockResp(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

function installRoomRedis(initial: Room) {
  let raw = JSON.stringify(initial);
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as string[];
    if (command[0] === 'GET') return mockResp({ result: raw });
    if (command[0] === 'SET') {
      raw = command[2]!;
      return mockResp({ result: 'OK' });
    }
    if (command[0] === 'EVAL') {
      if (raw !== command[4]) return mockResp({ result: 0 });
      raw = command[5]!;
      return mockResp({ result: 1 });
    }
    throw new Error(`Unexpected Redis command: ${command[0]}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    client: createClient(ENV),
    fetchMock,
    readRoom: () => JSON.parse(raw) as Room,
  };
}

describe('setListenUntil', () => {
  afterEach(() => vi.useRealTimers());

  const now = 1_800_000_000_000;
  const roomWith = (status: Room['status'] = 'active', participants: Room['participants'] = []): Room => ({
    code: 'ABC-DEF-GHJ', topic: 'presence', createdAt: now, createdBy: 'Host', status, version: 1, participants,
  });
  const agent = (name = 'Codex') => ({
    name, role: '', color: '#000', initials: 'CO', client: 'cc' as const,
    joinedAt: now, lastSeenAt: now,
  });

  it('does not let an older overlapping listener release a newer lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const redis = installRoomRedis(roomWith('active', [agent()]));

    await setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', now + 15_000, 'old-listen');
    vi.setSystemTime(now + 1_000);
    await setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', now + 16_000, 'new-listen');
    const lastSeenAt = redis.readRoom().participants[0]!.lastSeenAt;

    await setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', null);
    await setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', null, 'old-listen');
    expect(redis.readRoom().participants[0]).toMatchObject({
      listenUntil: now + 16_000,
      listenLeases: { 'new-listen': now + 16_000 },
      lastSeenAt,
    });
    expect(redis.fetchMock.mock.calls.every(([, init]) => {
      const command = JSON.parse(String(init?.body)) as string[];
      return command[0] !== 'EVAL' || (command[1]!.includes('AR11 listen-presence CAS') && command[1]!.includes("'KEEPTTL'"));
    })).toBe(true);

    vi.setSystemTime(now + 2_000);
    await setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', null, 'new-listen');
    expect(redis.readRoom().participants[0]).toMatchObject({
      listenUntil: now + 2_000,
      lastSeenAt,
    });
    expect(redis.readRoom().participants[0]!.listenLeases).toBeUndefined();
  });

  it('keeps the older listener live when the newer overlapping listener ends first', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const redis = installRoomRedis(roomWith('active', [agent()]));
    await setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', now + 15_000, 'old-listen');
    vi.setSystemTime(now + 1_000);
    await setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', now + 16_000, 'new-listen');
    const lastSeenAt = redis.readRoom().participants[0]!.lastSeenAt;

    await setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', null, 'new-listen');
    expect(redis.readRoom().participants[0]).toMatchObject({
      listenUntil: now + 15_000,
      listenLeases: { 'old-listen': now + 15_000 },
      lastSeenAt,
    });
  });

  it('preserves a legacy scalar lease while a new-format listener releases', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const redis = installRoomRedis(roomWith('active', [{ ...agent(), listenUntil: now + 10_000 }]));

    await setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', now + 15_000, 'new-listen');
    vi.setSystemTime(now + 1_000);
    await setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', null, 'new-listen');

    expect(redis.readRoom().participants[0]).toMatchObject({
      listenUntil: now + 10_000,
      listenLeases: { legacy: now + 10_000 },
    });
  });

  it('updates only the Agent seat with the matching name', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const webSeat = { ...agent('Same name'), client: 'web' as const, listenUntil: undefined };
    const redis = installRoomRedis(roomWith('active', [webSeat, agent('Same name')]));

    await setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Same name', now + 15_000, 'agent-listen');
    const [web, cc] = redis.readRoom().participants;
    expect(web!.listenUntil).toBeUndefined();
    expect(cc!.listenLeases).toEqual({ 'agent-listen': now + 15_000 });
  });

  it('retries a conflicting room write so a delayed release cannot erase a newer lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const redis = installRoomRedis(roomWith('active', [agent()]));
    await setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', now + 15_000, 'old-listen');

    await Promise.all([
      setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', null, 'old-listen'),
      setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', now + 16_000, 'new-listen'),
    ]);

    expect(redis.readRoom().participants[0]).toMatchObject({
      listenUntil: now + 16_000,
      listenLeases: { 'new-listen': now + 16_000 },
    });
  });

  it('preserves two different Agent leases written concurrently', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const redis = installRoomRedis(roomWith('active', [agent('Agent A'), agent('Agent B')]));

    await Promise.all([
      setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Agent A', now + 15_000, 'lease-a'),
      setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Agent B', now + 15_000, 'lease-b'),
    ]);

    expect(redis.readRoom().participants.map(p => p.listenLeases)).toEqual([
      { 'lease-a': now + 15_000 },
      { 'lease-b': now + 15_000 },
    ]);
  });

  it('keeps a Web heartbeat and Agent lease when their room writes race', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const host = { ...agent('Host'), client: 'web' as const };
    const redis = installRoomRedis(roomWith('active', [host, agent('Codex')]));

    await Promise.all([
      updatePresence(redis.client, 'ABC-DEF-GHJ', 'Host', now + 1000),
      setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', now + 15_000, 'agent-listen'),
    ]);

    const current = redis.readRoom().participants;
    expect(current.find(p => p.name === 'Host')!.lastSeenAt).toBe(now + 1000);
    expect(current.find(p => p.name === 'Codex')!.listenLeases).toEqual({ 'agent-listen': now + 15_000 });
  });

  it('does not recreate a participant when removal races a late listener stamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const redis = installRoomRedis(roomWith('active', [agent()]));

    await Promise.all([
      removeParticipant(redis.client, 'ABC-DEF-GHJ', 'Codex', 'Codex', 'cc'),
      setListenUntil(redis.client, 'ABC-DEF-GHJ', 'Codex', now + 15_000, 'late-listen'),
    ]);

    expect(redis.readRoom().participants).toEqual([]);
  });

  it('does not restore a lease after the room ended or the member was removed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const ended = installRoomRedis(roomWith('active', [{
      ...agent(), listenUntil: now + 10_000, listenLeases: { 'current-listen': now + 10_000 },
    }]));
    await endRoom(ended.client, 'ABC-DEF-GHJ');
    expect(ended.readRoom().participants[0]!.listenLeases).toBeUndefined();
    await setListenUntil(ended.client, 'ABC-DEF-GHJ', 'Codex', now + 15_000, 'late-stamp');
    await setListenUntil(ended.client, 'ABC-DEF-GHJ', 'Codex', null, 'current-listen');
    expect(ended.readRoom().participants[0]!.listenUntil).toBe(now);
    expect(ended.readRoom().participants[0]!.listenLeases).toBeUndefined();

    const removed = installRoomRedis(roomWith('active'));
    await setListenUntil(removed.client, 'ABC-DEF-GHJ', 'Codex', now + 15_000, 'late-stamp');
    expect(removed.readRoom().participants).toEqual([]);
  });
});

describe('createRoom', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('stores a room JSON under the given code with a seven-day TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResp({ result: 'OK' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const room = await createRoom(client, {
      code: 'ABC-DEF-GHJ',
      topic: 'Q3',
      createdBy: 'Alex',
      ownerId: 'user_123',
      ownerEmail: 'alex@example.com',
      ownerName: 'Alex Host',
    });

    expect(room.code).toBe('ABC-DEF-GHJ');
    expect(room.ownerId).toBe('user_123');
    expect(room.version).toBe(1);
    expect(room.participants).toEqual([]);

    const [, init] = fetchMock.mock.calls[0]!;
    const cmd = JSON.parse((init as any).body);
    expect(cmd[0]).toBe('SET');
    expect(cmd[1]).toBe('room:ABC-DEF-GHJ');
    const stored = JSON.parse(cmd[2]);
    expect(stored.topic).toBe('Q3');
    expect(stored.ownerId).toBe('user_123');
    expect(stored.ownerEmail).toBe('alex@example.com');
    expect(stored.ownerName).toBe('Alex Host');
    expect(cmd).toContain('EX');
    expect(cmd).toContain(ROOM_TTL_SECONDS);
    expect(ROOM_TTL_SECONDS).toBe(604800);
  });
});

describe('getRoom', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns parsed Room when present', async () => {
    const room: Room = {
      code: 'ABC-DEF-GHJ',
      topic: 'Q3',
      createdAt: 1,
      createdBy: 'Alex',
      status: 'active',
      version: 2,
      participants: [],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp({ result: JSON.stringify(room) })));
    const client = createClient(ENV);
    const fetched = await getRoom(client, 'ABC-DEF-GHJ');
    expect(fetched).toEqual(room);
  });

  it('throws RoomNotFoundError when key is missing (result is null)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp({ result: null })));
    const client = createClient(ENV);
    await expect(getRoom(client, 'MIS-SIN-GXY')).rejects.toBeInstanceOf(RoomNotFoundError);
  });
});

describe('casRoom', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('writes when the current version matches', async () => {
    const base: Room = { code: 'A', topic: 't', createdAt: 0, createdBy: 'x', status: 'active', version: 3, participants: [] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(base) }))             // GET
      .mockResolvedValueOnce(mockResp({ result: 'OK' }));                            // SET

    vi.stubGlobal('fetch', fetchMock);
    const client = createClient(ENV);
    const updated = await casRoom(client, 'A', current => ({ ...current, topic: 'changed' }));

    expect(updated.topic).toBe('changed');
    expect(updated.version).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toEqual([
      'SET', 'room:A', expect.any(String), 'KEEPTTL',
    ]);
  });

  it('retries when mutator throws ConcurrencyError and succeeds on a later attempt', async () => {
    const v3: Room = { code: 'A', topic: 't', createdAt: 0, createdBy: 'x', status: 'active', version: 3, participants: [] };
    const v4: Room = { ...v3, version: 4 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(v3) }))    // GET #1
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(v4) }))    // GET #2
      .mockResolvedValueOnce(mockResp({ result: 'OK' }));                 // SET
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient(ENV);

    let attempts = 0;
    const updated = await casRoom(client, 'A', current => {
      attempts++;
      if (attempts === 1) throw new ConcurrencyError();
      return { ...current, topic: `attempt${attempts}` };
    });
    expect(updated.topic).toBe('attempt2');
    expect(updated.version).toBeGreaterThanOrEqual(4);
    expect(attempts).toBe(2);
  });

  it('throws ConcurrencyError after 3 failed attempts', async () => {
    const v3: Room = { code: 'A', topic: 't', createdAt: 0, createdBy: 'x', status: 'active', version: 3, participants: [] };
    const fetchMock = vi.fn().mockResolvedValue(mockResp({ result: JSON.stringify(v3) }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient(ENV);

    let calls = 0;
    await expect(casRoom(client, 'A', () => {
      calls++;
      throw new ConcurrencyError();
    })).rejects.toBeInstanceOf(ConcurrencyError);
    expect(calls).toBe(3);
  });
});

describe('joinRoom', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('appends a participant and bumps version', async () => {
    const before: Room = { code: 'A', topic: 't', createdAt: 0, createdBy: 'x', status: 'active', version: 1, participants: [] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(before) }))
      .mockResolvedValueOnce(mockResp({ result: 'OK' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const updated = await joinRoom(client, 'A', {
      name: 'Sarah', role: 'PM', color: '#EC4899', initials: 'SK', client: 'web',
      joinedAt: 100, lastSeenAt: 100,
    });

    expect(updated.participants).toHaveLength(1);
    expect(updated.participants[0]!.name).toBe('Sarah');
    expect(updated.participant.name).toBe('Sarah');
    // Mute model: everyone defaults to canSpeak=true on join. Host can
    // mute via setMuted() to flip a specific participant to false.
    expect(updated.participants[0]!.canSpeak).toBe(true);
    expect(updated.version).toBe(2);
  });

  it('auto-suffixes a colliding name across client kinds', async () => {
    const before: Room = {
      code: 'A', topic: 't', createdAt: 0, createdBy: 'host', status: 'active', version: 1,
      participants: [
        { name: 'Robin', role: '', color: '#000', initials: 'RO', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(before) }))
      .mockResolvedValueOnce(mockResp({ result: 'OK' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const updated = await joinRoom(client, 'A', {
      name: 'Robin', role: '', color: '#111', initials: 'RO', client: 'cc',
      joinedAt: 100, lastSeenAt: 100,
    });

    expect(updated.participant.name).toBe('Robin (2)');
    expect(updated.participants).toHaveLength(2);
  });

  it('keeps a reconnecting prior identity from getting suffixed', async () => {
    const before: Room = {
      code: 'A', topic: 't', createdAt: 0, createdBy: 'host', status: 'active', version: 1,
      participants: [
        { name: 'Codex', role: '', color: '#000', initials: 'CO', client: 'cc', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(before) }))
      .mockResolvedValueOnce(mockResp({ result: 'OK' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const updated = await joinRoom(client, 'A', {
      name: 'Codex', role: '', color: '#000', initials: 'CO', client: 'cc',
      joinedAt: 100, lastSeenAt: 100,
    }, {
      priorIdentity: { name: 'Codex', client: 'cc' },
    });

    expect(updated.participant.name).toBe('Codex');
    expect(updated.participants).toHaveLength(1);
  });

  it('owner rejoin canonicalizes host name and evicts stale case-variant web host rows', async () => {
    const before: Room = {
      code: 'A', topic: 't', createdAt: 0, createdBy: 'Robin', ownerId: 'user_owner',
      status: 'active', version: 1,
      participants: [
        { name: 'Robin', role: '', color: '#000', initials: 'RO', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
        { name: 'Claude', role: '', color: '#111', initials: 'CL', client: 'cc', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(before) }))
      .mockResolvedValueOnce(mockResp({ result: 'OK' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const updated = await joinRoom(client, 'A', {
      name: 'robin', role: '', color: '#222', initials: 'RO', client: 'web',
      joinedAt: 100, lastSeenAt: 100,
    }, {
      authedUserId: 'user_owner',
      priorIdentity: { name: 'robin', client: 'web' },
    });

    expect(updated.participant.name).toBe('Robin');
    const webHosts = updated.participants.filter(p => p.client === 'web');
    expect(webHosts).toHaveLength(1);
    expect(webHosts[0]!.name).toBe('Robin');
    expect(updated.participants.some(p => p.name === 'Claude')).toBe(true);
  });

  it('case-insensitive host name reclaim without ownerId still uses canonical createdBy', async () => {
    const before: Room = {
      code: 'A', topic: 't', createdAt: 0, createdBy: 'Robin', status: 'active', version: 1,
      participants: [
        { name: 'Robin', role: '', color: '#000', initials: 'RO', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(before) }))
      .mockResolvedValueOnce(mockResp({ result: 'OK' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const updated = await joinRoom(client, 'A', {
      name: 'robin', role: '', color: '#222', initials: 'RO', client: 'web',
      joinedAt: 100, lastSeenAt: 100,
    });

    expect(updated.participant.name).toBe('Robin');
    expect(updated.participants.filter(p => p.client === 'web')).toHaveLength(1);
  });

  it('chooses an unused avatar color when the requested color is already taken', async () => {
    const before: Room = {
      code: 'A', topic: 't', createdAt: 0, createdBy: 'host', status: 'active', version: 1,
      participants: [
        { name: 'Claude', role: '', color: AVATAR_PALETTE[0]!, initials: 'CL', client: 'cc', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(before) }))
      .mockResolvedValueOnce(mockResp({ result: 'OK' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const updated = await joinRoom(client, 'A', {
      name: 'Codex', role: '', color: AVATAR_PALETTE[0]!, initials: 'CO', client: 'cc',
      joinedAt: 100, lastSeenAt: 100,
    });

    expect(updated.participant.color).toBe(AVATAR_PALETTE[1]);
  });

  it('lands cc (agent) joiners with canSpeak=true (mute model)', async () => {
    const before: Room = { code: 'A', topic: 't', createdAt: 0, createdBy: 'host', status: 'active', version: 1, participants: [] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResp({ result: JSON.stringify(before) }))
      .mockResolvedValueOnce(mockResp({ result: 'OK' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const updated = await joinRoom(client, 'A', {
      name: 'Codex', role: 'AI', color: '#000', initials: 'CO', client: 'cc',
      joinedAt: 100, lastSeenAt: 100,
    });

    // Mute model: everyone (web + cc) defaults to true. Host mutes
    // specific participants via setMuted() if they need to be silenced.
    expect(updated.participant.canSpeak).toBe(true);
  });

  describe('interview room candidate lock', () => {
    // Interview rooms are 1-on-1: at most one candidate (web, non-host) seat
    // per invite link. The lock fires server-side inside joinRoom's CAS
    // mutator. AI Interviewer (cc) and host (web) are both exempt; MCP
    // agents (cc) can still observe. Same candidate refreshing (priorIdentity
    // match) is also exempt so a browser reload doesn't lock them out.
    it('lets the first candidate join an interview room', async () => {
      const before: Room = {
        code: 'A', topic: 'AI Interview', createdAt: 0, createdBy: 'Host', status: 'active', version: 1,
        participants: [
          { name: 'Host', role: 'Host', color: '#000', initials: 'HO', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
          { name: 'AI Interviewer', role: 'Interviewer', color: '#111', initials: 'AI', client: 'cc', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
        ],
      };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mockResp({ result: JSON.stringify(before) }))
        .mockResolvedValueOnce(mockResp({ result: 'OK' }));
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient(ENV);
      const updated = await joinRoom(client, 'A', {
        name: 'Alice', role: 'Candidate', color: '#222', initials: 'AL', client: 'web',
        joinedAt: 100, lastSeenAt: 100,
      });

      expect(updated.participant.name).toBe('Alice');
      expect(updated.participants).toHaveLength(3);
    });

    it('rejects a second candidate with InterviewRoomBusyError', async () => {
      const before: Room = {
        code: 'A', topic: 'AI Interview', createdAt: 0, createdBy: 'Host', status: 'active', version: 1,
        participants: [
          { name: 'Host', role: 'Host', color: '#000', initials: 'HO', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
          { name: 'AI Interviewer', role: 'Interviewer', color: '#111', initials: 'AI', client: 'cc', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
          { name: 'Alice', role: 'Candidate', color: '#222', initials: 'AL', client: 'web', joinedAt: 50, lastSeenAt: 50, canSpeak: true },
        ],
      };
      // CAS retries up to 3 times on ConcurrencyError; busy-room throws a
      // different error type so each attempt re-reads the room. Stub three
      // identical GETs to cover all retry attempts.
      const fetchMock = vi.fn().mockResolvedValue(mockResp({ result: JSON.stringify(before) }));
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient(ENV);
      await expect(
        joinRoom(client, 'A', {
          name: 'Bob', role: 'Candidate', color: '#333', initials: 'BO', client: 'web',
          joinedAt: 100, lastSeenAt: 100,
        }),
      ).rejects.toBeInstanceOf(InterviewRoomBusyError);
    });

    it('lets the same candidate refresh via priorIdentity', async () => {
      const before: Room = {
        code: 'A', topic: 'AI Interview', createdAt: 0, createdBy: 'Host', status: 'active', version: 1,
        participants: [
          { name: 'Host', role: 'Host', color: '#000', initials: 'HO', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
          { name: 'Alice', role: 'Candidate', color: '#222', initials: 'AL', client: 'web', joinedAt: 50, lastSeenAt: 50, canSpeak: true },
        ],
      };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mockResp({ result: JSON.stringify(before) }))
        .mockResolvedValueOnce(mockResp({ result: 'OK' }));
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient(ENV);
      const updated = await joinRoom(client, 'A', {
        name: 'Alice', role: 'Candidate', color: '#222', initials: 'AL', client: 'web',
        joinedAt: 200, lastSeenAt: 200,
      }, {
        priorIdentity: { name: 'Alice', client: 'web' },
      });

      expect(updated.participant.name).toBe('Alice');
      // Same row, no duplicate.
      expect(updated.participants.filter(p => p.name === 'Alice')).toHaveLength(1);
    });

    it('lets a cc (MCP agent) join even when a candidate is already seated', async () => {
      const before: Room = {
        code: 'A', topic: 'AI Interview', createdAt: 0, createdBy: 'Host', status: 'active', version: 1,
        participants: [
          { name: 'Host', role: 'Host', color: '#000', initials: 'HO', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
          { name: 'Alice', role: 'Candidate', color: '#222', initials: 'AL', client: 'web', joinedAt: 50, lastSeenAt: 50, canSpeak: true },
        ],
      };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mockResp({ result: JSON.stringify(before) }))
        .mockResolvedValueOnce(mockResp({ result: 'OK' }));
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient(ENV);
      const updated = await joinRoom(client, 'A', {
        name: 'Cursor', role: 'Observer', color: '#444', initials: 'CU', client: 'cc',
        joinedAt: 100, lastSeenAt: 100,
      });

      // cc clients are exempt from the candidate lock — only web non-host
      // joiners count as candidates.
      expect(updated.participant.name).toBe('Cursor');
      expect(updated.participants).toHaveLength(3);
    });

    it('does not lock non-interview rooms (topic without "interview")', async () => {
      const before: Room = {
        code: 'A', topic: 'Q3 planning', createdAt: 0, createdBy: 'Host', status: 'active', version: 1,
        participants: [
          { name: 'Host', role: 'Host', color: '#000', initials: 'HO', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
          { name: 'Alice', role: '', color: '#222', initials: 'AL', client: 'web', joinedAt: 50, lastSeenAt: 50, canSpeak: true },
        ],
      };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mockResp({ result: JSON.stringify(before) }))
        .mockResolvedValueOnce(mockResp({ result: 'OK' }));
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient(ENV);
      const updated = await joinRoom(client, 'A', {
        name: 'Bob', role: '', color: '#333', initials: 'BO', client: 'web',
        joinedAt: 100, lastSeenAt: 100,
      });

      expect(updated.participants).toHaveLength(3);
    });
  });
});
