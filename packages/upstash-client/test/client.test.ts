import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient, NetworkError, RateLimitError } from '../src/index.js';

const ENV = { url: 'https://example.upstash.io', token: 'test-token' };

describe('createClient', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('sends a POST to / with Authorization header and command body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: 'hello' })));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const result = await client.command(['GET', 'mykey']);

    expect(result).toBe('hello');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.upstash.io/');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as any).headers['Authorization']).toBe('Bearer test-token');
    expect((init as any).headers).not.toHaveProperty('Cache-Control');
    expect((init as any).headers).not.toHaveProperty('Pragma');
    expect((init as RequestInit).cache).toBe('no-store');
    const body = JSON.parse((init as any).body);
    expect(body).toEqual(['GET', 'mykey']);
  });

  it('throws NetworkError on fetch rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const client = createClient(ENV);
    await expect(client.command(['GET', 'x'])).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws RateLimitError on 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })));
    const client = createClient(ENV);
    await expect(client.command(['GET', 'x'])).rejects.toBeInstanceOf(RateLimitError);
  });

  it('pipeline POSTs to /pipeline and unpacks the result array', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ result: 1 }, { result: 'OK' }]))
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient(ENV);
    const results = await client.pipeline([
      ['RPUSH', 'key', 'a'],
      ['LTRIM', 'key', -5, -1],
    ]);

    expect(results).toEqual([1, 'OK']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.upstash.io/pipeline');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as any).body);
    expect(body).toEqual([
      ['RPUSH', 'key', 'a'],
      ['LTRIM', 'key', -5, -1],
    ]);
  });
});
