import type { WakeApi } from './daemon.js';

type FetchFn = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** Outbound client for POST /api/wake. The daemon never listens. */
export function createHttpWakeApi(baseUrl: string, token: string, fetchFn: FetchFn = fetch): WakeApi {
  const endpoint = new URL('/api/wake', baseUrl).toString();
  async function post(body: unknown): Promise<unknown> {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof (payload as { error?: string }).error === 'string' ? (payload as { error: string }).error : 'wake_http');
      throw error;
    }
    return payload;
  }
  return {
    register: body => post({ action: 'register', ...body }) as ReturnType<WakeApi['register']>,
    poll: () => post({ action: 'poll' }) as ReturnType<WakeApi['poll']>,
    claim: body => post({ action: 'claim', ...body }) as ReturnType<WakeApi['claim']>,
    renew: body => post({ action: 'renew', ...body }),
    progress: body => post({ action: 'progress', ...body }),
  };
}
