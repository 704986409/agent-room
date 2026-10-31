import { useEffect, useState } from 'react';
import { isDesktopShell } from '../lib/desktopHost.js';
import {
  REACHABILITY_POLL_MS,
  createOfflineGate,
  probeRoomAndDaemon,
  reachabilityFailed,
  reduceOfflineGate,
  type OfflineGateState,
} from '../lib/networkReachability.js';

/**
 * Full-page offline mask.
 *
 * Samples about every {@link REACHABILITY_POLL_MS}. The mask turns on after one
 * failed cycle (~1s) and turns off on the next success. `online` / `offline`
 * start a sample immediately, but a recovery still has to pass the probes
 * before the mask hides — `navigator.onLine` alone is not treated as proof the
 * network is back.
 */
export function useNetworkOffline(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let gate: OfflineGateState = createOfflineGate();
    let cancelled = false;
    let pending = false;
    let active: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const publish = (failed: boolean) => {
      gate = reduceOfflineGate(gate, failed);
      if (!cancelled) setVisible(gate.visible);
    };

    const requestCycle = () => {
      if (cancelled) return;
      if (active) {
        pending = true;
        return;
      }
      active = (async () => {
        const snapshot = await probeRoomAndDaemon(fetch, isDesktopShell());
        if (cancelled || pending) return;
        const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
        publish(reachabilityFailed({ browserOffline, ...snapshot }));
      })().finally(() => {
        active = null;
        if (cancelled) return;
        if (pending) {
          pending = false;
          requestCycle();
        }
      });
    };

    const arm = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (cancelled) return;
        requestCycle();
        void active?.finally(() => {
          if (!cancelled) arm(REACHABILITY_POLL_MS);
        });
      }, delay);
    };

    // Browser events wake a probe. Hiding still waits for that probe to succeed;
    // showing needs one failed cycle so an unreachable page masks within ~1s.
    const onBrowserNet = () => requestCycle();
    window.addEventListener('online', onBrowserNet);
    window.addEventListener('offline', onBrowserNet);
    arm(REACHABILITY_POLL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', onBrowserNet);
      window.removeEventListener('offline', onBrowserNet);
    };
  }, []);

  return visible;
}
