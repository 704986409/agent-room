// One-time agent invite codes: creation (host-only), lookup, and the MCP
// room_join gate in joinRoom (new agent seats need a code; resume/reclaim/host do not).
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Participant, Room } from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';

let room: Room;
const storeJoin = vi.fn();

vi.mock('@agent-room/upstash-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-room/upstash-client')>();
  return {
    ...actual,
    getRoom: async () => room,
    joinRoom: async (_store: unknown, _code: string, participant: Participant) => {
      storeJoin(participant);
      room = { ...room, participants: [...room.participants.filter(p => p.name !== participant.name), participant] };
      return { ...room, participant };
    },
    casRoom: async (_store: unknown, _code: string, fn: (r: Room) => Room) => { room = fn(room); return room; },
  };
});

const {
  AGENT_INVITE_TTL_MS,
  createAgentInvite,
  lookupAgentInvite,
} = await import('./_agentInvite.js');
const { joinRoom, RemoteRoomApiError } = await import('./_mcpRoomClient.js');

function memoryStore(): UpstashClient & { kv: Map<string, string> } {
  const kv = new Map<string, string>();
  const run = (cmd: readonly (string | number)[]): unknown => {
    const op = String(cmd[0]).toUpperCase();
    const key = String(cmd[1]);
    if (op === 'GET') return kv.get(key) ?? null;
    if (op === 'DEL') return kv.delete(key) ? 1 : 0;
    if (op === 'SET') {
      if (cmd.map(String).includes('NX') && kv.has(key)) return null;
      kv.set(key, String(cmd[2]));
      return 'OK';
    }
    return null;
  };
  return {
    kv,
    async command<T>(cmd: readonly (string | number)[]) { return run(cmd) as T; },
    async pipeline<T>(cmds: readonly (readonly (string | number)[])[]) { return cmds.map(run) as T[]; },
  };
}

const HOST_KEY = 'host-key-secret';
const agent = (name: string, role = ''): Participant => ({
  name, role, color: '#000', initials: 'AG', client: 'cc', joinedAt: 1, lastSeenAt: Date.now(),
});

let store: ReturnType<typeof memoryStore>;
const client = () => ({ store, post: vi.fn() }) as never;

beforeEach(() => {
  store = memoryStore();
  storeJoin.mockReset();
  room = {
    code: 'AAA-BBB-CCC',
    topic: 'Invites',
    createdAt: 0,
    createdBy: 'Host',
    status: 'active',
    version: 1,
    replyMode: 'open',
    roomInstanceId: '11111111-1111-4111-8111-111111111111',
    hostKeyHash: createHash('sha256').update(HOST_KEY, 'utf8').digest('hex'),
    participants: [],
  } as unknown as Room;
});

describe('createAgentInvite', () => {
  it('requires the hostKey and stores only the hash', async () => {
    await expect(createAgentInvite(store, room, { hostKey: 'wrong', role: '记忆审核员' }))
      .rejects.toMatchObject({ code: 'NotHostError', status: 403 });
    const invite = await createAgentInvite(store, room, { hostKey: HOST_KEY, role: ' 记忆审核员 ' });
    expect(invite).toMatchObject({ role: '记忆审核员', personaId: '记忆审核员', ttlSeconds: 300 });
    expect(invite.expiresAt - invite.createdAt).toBe(AGENT_INVITE_TTL_MS);
    expect([...store.kv.keys()].join()).not.toContain(invite.inviteCode);
    expect([...store.kv.values()].join()).not.toContain(invite.inviteCode);
  });

  it('stores an optional role profile (<=4000 chars) and rejects longer ones', async () => {
    const invite = await createAgentInvite(store, room, { hostKey: HOST_KEY, role: '开发工程师', roleProfile: '  负责后端。\r\n只用 TypeScript。  ' });
    expect(invite.roleProfile).toBe('负责后端。\n只用 TypeScript。');
    const none = await createAgentInvite(store, room, { hostKey: HOST_KEY, role: '开发工程师', roleProfile: '   ' });
    expect(none.roleProfile).toBeUndefined();
    await expect(createAgentInvite(store, room, { hostKey: HOST_KEY, role: '开发工程师', roleProfile: 'x'.repeat(4001) }))
      .rejects.toMatchObject({ code: 'invalid_role_profile' });
  });

  it('rejects an empty role', async () => {
    await expect(createAgentInvite(store, room, { hostKey: HOST_KEY, role: '  ' }))
      .rejects.toMatchObject({ code: 'invalid_role' });
  });

  it('reports expired separately from invalid', async () => {
    const invite = await createAgentInvite(store, room, { hostKey: HOST_KEY, role: '测试工程师', now: 1_000 });
    expect(await lookupAgentInvite(store, room, invite.inviteCode, 1_000 + AGENT_INVITE_TTL_MS - 1))
      .toMatchObject({ ok: true });
    expect(await lookupAgentInvite(store, room, invite.inviteCode, 1_000 + AGENT_INVITE_TTL_MS))
      .toEqual({ ok: false, reason: 'invite_code_expired' });
    expect(await lookupAgentInvite(store, room, 'AI-NOPE-NOPE-NOPE-NOPE'))
      .toEqual({ ok: false, reason: 'invite_code_invalid' });
  });
});

