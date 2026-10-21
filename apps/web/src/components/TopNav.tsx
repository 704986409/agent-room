import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { AgentRoomLogo } from './AgentRoomLogo.js';
import { LocaleSwitcher } from '../i18n/LocaleSwitcher.js';
import { useLocale } from '../i18n/LocaleProvider.js';
import { AccountApiError, accountApi, type AccountUser } from '../lib/accountApi.js';

export function TopNav() {
  const { t } = useLocale();
  const [user, setUser] = useState<AccountUser | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const refreshAccount = () => {
      void accountApi.me().then(({ user: current }) => {
        if (alive) setUser(current);
      }).catch(error => {
        if (!alive) return;
        if (error instanceof AccountApiError && error.status === 401) setUser(null);
        else setUser(current => current ?? null);
      });
    };
    refreshAccount();
    window.addEventListener('focus', refreshAccount);
    return () => {
      alive = false;
      window.removeEventListener('focus', refreshAccount);
    };
  }, []);

  return (
    <nav className="relative z-10 bg-white">
      <div className="mx-auto flex h-20 max-w-6xl items-center justify-between gap-4 px-6">
        <Link to="/" className="shrink-0 hover:opacity-85 transition" aria-label={t('common.agentRoomHome')}>
          <AgentRoomLogo markClassName="h-8 w-8" wordmarkClassName="text-xl" />
        </Link>
        <div className="flex items-center gap-2">
          <LocaleSwitcher />
          {user ? (
            <Link to="/account" className="max-w-32 truncate text-sm font-medium text-ink-soft hover:text-ink transition" title={user.username}>
              {user.username}
            </Link>
          ) : user === null ? (
            <Link to="/login" className="text-sm font-medium text-ink-soft hover:text-ink transition">
              {t('nav.signIn')}
            </Link>
          ) : (
            <span aria-hidden="true" className="h-5 w-12" />
          )}
          <Link
            to="/new"
            className="inline-flex shrink-0 items-center justify-center rounded-lg border border-accent-tint-border bg-white px-3 py-2.5 text-xs font-semibold text-accent hover:bg-accent-tint transition sm:px-5 sm:text-sm"
          >
            <span className="sm:hidden">{t('navigation.openShort')}</span>
            <span className="hidden sm:inline">{t('common.openRoom')}</span>
          </Link>
        </div>
      </div>
    </nav>
  );
}
