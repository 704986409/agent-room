import { NetworkError, RateLimitError, UpstashError } from './errors.js';

export interface UpstashEnv {
  url: string;
  token: string;
}

export interface UpstashClient {
  command<T = unknown>(cmd: readonly (string | number)[]): Promise<T>;
  pipeline<T = unknown>(cmds: readonly (readonly (string | number)[])[]): Promise<T[]>;
}

export function createClient(env: UpstashEnv): UpstashClient {
  const base = env.url.replace(/\/$/, '');
  // Polling calls repeat request bodies, so skip the browser HTTP cache.
  // Browser requests through /redis use this client cross-origin. That proxy's
  // CORS allowlist accepts Content-Type and Authorization, so avoid explicit
  // Cache-Control/Pragma request headers that would fail its preflight.
  const headers = {
    'Authorization': `Bearer ${env.token}`,
    'Content-Type': 'application/json',
  };

  async function post(path: string, body: unknown): Promise<unknown> {
    let resp: Response;
    try {
      resp = await fetch(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    } catch (e) {
      throw new NetworkError(e);
    }
    if (resp.status === 429) throw new RateLimitError();
    if (!resp.ok) throw new UpstashError(`Upstash HTTP ${resp.status}`);
    return resp.clone().json();
  }

  return {
    async command<T>(cmd: readonly (string | number)[]): Promise<T> {
      const out = (await post('/', cmd)) as { result: T };
      return out.result;
    },
    async pipeline<T>(cmds: readonly (readonly (string | number)[])[]): Promise<T[]> {
      const out = (await post('/pipeline', cmds)) as Array<{ result: T }>;
      return out.map(x => x.result);
    },
  };
}
