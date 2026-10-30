import type { DetectResult, LauncherAdapter } from './adapter.js';

/**
 * Process-only CLI detect cache. Filled asynchronously at daemon start;
 * cleared on exit. Never persisted across restarts.
 */
const detectCache = new Map<string, DetectResult>();

let inflight: Promise<void> | null = null;
let lastRefreshAt = 0;

export function getCachedDetect(adapterId: string): DetectResult | undefined {
  return detectCache.get(adapterId);
}

export function setCachedDetect(adapterId: string, result: DetectResult): void {
  detectCache.set(adapterId, result);
  // Manual seeds (install success, tests) count as fresh so status will not
  // immediately kick a background re-detect.
  if (lastRefreshAt === 0) lastRefreshAt = Date.now();
}

export function clearDetectCache(): void {
  detectCache.clear();
  lastRefreshAt = 0;
  inflight = null;
}

export function detectCacheSize(): number {
  return detectCache.size;
}

/** Age of the last completed refresh; Infinity when never refreshed. */
export function detectCacheAgeMs(now = Date.now()): number {
  return lastRefreshAt > 0 ? now - lastRefreshAt : Number.POSITIVE_INFINITY;
}

export function detectRefreshInflight(): Promise<void> | null {
  return inflight;
}

/**
 * Run adapter.detect() for every adapter and store results.
 * Failures are cached as { installed: false }.
 */
export async function refreshAdapterDetects(
  adapters: Iterable<LauncherAdapter>,
): Promise<void> {
  for (const adapter of adapters) {
    try {
      const detected = await adapter.detect();
      setCachedDetect(adapter.id, detected);
    } catch {
      setCachedDetect(adapter.id, { installed: false });
    }
  }
  lastRefreshAt = Date.now();
}

/**
 * Deduped background/foreground detect refresh. Concurrent callers share one run.
 */
export function beginDetectRefresh(
  adapters: Iterable<LauncherAdapter>,
): Promise<void> {
  if (inflight) return inflight;
  const list = [...adapters];
  inflight = refreshAdapterDetects(list).finally(() => {
    inflight = null;
  });
  return inflight;
}
