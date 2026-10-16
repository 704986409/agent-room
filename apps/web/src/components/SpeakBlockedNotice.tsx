import { Link } from 'react-router-dom';
import type { SpeakDenialReason } from '@agent-room/shared';
import { useLocale } from '../i18n/LocaleProvider.js';

/**
 * What stands in for the composer when the viewer cannot speak.
 *
 * Rendered in place of <Composer>, so it has to carry the whole explanation on
 * its own: the user has no input to discover the reason by trying. The two
 * reasons need different endings — a muted seat waits for the host, a missing
 * one is only fixed by joining again, so that case gets the link.
 */
export function SpeakBlockedNotice({
  reason,
  host,
  code,
}: {
  reason: SpeakDenialReason;
  host: string;
  code: string;
}) {
  const { t } = useLocale();
  const notMember = reason === 'not_member';
  return (
    <div className="border-t border-border-faint p-5 bg-amber-50 text-center">
      <div className="mb-2 flex justify-center text-amber-700">
        <svg viewBox="0 0 16 16" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 3.5 4.5 6.25H2.5v3.5h2L8 12.5z" />
          <path d="m11 6 3 4M14 6l-3 4" />
        </svg>
      </div>
      <p className="text-sm font-semibold text-amber-900 mb-1">
        {t(notMember ? 'room.notInRoom' : 'room.mutedByHost')}
      </p>
      <p className="text-xs text-amber-800/80 max-w-xs mx-auto">
        {notMember ? t('room.notInRoomMessage') : t('room.hostMutedMessage', { name: host })}
      </p>
      {notMember && (
        <Link
          to={`/j/${code}`}
          className="mt-3 inline-block text-xs font-semibold text-white bg-amber-700 px-3 py-1.5 rounded-md hover:bg-amber-800 active:scale-95 transition"
        >
          {t('room.rejoin')}
        </Link>
      )}
    </div>
  );
}
