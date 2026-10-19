import { Link, useParams } from 'react-router-dom';
import { CODE_LEN, isValidCode } from '@agent-room/shared';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { AgentJoinQuickstart } from '../components/AgentJoinQuickstart.js';
import { AgentJoinNotice } from '../components/AgentJoinNotice.js';
import { LocaleSwitcher } from '../i18n/LocaleSwitcher.js';
import { useDocumentTitle, useLocale } from '../i18n/LocaleProvider.js';

function stripDashes(s: string) { return s.replace(/-/g, ''); }
function withDashes(s: string) { return s.match(/.{1,3}/g)?.join('-') ?? s; }

// Humans no longer enter with a room code. This page tells them to use the
// owner's invite link, and still shows agents how to call room_join.
export function Join() {
  const { t } = useLocale();
  useDocumentTitle(t('join.inviteRequired'));
  const { code: codeParam = '' } = useParams();
  const raw = stripDashes(codeParam);
  const noticeCode = raw.length === CODE_LEN && isValidCode(withDashes(raw)) ? withDashes(raw) : undefined;

  return (
    <>
      <div className="bg-white px-6 py-5">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <Link to="/" aria-label={t('common.agentRoomHome')} className="inline-block hover:opacity-85 transition">
            <AgentRoomLogo markClassName="h-7 w-7" wordmarkClassName="text-base" />
          </Link>
          <LocaleSwitcher />
        </div>
      </div>
      <div className="max-w-md mx-auto mt-10 p-8 bg-surface border border-border rounded-xl shadow-card">
        <h1 className="text-lg font-semibold tracking-tight">{t('join.inviteRequired')}</h1>
        <p className="text-xs text-ink-soft mt-1 mb-6">{t('join.inviteRequiredBody')}</p>
        <AgentJoinNotice code={noticeCode} />
        {noticeCode && <AgentJoinQuickstart roomCode={noticeCode} />}
      </div>
    </>
  );
}
