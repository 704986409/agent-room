import { useEffect } from 'react';
import { useLocale } from '../i18n/LocaleProvider.js';
import { useNetworkOffline } from '../hooks/useNetworkOffline.js';

const BLOCKED_EVENTS = ['pointerdown', 'pointerup', 'click', 'auxclick', 'contextmenu', 'keydown'] as const;

function blockEvent(event: { preventDefault(): void; stopPropagation(): void }) {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Full-page mask while the room host or (on desktop) the local daemon stays unreachable.
 * Soft poll errors keep using the amber `room.connectionRetry` banner.
 */
export function NetworkOfflineOverlay() {
  const offline = useNetworkOffline();
  const { t } = useLocale();

  useEffect(() => {
    if (!offline || typeof window === 'undefined') return;
    for (const type of BLOCKED_EVENTS) window.addEventListener(type, blockEvent, true);
    return () => {
      for (const type of BLOCKED_EVENTS) window.removeEventListener(type, blockEvent, true);
    };
  }, [offline]);

  if (!offline) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="network-offline-title"
      aria-describedby="network-offline-subtitle"
      data-testid="network-offline-overlay"
      className="fixed inset-0 z-[9999] pointer-events-auto flex items-center justify-center bg-ink/92 px-6 text-center text-white"
      onPointerDownCapture={blockEvent}
      onClickCapture={blockEvent}
      onContextMenuCapture={blockEvent}
      onKeyDownCapture={blockEvent}
    >
      <div className="max-w-md">
        <h1 id="network-offline-title" className="text-3xl font-semibold tracking-tight">
          {t('network.offlineTitle')}
        </h1>
        <p id="network-offline-subtitle" className="mt-3 text-base text-white/80">
          {t('network.offlineSubtitle')}
        </p>
      </div>
    </div>
  );
}
