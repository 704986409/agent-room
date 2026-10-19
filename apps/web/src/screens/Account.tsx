import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { LocaleSwitcher } from '../i18n/LocaleSwitcher.js';
import { useDocumentTitle, useLocale } from '../i18n/LocaleProvider.js';
import { AccountApiError, accountApi, type AccountSession, type AccountUser } from '../lib/accountApi.js';

export function Account() {
  const { t, formatDateTime } = useLocale();
  useDocumentTitle(t('account.title'));
  const navigate = useNavigate();
  const [user, setUser] = useState<AccountUser | null>(null);
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const [loading, setLoading] = useState(true);

  // Each part renders as soon as it arrives; a slow or failed sessions call no
  // longer leaves the header and admin link blank. One retry covers a request
  // that raced the fresh login cookie.
  async function load(attempt = 0): Promise<void> {
    try {
      const me = await accountApi.me();
      setUser(me.user);
      const listed = await accountApi.sessions();
      setSessions(listed.sessions);
      setError(null);
    } catch (err) {
      if (err instanceof AccountApiError && err.status === 401 && attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 300));
        return load(1);
      }
      throw err;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    const run = () => load().catch(err => {
      if (!alive) return;
      if (err instanceof AccountApiError && err.status === 401) navigate('/login?next=/account');
      else setError(err instanceof Error ? err.message : t('common.unknownError'));
    });
    void run();
    const onVisible = () => { if (document.visibilityState === 'visible') void run(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVisible); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function revoke(id: string) {
    await accountApi.revokeSession(id);
    if (sessions.find(session => session.id === id)?.current) {
      navigate('/login');
      return;
    }
    await load();
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await accountApi.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setNotice(t('account.saved'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.unknownError'));
    }
  }

  return (
    <div className="min-h-screen bg-surface-soft text-ink">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <Link to="/" aria-label={t('common.agentRoomHome')}><AgentRoomLogo markClassName="h-7 w-7" wordmarkClassName="text-base" /></Link>
        <div className="flex items-center gap-3">
          <LocaleSwitcher />
          <button type="button" className="text-sm font-semibold text-ink-soft" onClick={() => { void accountApi.logout().then(() => navigate('/login')); }}>
            {t('account.signOut')}
          </button>
        </div>
      </div>
      <main className="mx-auto max-w-3xl space-y-4 px-6 pb-12">
        <h1 className="text-xl font-semibold">{t('account.title')}</h1>
        {user && <p className="text-sm text-ink-muted">{user.username} · {user.role}</p>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {notice && <p className="text-sm text-emerald-700">{notice}</p>}

        <section className="rounded-xl border border-border bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">{t('account.sessions')}</h2>
            <button type="button" className="text-xs font-semibold text-accent" onClick={() => { void accountApi.revokeOthers().then(() => load()); }}>
              {t('account.revokeOthers')}
            </button>
          </div>
          {loading && sessions.length === 0 ? <p className="mt-3 text-sm text-ink-soft">{t('common.loading')}</p> : sessions.length === 0 ? <p className="mt-3 text-sm text-ink-soft">{t('account.noSessions')}</p> : (
            <ul className="mt-3 space-y-2">
              {sessions.map(session => (
                <li key={session.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-faint px-3 py-2 text-xs">
                  <div>
                    <div className="font-semibold text-ink">{session.label || session.ip}{session.current ? ` · ${t('account.current')}` : ''}</div>
                    <div className="text-ink-soft">{session.ip} · {formatDateTime(session.lastSeenAt)}</div>
                  </div>
                  <button type="button" className="font-semibold text-rose-700" onClick={() => { void revoke(session.id); }}>{t('account.revoke')}</button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-border bg-white p-5">
          <h2 className="text-sm font-semibold">{t('account.devices')}</h2>
          <p className="mt-2 text-sm text-ink-soft">{t('account.devicesPlaceholder')}</p>
        </section>

        <form onSubmit={changePassword} className="rounded-xl border border-border bg-white p-5">
          <h2 className="text-sm font-semibold">{t('account.changePassword')}</h2>
          <label className="mt-3 block text-xs font-semibold text-ink-muted">
            {t('account.currentPassword')}
            <input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm" />
          </label>
          <label className="mt-3 block text-xs font-semibold text-ink-muted">
            {t('account.newPassword')}
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm" />
          </label>
          <button type="submit" className="mt-4 rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white">{t('account.changePassword')}</button>
        </form>
        {user?.role === 'admin' && <Link to="/admin" className="inline-block text-sm font-semibold text-accent">{t('admin.title')}</Link>}
      </main>
    </div>
  );
}
