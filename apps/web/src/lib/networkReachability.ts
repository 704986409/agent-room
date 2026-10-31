import { DESKTOP_CONTROL_ORIGIN } from './desktopHost.js';

/** Same-origin room process. Any HTTP response counts as up; only a thrown fetch does not. */
export const ROOM_HEALTH_PATH = '/healthz';

/** Loopback daemon. Checked only inside the desktop shell. */
export const DESKTOP_DAEMON_PING_URL = `${DESKTOP_CONTROL_ORIGIN}/api/desktop/ping`;

export const DESKTOP_PROBE_HEADER = 'x-agent-room-desktop';

export const PROBE_TIMEOUT_MS = 1_000;

/** Poll period. One failed cycle shows the mask within about one second. */
export const REACHABILITY_POLL_MS = 1_000;

/** Consecutive failed cycles required before the full-page mask appears. */
export const OFFLINE_FAILURES_BEFORE_SHOW = 1;

export interface ProbeSnapshot {
  roomReachable: boolean;
  /** Null when this client is not the desktop shell and the daemon was not probed. */
  daemonReachable: boolean | null;
}

export interface ReachabilitySignals extends ProbeSnapshot {
  /** True only when `navigator.onLine === false`. */
  browserOffline: boolean;
}

export interface OfflineGateState {
  visible: boolean;
  consecutiveFailures: number;
}

export function createOfflineGate(): OfflineGateState {
  return { visible: false, consecutiveFailures: 0 };
}

/**
 * One poll cycle. A failure increments the streak; the mask appears after
 * `showAfterFailures` in a row (default 1 → within about one poll). A single
 * success hides it and clears the streak.
 */
export function reduceOfflineGate(
  state: OfflineGateState,
  failed: boolean,
  showAfterFailures = OFFLINE_FAILURES_BEFORE_SHOW,
): OfflineGateState {
  if (!failed) return { visible: false, consecutiveFailures: 0 };
  const consecutiveFailures = state.consecutiveFailures + 1;
  return {
    consecutiveFailures,
    visible: state.visible || consecutiveFailures >= showAfterFailures,
  };
}

/** Offline when the browser, the room host, or (on desktop) the local daemon fails. */
export function reachabilityFailed(signals: ReachabilitySignals): boolean {
  if (signals.browserOffline) return true;
  if (!signals.roomReachable) return true;
  if (signals.daemonReachable === false) return true;
  return false;
}

/**
 * GET `url`. Resolves true for any HTTP response (including 401/403/500).
 * Resolves false when fetch throws or the timeout aborts the request.
 */
export async function probeReachable(
  url: string,
  fetchImpl: typeof fetch,
  init?: RequestInit,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      ...init,
      method: 'GET',
      signal: controller.signal,
    });
    const cancel = response.body?.cancel();
    if (cancel) void cancel.catch(() => { /* unread health body */ });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the room host and, when `desktop` is set, the loopback daemon. Probes run together. */
export async function probeRoomAndDaemon(
  fetchImpl: typeof fetch,
  desktop: boolean,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeSnapshot> {
  const [roomReachable, daemonReachable] = await Promise.all([
    probeReachable(ROOM_HEALTH_PATH, fetchImpl, undefined, timeoutMs),
    desktop
      ? probeReachable(DESKTOP_DAEMON_PING_URL, fetchImpl, {
        headers: { [DESKTOP_PROBE_HEADER]: '1' },
      }, timeoutMs)
      : Promise.resolve(null),
  ]);
  return { roomReachable, daemonReachable };
}

type FailureListener = () => void;
const failureListeners = new Set<FailureListener>();

/** Subscribe to instant network-failure signals (failed app fetch, abnormal WS close). */
export function onNetworkFailure(listener: FailureListener): () => void {
  failureListeners.add(listener);
  return () => { failureListeners.delete(listener); };
}

/** Report a network-level failure; listeners show the mask immediately. */
export function reportNetworkFailure(): void {
  for (const l of [...failureListeners]) {
    try { l(); } catch { /* ignore */ }
  }
}

let originalFetch: typeof fetch | null = null;

/** Unwrapped fetch for probes, so probe failures do not loop through the hook. */
export function rawFetch(): typeof fetch {
  return originalFetch ?? globalThis.fetch.bind(globalThis);
}

/** True for a thrown network error (not an abort / timeout we started). */
export function isNetworkError(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') return false;
  return err instanceof TypeError;
}

/**
 * Wrap window.fetch: any network-level failure of the app's own requests
 * reports immediately. Returns a restore function.
 */
export function installFetchFailureHook(): () => void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function' || originalFetch) return () => {};
  const orig = window.fetch.bind(window);
  originalFetch = orig;
  const wrapped: typeof fetch = async (...args) => {
    try {
      return await orig(...args);
    } catch (err) {
      if (isNetworkError(err)) reportNetworkFailure();
      throw err;
    }
  };
  window.fetch = wrapped;
  return () => {
    if (window.fetch === wrapped) window.fetch = orig;
    originalFetch = null;
  };
}
