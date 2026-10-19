import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { LocaleSwitcher } from '../i18n/LocaleSwitcher.js';
import { useDocumentTitle, useLocale } from '../i18n/LocaleProvider.js';
import { AccountApiError, accountApi } from '../lib/accountApi.js';

export function Login() {
  const { t } = useLocale();
  useDocumentTitle(t('account.loginTitle'));
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await accountApi.login(username.trim(), password);
      navigate('/account');
    } catch (err) {
      setError(err instanceof AccountApiError ? err.message : t('common.unknownError'));
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
        <h1 className="text-lg font-semibold">{t('account.loginTitle')}</h1>
        <label className="mt-5 block text-xs font-semibold text-ink-muted">
          {t('account.username')}
          <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm" />
        </label>
        <label className="mt-4 block text-xs font-semibold text-ink-muted">
          {t('account.password')}
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm" />
        </label>
        {error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}
        <button type="submit" disabled={busy} className="mt-5 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          {t('account.signIn')}
        </button>
      </form>
    </div>
  );
}
