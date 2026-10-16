import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJevClient, JevError, type JevQuestion } from './jevClient.js';

const questions: Record<string, JevQuestion> = {
  same: {
    type: 'noul',
    instructions: 'Is the same?',
    criteria: { true: 'same', false: 'different' },
  },
};
type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];
const mockFetch = (implementation: (...args: FetchArgs) => Promise<Response>) =>
  vi.fn<FetchArgs, Promise<Response>>(implementation);

const response = (answers: unknown, status = 200) => new Response(
  JSON.stringify({ model: 'jev-1.13.0', answers, usage: {} }),
  { status, headers: { 'Content-Type': 'application/json' } },
);

describe('Jev HTTP client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('sends the bearer header and documented JSON shape with the default model', async () => {
    const fetchImpl = mockFetch(async () => response({ same: { type: 'noul', noul: 0.8 } }));
    const client = createJevClient({ apiKey: 'test-secret-key', fetchImpl });
    const answers = await client.ask({ title: 'new' }, questions);

    expect(answers.same).toEqual({ type: 'noul', noul: 0.8 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Authorization: 'Bearer test-secret-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'jev-1.13.0', state: { title: 'new' }, questions });
  });

  it('uses configured model and base URL', async () => {
    vi.stubEnv('JEV_MODEL', 'custom-model');
    const fetchImpl = mockFetch(async () => response({ same: { type: 'noul', noul: 1 } }));
    const client = createJevClient({ apiKey: 'test-key', baseUrl: 'https://jev.test/v1/systemone', fetchImpl });
    await client.ask('state', questions);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://jev.test/v1/systemone');
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'custom-model', state: 'state' });
  });

  it('aborts timed out requests', async () => {
    let signal: AbortSignal | null | undefined;
    const fetchImpl = mockFetch((_input, init) => {
      signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const client = createJevClient({ apiKey: 'test-key', timeoutMs: 5, fetchImpl });
    await expect(client.ask('state', questions)).rejects.toMatchObject({ name: 'JevError', status: 0 });
    expect(signal?.aborted).toBe(true);
  });

  it('throws on 429, invalid JSON, and missing answers without exposing the API key', async () => {
    const apiKey = 'never-in-error-test-secret';
    const rateLimited = createJevClient({
      apiKey,
      fetchImpl: mockFetch(async () => new Response('', { status: 429 })),
    });
    const rateError = await rateLimited.ask('state', questions).catch(error => error);
    expect(rateError).toBeInstanceOf(JevError);
    expect(rateError).toMatchObject({ status: 429 });
    expect(String(rateError)).not.toContain(apiKey);

    const invalidJson = createJevClient({
      apiKey,
      fetchImpl: mockFetch(async () => new Response('{', { status: 200 })),
    });
    await expect(invalidJson.ask('state', questions)).rejects.toMatchObject({ name: 'JevError', status: 200 });

    const missing = createJevClient({
      apiKey,
      fetchImpl: mockFetch(async () => response({})),
    });
    await expect(missing.ask('state', questions)).rejects.toMatchObject({ name: 'JevError', status: 200 });
  });
});
