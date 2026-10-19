import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@agent-room/upstash-client';
import { RedisDeviceAuthenticator } from './_wakeDevice.js';
import { installWakeSendHook } from './_wakeSend.js';
import { WakeService, type WakeServiceOptions } from './_wakeService.js';

export function createWakeHandler(options?: WakeServiceOptions & { service?: WakeService }) {
  return async function wakeHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    try {
      const service = options?.service ?? defaultWakeService();
      const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
      const result = await service.handle(authorization, req.body);
      res.status(result.status).json(result.body);
    } catch (error) {
      const code = error instanceof Error && error.message === 'not_configured' ? 'not_configured' : 'internal';
      res.status(code === 'not_configured' ? 500 : 500).json({ error: code });
    }
  };
}

function defaultWakeService(): WakeService {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.VITE_UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.VITE_UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('not_configured');
  const client = createClient({ url, token });
  installWakeSendHook(client);
  return new WakeService(client, { authenticator: new RedisDeviceAuthenticator(client) });
}

export default createWakeHandler();
