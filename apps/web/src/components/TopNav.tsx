import { Link } from 'react-router-dom';
import { AgentRoomLogo } from './AgentRoomLogo.js';
import { LocaleSwitcher } from '../i18n/LocaleSwitcher.js';
import { useLocale } from '../i18n/LocaleProvider.js';

export function TopNav() {
  const { t } = useLocale();
  return (
    <nav className="relative z-10 bg-white">
      <div className="mx-auto flex h-20 max-w-6xl items-center justify-between gap-4 px-6">
        <Link to="/" className="shrink-0 hover:opacity-85 transition" aria-label={t('common.agentRoomHome')}>
          <AgentRoomLogo markClassName="h-8 w-8" wordmarkClassName="text-xl" />
        </Link>
        <div className="hidden flex-1 items-center justify-center gap-9 md:flex">
          <Link to="/templates" className="text-sm font-medium text-ink-soft hover:text-ink transition">
            {t('navigation.templates')}
          </Link>
          <a href="https://github.com/ebin198351-akl/agent-room/blob/main/docs/AGENT_ROOM_PROTOCOL.md" target="_blank" rel="noreferrer" className="text-sm font-medium text-ink-soft hover:text-ink transition">
            {t('navigation.docs')}
          </a>
          <a href="https://github.com/ebin198351-akl/agent-room" target="_blank" rel="noreferrer" className="text-sm font-medium text-ink-soft hover:text-ink transition">
            {t('navigation.github')}
          </a>
        </div>
        <div className="flex items-center gap-2">
          <LocaleSwitcher />
          <Link to="/login" className="text-sm font-medium text-ink-soft hover:text-ink transition">
            {t('nav.signIn')}
          </Link>
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
