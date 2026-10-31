// AR-03: quiet room_listen results must stay short. The Codex wait-cell
// contract lives on the tool description; pasting it into every timeout
// re-sends the growing transcript. Managed seats sleep after one quiet round.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AGENT_ROOM_CODEX_CONTINUE } from '@agent-room/shared';

const room = {
  code: 'AAA-BBB-CCC',
  topic: 't',
  createdAt: 0,
  createdBy: 'host',
  status: 'active' as const,
  version: 1,
  replyMode: 'open' as const,
  participants: [
    { name: 'host', role: '', color: '#000', initials: 'HO', client: 'web' as const, joinedAt: 0, lastSeenAt: 0, canSpeak: true },
    { name: 'Codex', role: '', color: '#002', initials: 'CO', client: 'cc' as const, joinedAt: 2, lastSeenAt: 2, canSpeak: true },
  ],
};

const listMessages = vi.fn();

vi.mock('./_mcpRoomClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_mcpRoomClient.js')>()),
  createRemoteRoomClient: () => ({}),
  getRoom: async () => room,
  sweepRoom: async () => room,
  setListenUntil: async () => {},
  listMessages: (...args: unknown[]) => listMessages(...args),
}));

const SEAT = 'seat-key-fixed';
const CODEX_MARKERS = [AGENT_ROOM_CODEX_CONTINUE, 'CODEX NEXT ACTION', 'Script running with cell ID'];

function body(res: { content: unknown[] }): Record<string, any> {
  return JSON.parse((res.content[0] as { text: string }).text);
}

async function listen(args: Record<string, unknown>, client: unknown = { post: async () => { throw new Error('no board'); } }) {
  const { callTool } = await import('./_mcpTools.js');
  return body(await callTool(client as never, 'full', 'room_listen', {
    code: room.code, name: 'Codex', since: 4, timeoutMs: 1000, ...args,
  }));
}

function expectNoCodex(hint: string) {
  for (const marker of CODEX_MARKERS) expect(hint).not.toContain(marker);
}

describe('lean room_listen results', () => {
  beforeEach(() => { listMessages.mockReset(); listMessages.mockResolvedValue([]); });

  it('keeps a quiet non-managed hint free of the Codex continuation block', async () => {
    const res = await listen({});
    expect(res.messages).toEqual([]);
    expect(res.yourTasks).toBeUndefined();
    expect(res.nextAction).toMatchObject({
      required: true,
      tool: 'room_listen',
      kind: 'presence',
      arguments: { code: room.code, since: 4, name: 'Codex' },
    });
    expect(res.hint).toContain('Quiet for 1000ms');
    expect(res.hint).toContain(`NEXT: room_listen({ code: "${room.code}", since: 4, name: "<you>" })`);
    expectNoCodex(res.hint);
    expect(res.hint.length).toBeLessThan(400);
  });

  it('sends a quiet managed seat to room_sleep with the real seatKey and cursor', async () => {
    const res = await listen({ managed: { seatKey: SEAT } });
    expect(res.messages).toEqual([]);
    expect(res.yourTasks).toBeUndefined();
    expect(res.digest).toBeUndefined();
    expect(res.roomPolicy).toBeUndefined();
    expect(res.nextAction).toEqual({
      required: true,
      tool: 'room_sleep',
      kind: 'sleep',
      arguments: { code: room.code, name: 'Codex', cursor: 4, seatKey: SEAT },
    });
    expect(res.hint).toContain('room_sleep');
    expect(res.hint).toContain(SEAT);
    expect(res.hint).toContain('end your turn');
    expect(res.hint).not.toContain('Keep listening even when the room is quiet');
    expect(res.hint).not.toContain('room_listen');
    expect(res.listenStatus).toBe('sleep');
    expect(res.stay).toBe(false);
    expect(res.meaning).toContain('room_sleep');
    expect(res.meaning).not.toMatch(/call room_listen immediately/);
    expectNoCodex(res.hint);
    expect(res.hint.length).toBeLessThan(400);
  });

  it('keeps board work ahead of sleep on a quiet managed hold', async () => {
    const client = {
      post: async () => ({
        board: {
          tasks: [{ id: 'T-03', title: 'review me', state: 'awaiting_review', owner: 'Other', verifier: 'Codex' }],
        },
      }),
    };
    const res = await listen({ managed: { seatKey: SEAT } }, client);
    expect(res.messages).toEqual([]);
    expect(res.nextAction).toMatchObject({ kind: 'task_review', action: 'verify_task', taskId: 'T-03' });
    expect(res.nextAction.tool).not.toBe('room_sleep');
    expect(res.yourTasks).toMatchObject({ toVerify: ['T-03'] });
    expect(res.hint).toContain('BOARD WORK OVERRIDES PRESENCE');
    expectNoCodex(res.hint);
  });

  it('keeps a message hint lean and still points at room_send when addressed', async () => {
    listMessages.mockResolvedValue([
      { id: 5, type: 'msg', name: 'host', text: '@Codex 回复我', client: 'web', time: 1 },
    ]);
    const res = await listen({ since: 4, wakeOn: 'addressed' });
    expect(res.addressedYou).toBe(true);
    expect(res.messages).toHaveLength(1);
    expect(res.nextAction).toMatchObject({ tool: 'room_send', kind: 'reply' });
    expect(res.hint).toContain('Reply now with room_send');
    expect(res.hint).toContain('NEXT: room_listen');
    expectNoCodex(res.hint);
    expect(res.hint).not.toContain('Keep listening even when the room is quiet');
  });
});
