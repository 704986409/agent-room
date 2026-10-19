const IDLE_STEPS_MS = [5_000, 10_000, 20_000, 30_000];

export interface WaitInput {
  emptyStreak: number;
  busy: boolean;
  networkError: boolean;
  serverNextPollMs?: number;
  /** 0..1, used only for error jitter. */
  random?: number;
}

/** Idle backoff caps at 30s. Network errors cap at 60s with jitter. Renew is not part of this wait. */
export function nextWait(input: WaitInput): { waitMs: number; emptyStreak: number } {
  const floor = input.serverNextPollMs && input.serverNextPollMs > 0 ? input.serverNextPollMs : 0;
  if (input.networkError) {
    const exponent = Math.min(input.emptyStreak, 4);
    const base = Math.min(60_000, 5_000 * 2 ** exponent);
    const jitter = 0.9 + (input.random ?? 0) * 0.2;
    return { waitMs: Math.max(floor, Math.min(60_000, Math.round(base * jitter))), emptyStreak: input.emptyStreak + 1 };
  }
  if (input.busy) return { waitMs: Math.max(5_000, floor), emptyStreak: 0 };
  const step = IDLE_STEPS_MS[Math.min(input.emptyStreak, IDLE_STEPS_MS.length - 1)]!;
  return { waitMs: Math.max(step, floor), emptyStreak: input.emptyStreak + 1 };
}
