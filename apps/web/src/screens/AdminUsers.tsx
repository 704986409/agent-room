import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { LocaleSwitcher } from '../i18n/LocaleSwitcher.js';
import { useDocumentTitle, useLocale } from '../i18n/LocaleProvider.js';
import { AccountApiError, accountApi, type AccountUser } from '../lib/accountApi.js';

export function AdminUsers() {
  const { t } = useLocale();
  useDocumentTitle(t('admin.title'));
  const navigate = useNavigate();
  const [users, setUsers] = useState<AccountUser[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const listed = await accountApi.users();
    setUsers(listed.users);
  }

  useEffect(() => {
    load().catch(err => {
      if (err instanceof AccountApiError && err.status === 401) navigate('/login');
      else setError(err instanceof Error ? err.message : t('common.unknownError'));
    });
  }, [navigate, t]);

  async function addUser(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await accountApi.addUser(username.trim(), password, role);
      setUsername('');
      setPassword('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.unknownError'));
    }
  }

  return (
    <div className="min-h-screen bg-surface-soft text-ink">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <Link to="/account" aria-label={t('common.agentRoomHome')}><AgentRoomLogo markClassName="h-7 w-7" wordmarkClassName="text-base" /></Link>
        <LocaleSwitcher />
      </div>
      <main className="mx-auto max-w-3xl space-y-4 px-6 pb-12">
        <h1 className="text-xl font-semibold">{t('admin.title')}</h1>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <form onSubmit={addUser} className="rounded-xl border border-border bg-white p-5">
          <h2 className="text-sm font-semibold">{t('admin.addUser')}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <input value={username} onChange={e => setUsername(e.target.value)} placeholder={t('account.username')} className="rounded-lg border border-border px-3 py-2 text-sm" />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={t('admin.initialPassword')} className="rounded-lg border border-border px-3 py-2 text-sm" />
            <select value={role} onChange={e => setRole(e.target.value === 'admin' ? 'admin' : 'user')} className="rounded-lg border border-border px-3 py-2 text-sm">
              <option value="user">{t('admin.roleUser')}</option>
              <option value="admin">{t('admin.roleAdmin')}</option>
            </select>
          </div>
          <button type="submit" className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">{t('admin.addUser')}</button>
        </form>
        <ul className="space-y-2">
          {users.map(user => (
            <li key={user.id} className="rounded-xl border border-border bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">{user.username} · {user.role}</div>
                  {user.disabled && <div className="text-xs text-rose-700">{t('admin.disabled')}</div>}
                </div>
                <div className="flex flex-wrap gap-2 text-xs font-semibold">
                  {user.disabled
                    ? <button type="button" onClick={() => { void accountApi.enableUser(user.id).then(load); }}>{t('admin.enable')}</button>
                    : <button type="button" onClick={() => { void accountApi.disableUser(user.id).then(load); }}>{t('admin.disable')}</button>}
                  <button type="button" onClick={() => {
                    const next = window.prompt(t('admin.resetPassword'));
                    if (next) void accountApi.resetPassword(user.id, next).then(load).catch(err => setError(err instanceof Error ? err.message : t('common.unknownError')));
                  }}>{t('admin.resetPassword')}</button>
                  <button type="button" onClick={() => { void accountApi.revokeUserSessions(user.id); }}>{t('admin.revokeSessions')}</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
