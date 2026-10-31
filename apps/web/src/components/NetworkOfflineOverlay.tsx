import { useEffect } from 'react';
import { createPortal } from 'react-dom';
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

  const node = (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="network-offline-title"
      aria-describedby="network-offline-subtitle"
      data-testid="network-offline-overlay"
      className="fixed inset-0 pointer-events-auto flex items-center justify-center px-6 text-center"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483647,
        backgroundColor: 'rgba(88, 92, 104, 0.72)',
        backdropFilter: 'blur(18px) saturate(120%)',
        WebkitBackdropFilter: 'blur(18px) saturate(120%)',
      }}
      onPointerDownCapture={blockEvent}
      onClickCapture={blockEvent}
      onContextMenuCapture={blockEvent}
      onKeyDownCapture={blockEvent}
    >
      <div className="max-w-md rounded-2xl px-10 py-8 shadow-2xl" style={{ backgroundColor: 'rgba(255,255,255,0.95)', color: '#111827' }}>
        <div aria-hidden="true" className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#5b63f0' }} />
        <h1 id="network-offline-title" className="text-3xl font-semibold tracking-tight">
          {t('network.offlineTitle')}
        </h1>
        <p id="network-offline-subtitle" className="mt-3 text-base text-gray-600">
          {t('network.offlineSubtitle')}
        </p>
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
}