describe('joinRoom agent invite gate', () => {
  it('rejects a new agent seat without a code', async () => {
    await expect(joinRoom(client(), room.code, agent('Codex'), { requireAgentInvite: true }))
      .rejects.toMatchObject({ code: 'invite_code_required', status: 403 });
    expect(storeJoin).not.toHaveBeenCalled();
  });

  it('binds role + personaId from the invite (invite wins) and spends it once', async () => {
    const invite = await createAgentInvite(store, room, { hostKey: HOST_KEY, role: '记忆审核员' });
    const joined = await joinRoom(client(), room.code, agent('Codex', 'builder'), {
      requireAgentInvite: true, inviteCode: invite.inviteCode, personaId: 'something-else',
    });
    expect(joined.participant).toMatchObject({ role: '记忆审核员', memoryPersonaId: '记忆审核员', memoryIdentityType: 'persona' });
    expect(joined.agentInvite).toEqual({ role: '记忆审核员', personaId: '记忆审核员' });
    await expect(joinRoom(client(), room.code, agent('Claude'), { requireAgentInvite: true, inviteCode: invite.inviteCode }))
      .rejects.toMatchObject({ code: 'invite_code_invalid' });
  });

  it('rejects an expired code with invite_code_expired', async () => {
    const invite = await createAgentInvite(store, room, {
      hostKey: HOST_KEY, role: '开发工程师', now: Date.now() - AGENT_INVITE_TTL_MS - 1,
    });
    const error = await joinRoom(client(), room.code, agent('Codex'), { requireAgentInvite: true, inviteCode: invite.inviteCode })
      .catch(e => e);
    expect(error).toBeInstanceOf(RemoteRoomApiError);
    expect(error).toMatchObject({ code: 'invite_code_expired' });
    expect(String(error.message)).toContain('重新生成');
  });

  it('returns the role profile of the spent invite', async () => {
    const invite = await createAgentInvite(store, room, { hostKey: HOST_KEY, role: '测试工程师', roleProfile: '负责回归测试。' });
    const joined = await joinRoom(client(), room.code, agent('Codex'), { requireAgentInvite: true, inviteCode: invite.inviteCode });
    expect(joined.agentInvite).toEqual({ role: '测试工程师', personaId: '测试工程师', roleProfile: '负责回归测试。' });
    const resumed = await joinRoom(client(), room.code, agent('Codex'), { requireAgentInvite: true, seatKey: joined.seatKey });
    expect(resumed.agentInvite).toBeUndefined();
  });

  it('lets a seatKey resume through without a code', async () => {
    const invite = await createAgentInvite(store, room, { hostKey: HOST_KEY, role: '开发工程师' });
    const first = await joinRoom(client(), room.code, agent('Codex'), { requireAgentInvite: true, inviteCode: invite.inviteCode });
    const resumed = await joinRoom(client(), room.code, agent('Codex'), { requireAgentInvite: true, seatKey: first.seatKey });
    expect(resumed.participant.memoryPersonaId).toBe('开发工程师');
  });

  it('lets an offline same-Persona seat be reclaimed without a code', async () => {
    const invite = await createAgentInvite(store, room, { hostKey: HOST_KEY, role: '开发工程师' });
    await joinRoom(client(), room.code, agent('Codex'), { requireAgentInvite: true, inviteCode: invite.inviteCode });
    room = { ...room, participants: room.participants.map(p => ({ ...p, lastSeenAt: 0, listenLeases: undefined })) };
    const reclaimed = await joinRoom(client(), room.code, agent('Codex'), { requireAgentInvite: true, personaId: '开发工程师' });
    expect(reclaimed).toMatchObject({ reclaimed: true });
  });

  it('leaves joins without requireAgentInvite (HTTP join action) unchanged', async () => {
    const joined = await joinRoom(client(), room.code, agent('Codex'));
    expect(joined.participant.name).toBe('Codex');
  });
});
