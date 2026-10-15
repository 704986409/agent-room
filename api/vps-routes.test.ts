// Guards the VPS server's explicit API_HANDLERS table: every Vercel function
// that the web app calls must be routed, or it 404s only in VPS deploys.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

process.env.UPSTASH_REDIS_REST_URL ??= 'https://routes.upstash.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'routes-token';

const { createVpsApp } = await import('../deploy/vps/server.js');
type VpsApp = ReturnType<typeof createVpsApp>;

let app: VpsApp;
let base: string;

beforeAll(async () => {
  app = createVpsApp({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => { await app?.close(); });

async function probe(path: string) {
  const res = await fetch(base + path, { method: 'GET' });
  const text = await res.text();
  return { status: res.status, routeMissing: res.status === 404 && text.includes('"not_found"') };
}

describe('VPS API routing', () => {
  it('returns route-level not_found for unknown handlers (control)', async () => {
    expect((await probe('/api/definitely-not-a-handler')).routeMissing).toBe(true);
  });
  for (const path of ['/api/interview-reply', '/api/stt', '/api/elevenlabs-tts']) {
    it(`routes ${path} to a handler`, async () => {
      expect((await probe(path)).routeMissing).toBe(false);
    });
  }
});
