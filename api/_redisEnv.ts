import { createClient, type UpstashClient } from '@agent-room/upstash-client';

export function serverRedis(): UpstashClient {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.VITE_UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.VITE_UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const error = new Error('Redis is not configured.');
    error.name = 'RedisNotConfiguredError';
    throw error;
  }
  return createClient({ url, token });
}
