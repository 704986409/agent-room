// Every tool hands back structuredContent, on every return path that answers
// with a JSON object — payloads, the bad_request hints the dispatcher writes
// itself, and the refusals the room API hands back by code.
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
const removeParticipant = vi.fn();
const endRoom = vi.fn();
const reactivateRoom = vi.fn();
const createRoomReport = vi.fn();
// The room API seam the action tools (board, webhooks, host controls) go
// through instead of a named helper.
const post = vi.fn();

vi.mock('./_mcpRoomClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_mcpRoomClient.js')>()),
  createRemoteRoomClient: () => ({}),
  createRoom: (...a: unknown[]) => createRoom(...a),
  joinRoom: (...a: unknown[]) => joinRoom(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  listMessages: (...a: unknown[]) => listMessages(...a),
  removeParticipant: (...a: unknown[]) => removeParticipant(...a),
  endRoom: (...a: unknown[]) => endRoom(...a),
  reactivateRoom: (...a: unknown[]) => reactivateRoom(...a),
  createRoomReport: (...a: unknown[]) => createRoomReport(...a),
  getRoom: async () => room,
  sweepRoom: async () => room,
  setListenUntil: async () => {},
}));

const call = async (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
  const { callTool } = await import('./_mcpTools.js');
  return callTool({ post: (...a: unknown[]) => post(...a) } as never, 'full', name, args);
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
    post.mockReset();
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

  // The full table. Every tool on the surface answers with a JSON object, so
  // every tool declares the shared schema — and declaresObjectOutput, which the
  // dispatcher reads before shaping a result, has to agree for all of them.
  // A new tool that forgets the declaration fails here rather than shipping
  // text-only results to structured-output clients.
  it('declares the same object outputSchema on every tool', async () => {
    const { CORE_TOOLS, FULL_TOOLS, declaresObjectOutput } = await import('./_mcpToolDefs.js');
    const schema = { type: 'object', additionalProperties: true };
    const tools = [...CORE_TOOLS, ...FULL_TOOLS];
    expect(tools.map(tool => tool.name)).toEqual([
      'room_create',
      'room_join',
      'room_send',
      'room_listen',
      'room_sleep',
      'room_minutes',
      'room_leave',
      'room_end',
      'room_task',
      'room_webhook',
      'room_admin',
    ]);
    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} outputSchema`).toEqual(schema);
      expect(declaresObjectOutput(tool.name), `${tool.name} declaresObjectOutput`).toBe(true);
    }
  });
});

// Everything the first block does not cover: room_send and its alias, the
// minutes/export pair, leave, end, the board's reopen action, and the two
// action tools (webhooks, host controls) down to each bad_request hint. The
// refusal objects the room API returns by code are results of the tool that
// asked, so they are covered by the same declaration and asserted here too.
describe('the rest of the tool surface returns structuredContent', () => {
  const task = { id: 'T-01', title: 'Ship the thing', state: 'todo', owner: 'Codex' };
  const board = { tasks: [task], version: 2 };

  beforeEach(() => {
    room = { ...baseRoom, participants: [...baseRoom.participants] };
    appendMessage.mockReset();
    listMessages.mockReset();
    removeParticipant.mockReset();
    endRoom.mockReset();
    reactivateRoom.mockReset();
    createRoomReport.mockReset();
    post.mockReset();
    appendMessage.mockResolvedValue({ appended: true });
    listMessages.mockResolvedValue([message()]);
    removeParticipant.mockResolvedValue(undefined);
    endRoom.mockResolvedValue(undefined);
    reactivateRoom.mockResolvedValue(undefined);
    createRoomReport.mockResolvedValue({ messageCount: 1 });
  });

  it('room_send mirrors a delivered message', async () => {
    const result = await call('room_send', { code: room.code, name: 'Codex', text: 'Shipping now.' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  // room_status resolves to room_send before dispatch, so it inherits both the
  // handler and the promise.
  it('the room_status alias mirrors a status ping', async () => {
    appendMessage.mockResolvedValue({ appended: true, metadata: { roleAtSend: 'status', extendsTurn: true } });
    const result = await call('room_status', { code: room.code, name: 'Codex', text: 'on it' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_send mirrors its bad_request hint', async () => {
    const result = await call('room_send', { code: room.code, name: 'Codex', text: '   ' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('room_send mirrors an accepted __no_addition__', async () => {
    appendMessage.mockResolvedValue({ appended: false, reason: 'no_addition' });
    const result = await call('room_send', { code: room.code, name: 'Codex', text: '__no_addition__' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  // The three refusals an agent actually hits on a send. They are normal
  // results, so the declared schema covers them.
  it.each([
    ['muted', 'MutedError', 'You are muted by the host.'],
    ['not_your_turn', 'NotYourTurnError', 'It is not your turn.'],
    ['not_participant', 'NotParticipantError', 'You are not in this room.'],
  ])('room_send mirrors the %s refusal', async (_label, code, msg) => {
    const { RemoteRoomApiError } = await import('./_mcpRoomClient.js');
    appendMessage.mockRejectedValue(new RemoteRoomApiError(msg, 403, code));
    const result = await call('room_send', { code: room.code, name: 'Codex', text: 'Shipping now.' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
    expect(result.isError).toBeUndefined();
  });

  it('room_minutes mirrors the full transcript', async () => {
    const result = await call('room_minutes', { code: room.code });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_minutes mirrors the compact snapshot view', async () => {
    const result = await call('room_minutes', { code: room.code, snapshot: true });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('the room_export alias mirrors the exported report', async () => {
    const result = await call('room_export', { code: room.code });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
    expect(createRoomReport).toHaveBeenCalledTimes(1);
  });

  it('room_leave mirrors its result', async () => {
    const result = await call('room_leave', { code: room.code, name: 'Codex' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_end mirrors its result', async () => {
    const result = await call('room_end', { code: room.code, name: 'Host', hostKey: 'host-key-fixed' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  // An unknown code is the one refusal every tool can hit; asserted on a tool
  // other than room_send so the shared path is covered from both sides.
  it('room_end mirrors the room_not_found refusal', async () => {
    const { RemoteRoomApiError } = await import('./_mcpRoomClient.js');
    endRoom.mockRejectedValue(new RemoteRoomApiError('No such room.', 404, 'RoomNotFoundError'));
    const result = await call('room_end', { code: room.code, name: 'Host' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
    expect(result.isError).toBeUndefined();
  });

  // The reopen action was the one board path still returning a bare ok() while
  // room_task advertised an outputSchema.
  it('the room_task_reopen alias mirrors the reopened task', async () => {
    post.mockResolvedValue({ board, task: { ...task, state: 'in_progress' } });
    const result = await call('room_task_reopen', { code: room.code, name: 'Codex', id: 'T-01', state: 'in_progress' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_task reopen mirrors its bad_request hint', async () => {
    const result = await call('room_task', { code: room.code, action: 'reopen', name: 'Codex' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
    expect(post).not.toHaveBeenCalled();
  });

  it('the room_webhook_register alias mirrors the registration', async () => {
    post.mockResolvedValue({ webhook: { id: 'wh_1', url: 'https://hook.test/room' } });
    const result = await call('room_webhook_register', { code: room.code, name: 'Codex', url: 'https://hook.test/room' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_webhook list mirrors the registry', async () => {
    post.mockResolvedValue({ webhooks: [{ id: 'wh_1', url: 'https://hook.test/room' }] });
    const result = await call('room_webhook', { code: room.code, action: 'list' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_webhook unregister mirrors the removal', async () => {
    post.mockResolvedValue({ removed: true });
    const result = await call('room_webhook', { code: room.code, action: 'unregister', name: 'Codex', id: 'wh_1' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_webhook mirrors a missing-field hint', async () => {
    const result = await call('room_webhook', { code: room.code, action: 'register', name: 'Codex' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
    expect(post).not.toHaveBeenCalled();
  });

  it('room_webhook mirrors an unknown action hint', async () => {
    const result = await call('room_webhook', { code: room.code, action: 'subscribe' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('the room_reactivate alias mirrors the revived room', async () => {
    const result = await call('room_reactivate', { code: room.code, name: 'Host', hostKey: 'host-key-fixed' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
    expect(reactivateRoom).toHaveBeenCalledTimes(1);
  });

  it('room_admin set_mode mirrors the new mode', async () => {
    post.mockResolvedValue({
      room: { ...room, replyMode: 'sequential', modeConfig: { leadAgentName: 'Codex', leadAgentClient: 'cc' } },
    });
    const result = await call('room_admin', {
      code: room.code, name: 'Host', action: 'set_mode', mode: 'sequential', leadAgentName: 'Codex', hostKey: 'host-key-fixed',
    });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_admin set_mode mirrors its missing-mode hint', async () => {
    const result = await call('room_admin', { code: room.code, name: 'Host', action: 'set_mode' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_admin set_mode mirrors its missing-moderator hint', async () => {
    const result = await call('room_admin', { code: room.code, name: 'Host', action: 'set_mode', mode: 'moderator' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_admin invoke mirrors the granted slot', async () => {
    post.mockResolvedValue({ added: true });
    const result = await call('room_admin', {
      code: room.code, name: 'Host', action: 'invoke', targetName: 'Codex', hostKey: 'host-key-fixed',
    });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_admin invoke mirrors its missing-target hint', async () => {
    const result = await call('room_admin', { code: room.code, name: 'Host', action: 'invoke' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_admin skip mirrors the skipped speaker', async () => {
    post.mockResolvedValue({ skipped: { name: 'Codex', client: 'cc' } });
    const result = await call('room_admin', { code: room.code, name: 'Host', action: 'skip', hostKey: 'host-key-fixed' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  it('room_admin mirrors an unknown action hint', async () => {
    const result = await call('room_admin', { code: room.code, name: 'Host', action: 'rename' });
    expect(textOf(result)).toMatchSnapshot();
    expectMirroredJson(result);
  });

  // isError results are exempt from an outputSchema and stay as they were.
  it('leaves an unknown tool as a text-only error', async () => {
    const result = await call('room_teleport', { code: room.code });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
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
