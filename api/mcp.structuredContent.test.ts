// room_create / room_join / room_listen hand back structuredContent, like the
// memory tools and room_task already did.
//
// Clients split into two camps: one reads content[0].text, the other reads
// structuredContent and ignores text entirely. The room lifecycle tools only
// ever filled the first, so an agent on an SDK that surfaces structured output
// got an empty result from the three calls it cannot work without.
//
// Two things are asserted on every result here, and the second is the reason
// the first is safe: structuredContent deep-equals JSON.parse(content[0].text),
// and the text is still exactly what JSON.stringify(value, null, 2) produced
// before — the snapshots in __snapshots__ were recorded from the old code and
// are not allowed to move. Nothing is added to the payload, so no secret can
// appear in a place it was not already.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolResult } from './_mcpResult.js';

process.env.PUBLIC_BASE_URL = 'https://rooms.test';
delete process.env.MEMORY_ENABLED;
delete process.env.MEMORY_DATABASE_URL;

const host = { name: 'Host', role: '', color: '#000', initials: 'HO', client: 'web' as const, joinedAt: 0, lastSeenAt: 0, canSpeak: true };
const codex = { name: 'Codex', role: 'builder', color: '#002', initials: 'CO', client: 'cc' as const, joinedAt: 1, lastSeenAt: 1, canSpeak: true };

const baseRoom = {
  code: 'AAA-BBB-CCC',
  topic: 'Structured results',
  createdAt: 0,
  createdBy: 'Host',
  status: 'active' as 'active' | 'ended',
  version: 1,
  replyMode: 'open' as const,
  participants: [host, codex],
};

let room: typeof baseRoom;

const message = (over: Record<string, unknown> = {}) => ({
  id: 1, name: 'Host', text: 'Welcome.', time: 1_700_000_000_000,
  initials: 'HO', color: '#000', role: '', client: 'web' as const, type: 'msg' as const,
  ...over,
});

const createRoom = vi.fn();
const joinRoom = vi.fn();
const appendMessage = vi.fn();
const listMessages = vi.fn();

vi.mock('./_mcpRoomClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_mcpRoomClient.js')>()),
  createRemoteRoomClient: () => ({}),
  createRoom: (...a: unknown[]) => createRoom(...a),
  joinRoom: (...a: unknown[]) => joinRoom(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  listMessages: (...a: unknown[]) => listMessages(...a),
  getRoom: async () => room,
  sweepRoom: async () => room,
  setListenUntil: async () => {},
}));

const call = async (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
  const { callTool } = await import('./_mcpTools.js');
  return callTool({} as never, 'full', name, args);
};

const textOf = (result: McpToolResult): string => (result.content[0] as { text: string }).text;

/**
 * The text is the published contract and must not move; structuredContent is
 * the same value, not a second rendering of it. Comparing the text back against
 * JSON.stringify(structuredContent) catches a divergence in key order too.
 */
const expectMirroredJson = (result: McpToolResult) => {
  expect(result.structuredContent).toEqual(JSON.parse(textOf(result)));
  expect(textOf(result)).toBe(JSON.stringify(result.structuredContent, null, 2));
};

