import type { WakeApi } from './daemon.js';

const WAKE_HTTP_TIMEOUT_MS = 20_000;
/** Long-poll hold is ~30s; leave headroom above the server wait. */
const WAKE_LONG_POLL_TIMEOUT_MS = 40_000;

type FetchFn = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export class WakeHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'WakeHttpError';
    this.status = status;
  }
}

/** Outbound client for POST /api/wake. The daemon never listens. */
export function createHttpWakeApi(
  baseUrl: string,
  token: string | (() => string | Promise<string>),
  fetchFn: FetchFn = fetch,
): WakeApi {
  const endpoint = new URL('/api/wake', baseUrl).toString();
  async function post(body: unknown, timeoutMs = WAKE_HTTP_TIMEOUT_MS): Promise<unknown> {
    const bearer = typeof token === 'function' ? await token() : token;
    if (!bearer) throw new WakeHttpError('unpaired', 0);
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof (payload as { error?: string }).error === 'string' ? (payload as { error: string }).error : 'wake_http';
      throw new WakeHttpError(message, response.status);
    }
    return payload;
  }
  return {
    register: body => post({ action: 'register', ...body }) as ReturnType<WakeApi['register']>,
    poll: (input) => {
      const waitMs = typeof input?.waitMs === 'number' && input.waitMs > 0 ? Math.floor(input.waitMs) : 0;
      const timeoutMs = waitMs > 0 ? WAKE_LONG_POLL_TIMEOUT_MS : WAKE_HTTP_TIMEOUT_MS;
      return post({ action: 'poll', ...(waitMs > 0 ? { waitMs } : {}) }, timeoutMs) as ReturnType<WakeApi['poll']>;
    },
    claim: body => post({ action: 'claim', ...body }) as ReturnType<WakeApi['claim']>,
    renew: body => post({ action: 'renew', ...body }),
    progress: body => post({ action: 'progress', ...body }),
    unregister: body => post({ action: 'unregister', ...body }),
  };
}
