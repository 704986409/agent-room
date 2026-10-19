import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { LocaleSwitcher } from '../i18n/LocaleSwitcher.js';
import { useDocumentTitle, useLocale } from '../i18n/LocaleProvider.js';
import { accountApi, type AccountUser } from '../lib/accountApi.js';
import { roomApi, RoomWriteError } from '../lib/roomWrites.js';

export function Invite() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { t } = useLocale();
  useDocumentTitle(t('invite.title'));
  const [user, setUser] = useState<AccountUser | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    accountApi.me().then(body => setUser(body.user)).catch(() => setUser(null));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const joined = await roomApi.acceptInvite({
        token,
        ...(user ? {} : { displayName: displayName.trim() }),
      });
      sessionStorage.setItem(`room:${joined.code}:self`, JSON.stringify({ name: joined.name, role: '' }));
      navigate(`/r/${joined.code}`);
    } catch (err) {
      setError(err instanceof RoomWriteError ? err.message : t('common.unknownError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface-soft text-ink">
      <div className="mx-auto flex max-w-md items-center justify-between px-6 py-5">
        <Link to="/" aria-label={t('common.agentRoomHome')}><AgentRoomLogo markClassName="h-7 w-7" wordmarkClassName="text-base" /></Link>
        <LocaleSwitcher />
      </div>
      <form onSubmit={submit} className="mx-auto mt-6 max-w-md rounded-xl border border-border bg-surface p-8 shadow-card">
        <h1 className="text-lg font-semibold">{t('invite.title')}</h1>
        {user ? (
          <p className="mt-3 text-sm text-ink-muted">{t('invite.asAccount', { name: user.username })}</p>
        ) : (
          <label className="mt-5 block text-xs font-semibold text-ink-muted">
            {t('invite.displayName')}
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm" />
          </label>
        )}
        {error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}
        <button type="submit" disabled={busy || (!user && !displayName.trim())} className="mt-5 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          {busy ? t('invite.joining') : t('invite.join')}
        </button>
        {!user && (
          <Link to={`/login?next=${encodeURIComponent(`/i/${token}`)}`} className="mt-4 block text-center text-xs font-semibold text-accent">
            {t('account.signIn')}
          </Link>
        )}
      </form>
    </div>
  );
}