describe('room lifecycle tools return structuredContent', () => {
  beforeEach(() => {
    room = { ...baseRoom, participants: [...baseRoom.participants] };
    createRoom.mockReset();
    joinRoom.mockReset();
    appendMessage.mockReset();
    listMessages.mockReset();
    createRoom.mockResolvedValue({ ...room, hostKey: 'host-key-fixed' });
    joinRoom.mockResolvedValue({ ...room, participant: codex, seatKey: 'seat-key-fixed' });
    appendMessage.mockResolvedValue({ appended: true });
    listMessages.mockResolvedValue([]);
  });

  it('room_create mirrors its JSON text', async () => {
    const result = await call('room_create', { topic: 'Structured results', name: 'Host', role: 'builder' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
    expect(result.isError).toBeUndefined();
    // hostKey and seatKey were already in the text; structuredContent is the
    // same value, so this adds no new place for them to leak.
    expect(result.structuredContent).toMatchObject({ hostKey: 'host-key-fixed', seatKey: 'seat-key-fixed' });
  });

  it('room_join mirrors its JSON text', async () => {
    room.participants = [host];
    listMessages.mockResolvedValue([message()]);
    const result = await call('room_join', { code: room.code, name: 'Codex', role: 'builder' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
    expect(appendMessage).toHaveBeenCalledTimes(1);
  });

  // The seat-conflict reply is a normal (non-isError) result, so a declared
  // outputSchema covers it too.
  it('room_join mirrors the SEAT_IN_USE reply', async () => {
    const { RemoteRoomApiError } = await import('./_mcpRoomClient.js');
    joinRoom.mockRejectedValue(new RemoteRoomApiError('That seat is online.', 409, 'SEAT_IN_USE'));
    const result = await call('room_join', { code: room.code, name: 'Codex', personaId: 'persona-a' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
    expect(result.isError).toBeUndefined();
  });

  it('room_listen mirrors a non-blocking history read', async () => {
    listMessages.mockResolvedValue([message(), message({ id: 2, name: 'Codex', client: 'cc', text: 'Reading now.' })]);
    const result = await call('room_listen', { code: room.code, name: 'Codex', since: 0, timeoutMs: 0 });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  // The transient-failure reply is built by hand rather than from a listen
  // result, so it is its own path through the tool.
  it('room_listen mirrors a transient listMessages failure', async () => {
    listMessages.mockRejectedValue(new Error('upstream blip'));
    const result = await call('room_listen', { code: room.code, name: 'Codex', since: 7, timeoutMs: 0 });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_listen mirrors a quiet hold that times out', async () => {
    const result = await call('room_listen', { code: room.code, name: 'Codex', since: 0, timeoutMs: 1000 });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_listen mirrors a hold that returns a message', async () => {
    listMessages.mockResolvedValue([message({ text: '@Codex take a look' })]);
    const result = await call('room_listen', { code: room.code, name: 'Codex', since: 0, timeoutMs: 1000 });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_listen mirrors a terminated hold (room ended)', async () => {
    room.status = 'ended';
    const result = await call('room_listen', { code: room.code, name: 'Codex', since: 3, timeoutMs: 1000 });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
    expect(result.structuredContent).toMatchObject({ terminated: 'room_ended', listenStatus: 'ended' });
  });

  it('room_listen mirrors a terminated hold (kicked)', async () => {
    room.participants = [host];
    const result = await call('room_listen', { code: room.code, name: 'Codex', since: 3, timeoutMs: 1000 });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
    expect(result.structuredContent).toMatchObject({ terminated: 'kicked', listenStatus: 'removed' });
  });

  // resolveAlias rewrites the old name onto room_listen before dispatch, so the
  // alias has to come back with the same result shape as the tool it reaches.
  it('the room_list_messages alias gets structuredContent too', async () => {
    listMessages.mockResolvedValue([message()]);
    const result = await call('room_list_messages', { code: room.code, name: 'Codex', since: 0 });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('declares the same object outputSchema the memory tools and room_task use', async () => {
    const { CORE_TOOLS, FULL_TOOLS } = await import('./_mcpToolDefs.js');
    const schema = FULL_TOOLS.find(tool => tool.name === 'room_task')!.outputSchema;
    expect(schema).toEqual({ type: 'object', additionalProperties: true });
    for (const name of ['room_create', 'room_join', 'room_listen']) {
      expect(CORE_TOOLS.find(tool => tool.name === name)!.outputSchema).toEqual(schema);
    }
  });
});

// Image parts are additional content items, not part of the JSON value, so
// they must stay in content[] and out of structuredContent.
describe('extra content items stay in content', () => {
  const previousR2 = process.env.R2_PUBLIC_URL;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    room = { ...baseRoom, participants: [...baseRoom.participants] };
    listMessages.mockReset();
    process.env.R2_PUBLIC_URL = 'https://cdn.rooms.test';
    globalThis.fetch = (async () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (previousR2 === undefined) delete process.env.R2_PUBLIC_URL;
    else process.env.R2_PUBLIC_URL = previousR2;
  });

  it('room_listen keeps the image part in content and out of structuredContent', async () => {
    listMessages.mockResolvedValue([message({
      text: '',
      attachments: [{ type: 'image', name: 'shot.png', mime: 'image/png', url: 'https://cdn.rooms.test/shot.png' }],
    })]);
    const result = await call('room_listen', { code: room.code, name: 'Codex', since: 0, timeoutMs: 0 });
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
    const bytes = (result.content[1] as { data: string }).data;
    expect(JSON.stringify(result.structuredContent)).not.toContain(bytes);
  });
});
