import { useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.js';
import { requestAgentInvite, storedRoomHostKey } from '../lib/agentInvite.js';
import { hostOnThisMachine, isDesktopShell } from '../lib/desktopHost.js';

const DEFAULT_ROLE = '开发工程师';

/** Host-only, desktop-webview-only. Hidden in a normal browser so it cannot call loopback from the public site. */
export function HostLocalButton({ roomCode, isHost, ended }: {
  roomCode: string;
  isHost: boolean;
  ended: boolean;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!isHost || !isDesktopShell()) return null;

  async function host() {
    const hostKey = storedRoomHostKey(roomCode);
    if (!hostKey) { setError(t('inviteAgent.hostKeyMissing')); return; }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const invite = await requestAgentInvite(roomCode, hostKey, DEFAULT_ROLE);
      const seated = await hostOnThisMachine({
        code: roomCode,
        inviteCode: invite.inviteCode,
        name: DEFAULT_ROLE,
      });
      setDone(t('desktopHost.started', { name: seated.seat.name || DEFAULT_ROLE }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.unknownError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        disabled={ended || busy}
        onClick={() => { void host(); }}
        className="w-full min-h-10 sm:min-h-8 text-[13px] sm:text-xs font-semibold text-white bg-emerald-700 px-3 rounded-lg transition active:scale-[0.98] hover:opacity-90 disabled:opacity-50"
      >
        {busy ? t('desktopHost.starting') : t('desktopHost.button')}
      </button>
      {done && <p className="mt-1 text-[11px] text-emerald-700">{done}</p>}
      {error && <p className="mt-1 text-[11px] text-red-700">{error}</p>}
    </div>
  );
}
