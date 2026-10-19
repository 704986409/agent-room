// Web Redis proxy key policy.
// M1a denies new sensitive prefixes. Write commands stay available for room
// keys until M1b switches the proxy to read-only.

export const SENSITIVE_KEY_PREFIXES = [
  'user:',
  'user-',
  'session:',
  'guest:',
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
] as const;

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
