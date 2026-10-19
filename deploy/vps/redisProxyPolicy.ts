// Web Redis proxy key policy.
// The browser credential is read-only. Room keys are readable only after the
// caller proves they hold that room's account session or guest token.

export const REDIS_READ_COMMANDS = new Set([
  'GET', 'MGET', 'LRANGE', 'LLEN', 'SMEMBERS', 'HGET', 'HGETALL', 'EXISTS', 'TTL', 'PING', 'SISMEMBER',
]);

export const SENSITIVE_KEY_PREFIXES = [
  'user:',
  'user-',
  'session:',
  'guest:',
  'guest-',
  'invite:',
  'invite-',
  'device:',
  'device-',
  'wake-',
  'wake:',
  'seat-',
  'seat:',
  'ratelimit:',
  'audit:',
  'audit-',
  'room-members:',
  'room-member:',
  'room-invites:',
  'invite-guests:',
] as const;

const ROOM_KEY_PATTERNS = [
  /^room:([^:]+)$/,
  /^room-msgs:(.+)$/,
  /^room-msg-count:(.+)$/,
  /^room-webhooks:(.+)$/,
  /^room-report:(.+)$/,
  /^room-typing:(.+)$/,
  /^turn-state:(.+)$/,
  /^task-board:(.+)$/,
  /^sweepDeadEnd:([^:]+)/,
];

export function roomCodeFromRedisKey(key: string): string | null {
  for (const pattern of ROOM_KEY_PATTERNS) {
    const match = pattern.exec(key);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Keys a read command is about. PING has none. Unmapped keys are rejected by the caller. */
export function redisCommandKeys(command: readonly unknown[]): string[] {
  const name = String(command[0] ?? '').trim().toUpperCase();
  if (name === 'PING') return [];
  if (name === 'MGET') return command.slice(1).filter((item): item is string => typeof item === 'string');
  const key = command[1];
  return typeof key === 'string' ? [key] : [];
}

export function isSensitiveRedisKey(value: string): boolean {
  return SENSITIVE_KEY_PREFIXES.some(prefix => value.startsWith(prefix));
}

/** Every command argument is checked. Values that merely contain a prefix are not keys. */
export function commandExposesSensitiveKey(command: readonly unknown[]): string | null {
  for (const argument of command.slice(1)) {
    if (typeof argument === 'string' && isSensitiveRedisKey(argument)) return argument;
  }
  return null;
}
