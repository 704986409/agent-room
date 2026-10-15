import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Room } from '@agent-room/shared';
import {
  createMemoryReviewHandler,
  MemoryReviewApiError,
  verifyMemoryReviewRoom,
  type MemoryReviewHttpRuntime,
} from './memory-review.js';

function room(overrides: Partial<Room> = {}): Room {
  return {
    code: 'AAA-BBB-CCC',
    roomInstanceId: randomUUID(),
    topic: 'Review API test',
    createdAt: Date.now(),
    createdBy: 'Host',
    status: 'active',
    version: 1,
    participants: [],
    hostKeyHash: createHash('sha256').update('correct-host-key').digest('hex'),
    ...overrides,
  };
}

function request(method: string, body: Record<string, unknown> = {}) {
  return { method, body } as never;
}

function response() {
  let statusCode = 0;
  let value: unknown;
  const result = {
    status(code: number) { statusCode = code; return result; },
    json(body: unknown) { value = body; return result; },
  };
  return {
    res: result as never,
    status: () => statusCode,
    body: () => value,
  };
}

describe('P5 memory review HTTP API', () => {
  it('validates hostKey against the loaded Room and refuses ended or legacy instances', async () => {
    const active = room();
    const operations = { getRoom: vi.fn(async () => active) };
    expect(await verifyMemoryReviewRoom(active.code, 'correct-host-key', operations))
      .toEqual({ roomInstanceId: active.roomInstanceId });
    await expect(verifyMemoryReviewRoom(active.code, 'wrong-key', operations))
      .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(verifyMemoryReviewRoom(active.code, 'correct-host-key', {
      getRoom: async () => room({ hostKeyHash: undefined }),
    })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(verifyMemoryReviewRoom(active.code, 'correct-host-key', {
      getRoom: async () => room({ roomInstanceId: undefined }),
    })).rejects.toMatchObject({ code: 'REVIEW_REQUIRED', status: 409 });
    await expect(verifyMemoryReviewRoom(active.code, 'correct-host-key', {
      getRoom: async () => room({ status: 'ended' }),
    })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(verifyMemoryReviewRoom(active.code, 'correct-host-key', {
      getRoom: async () => { throw new Error('Redis unavailable'); },
    })).rejects.toMatchObject({ code: 'STORAGE_ERROR', status: 503 });
  });

  it('uses the host-verified server context for pending-list requests', async () => {
    const roomInstanceId = randomUUID();
    const service = {
      listPending: vi.fn(async () => [{ id: randomUUID(), action: 'create' }]),
      review: vi.fn(),
    };
    const runtime: MemoryReviewHttpRuntime = {
      resolveRoom: vi.fn(async (_code, hostKey) => {
        if (hostKey !== 'valid') throw new MemoryReviewApiError('FORBIDDEN', 403);
        return { roomInstanceId };
      }),
      createContext: vi.fn(async () => ({
        service: service as never,
        caller: { roomInstanceId, identity: { type: 'room_owner', id: roomInstanceId }, verified: true },
        close: vi.fn(async () => {}),
      })),
    };
    const handler = createMemoryReviewHandler(runtime);
    const res = response();
    await handler(request('POST', { action: 'list', code: 'AAA-BBB-CCC', hostKey: 'valid' }), res.res);
    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({ items: [{ action: 'create' }] });
    expect(service.listPending).toHaveBeenCalledWith(
      { roomInstanceId, identity: { type: 'room_owner', id: roomInstanceId }, verified: true },
      { limit: 50, offset: 0 },
    );

    const denied = response();
    await handler(request('POST', { action: 'list', code: 'AAA-BBB-CCC', hostKey: 'bad' }), denied.res);
    expect(denied.status()).toBe(403);
    expect(runtime.createContext).toHaveBeenCalledTimes(1);
  });

  it('routes approve/reject through the service with request_id replay keys', async () => {
    const roomInstanceId = randomUUID();
    const proposalId = randomUUID();
    const service = {
      listPending: vi.fn(),
      review: vi.fn(async (_caller, _proposalId, decision) => ({ status: decision === 'approve' ? 'approved' : 'rejected' })),
    };
    const runtime: MemoryReviewHttpRuntime = {
      resolveRoom: async () => ({ roomInstanceId }),
      createContext: async () => ({
        service: service as never,
        caller: { roomInstanceId, identity: { type: 'room_owner', id: roomInstanceId }, verified: true },
        close: async () => {},
      }),
    };
    const handler = createMemoryReviewHandler(runtime);
    for (const decision of ['approve', 'reject'] as const) {
      const res = response();
      await handler(request('POST', {
        action: decision, code: 'AAA-BBB-CCC', hostKey: 'valid', proposalId, requestId: `request-${decision}`,
      }), res.res);
      expect(res.status()).toBe(200);
      expect(service.review).toHaveBeenLastCalledWith(
        expect.objectContaining({ roomInstanceId }), proposalId, decision, `request-${decision}`,
      );
    }
  });

  it('rejects unsupported methods and actions with stable API errors', async () => {
    const runtime: MemoryReviewHttpRuntime = {
      resolveRoom: async () => ({ roomInstanceId: randomUUID() }),
      createContext: async () => { throw new Error('not used'); },
    };
    const handler = createMemoryReviewHandler(runtime);
    const wrongMethod = response();
    await handler(request('GET'), wrongMethod.res);
    expect(wrongMethod.status()).toBe(405);

    const wrongAction = response();
    await handler(request('POST', { action: 'delete', code: 'AAA-BBB-CCC', hostKey: 'valid' }), wrongAction.res);
    expect(wrongAction.status()).toBe(400);
    expect(wrongAction.body()).toEqual({ code: 'INVALID_INPUT' });
  });
});
