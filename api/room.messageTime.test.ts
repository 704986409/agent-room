// End-to-end over the real storage layer (only `fetch` is faked), because the
// point of the fix is that /api/room cannot store a timeless message even
// though the HTTP layer never looks at `time`. Mocking _mcpRoomClient — as
// room.test.ts does — would mock out the very code under test.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Message, Room } from '@agent-room/shared';

import handler from './room.js';

const ROOM: Room = {
  code: 'ABC-DEF-GHJ', topic: 'Test', createdAt: Date.now(), createdBy: 'Alice',
  status: 'active', version: 1,
  participants: [
    { name: 'Alice', role: 'Host', color: '#111', initials: 'AL', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
  ],
};

function mockResp(body: unknown) { return new Response(JSON.stringify(body)); }

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
    end() { return this; },
  };
}

async function post(body: unknown) {
  const req = { method: 'POST', headers: { host: 'selfhost.example' }, body } as unknown as VercelRequest;
  const res = makeResponse();
  await handler(req, res as unknown as VercelResponse);
  return res;
}

/** getRoom, then the RPUSH pipeline. Anything after is best-effort fan-out. */
function stubStorage() {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(mockResp({ result: JSON.stringify(ROOM) }))
    .mockResolvedValueOnce(mockResp([
      { result: 1 }, { result: 1 }, { result: 'OK' }, { result: 1 }, { result: 1 },
    ]))
    .mockResolvedValue(mockResp({ result: null }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function storedMessage(fetchMock: ReturnType<typeof vi.fn>): Message {
  const init = fetchMock.mock.calls[1]![1] as { body: string };
  return JSON.parse(JSON.parse(init.body)[0][2]) as Message;
}

const SEND_BODY = {
  action: 'send',
  code: ROOM.code,
  message: {
    id: 1, type: 'msg', name: 'Alice', initials: 'AL', color: '#111',
    role: 'Host', text: 'hello', client: 'web',
  },
};

describe('POST /api/room send — message time', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it('stores a finite server time for a send that carried none', async () => {
    const fetchMock = stubStorage();
    const before = Date.now();

    const res = await post(SEND_BODY);

    expect(res.statusCode).toBe(200);
    const stored = storedMessage(fetchMock);
    expect(typeof stored.time).toBe('number');
    expect(Number.isFinite(stored.time)).toBe(true);
    expect(stored.time).toBeGreaterThanOrEqual(before);
    expect(stored.time).toBeLessThanOrEqual(Date.now());
  });

  it('keeps a plausible client time and never rewrites the id', async () => {
    const fetchMock = stubStorage();
    const time = Date.now() - 1_000;

    await post({ ...SEND_BODY, message: { ...SEND_BODY.message, time } });

    const stored = storedMessage(fetchMock);
    expect(stored.time).toBe(time);
    expect(stored.id).toBe(SEND_BODY.message.id);
  });

  it('rejects a missing name and a non-string text with 400 bad_request', async () => {
    const { name: _noName, ...nameless } = SEND_BODY.message;
    const noName = await post({ ...SEND_BODY, message: nameless });
    expect(noName.statusCode).toBe(400);
    expect(noName.body).toEqual({ error: 'bad_request', message: 'message.name is required' });

    const badText = await post({ ...SEND_BODY, message: { ...SEND_BODY.message, text: 42 } });
    expect(badText.statusCode).toBe(400);
    expect(badText.body).toEqual({ error: 'bad_request', message: 'message.text must be a string' });
  });
});
