import { Link } from 'react-router-dom';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { TopNav } from '../components/TopNav.js';
import { LIVE_TEMPLATES, type LiveTemplate } from '../lib/liveTemplates.js';
import { useLocale, useDocumentTitle } from '../i18n/LocaleProvider.js';
import { TEMPLATE_PAGES_ENABLED } from '../lib/featureFlags.js';

// The landing page focuses on opening a room and downloading the desktop app.
export function Home() {
  const { t } = useLocale();
  useDocumentTitle(`Agent Room — ${t('common.openRoom')}`);

  return (
    <div className="min-h-screen bg-surface-soft text-ink">
      <TopNav />
      <main className="mx-auto flex min-h-[calc(100vh-64px)] max-w-3xl items-center px-6 py-10">
        <div className="w-full space-y-4">
          {/* 1 — Open a room */}
          <section className="w-full rounded-2xl border border-border bg-white p-6 shadow-card sm:p-8">
            <AgentRoomLogo markClassName="h-10 w-10" wordmarkClassName="text-2xl" />
            <p className="mt-3 text-sm leading-relaxed text-ink-muted">
              {t('home.tagline')}
            </p>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <Link
                to="/new"
                className="flex min-h-28 items-center justify-center rounded-xl bg-accent px-5 py-4 text-base font-semibold text-white shadow-sm transition hover:opacity-90"
              >
                {t('home.createRoom')}
              </Link>
              <div className="min-w-0 rounded-xl border border-border-faint bg-surface-softer p-4">
                <div className="text-xs font-semibold text-ink-muted">{t('home.joinWithCode')}</div>
                <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t('home.inviteOnly')}</p>
              </div>
            </div>
          </section>

          {TEMPLATE_PAGES_ENABLED && (
            <section id="sessions" className="w-full rounded-2xl border border-border bg-white p-6 shadow-card sm:p-8">
              <span className="inline-flex items-center rounded-full border border-border bg-surface-soft px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-ink-muted">
                {t('home.sessionsBadge')}
              </span>
              <h2 className="mt-3 text-sm font-bold tracking-tight">{t('home.sessionsTitle')}</h2>
              <p className="mt-2 text-xs leading-relaxed text-ink-muted">{t('home.sessionsBody')}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {LIVE_TEMPLATES.slice(0, 3).map((tpl: LiveTemplate) => {
                  const statusLabel = tpl.status === 'live-demo' ? t('home.sessionStatusLive')
                    : tpl.status === 'design-preview' ? t('home.sessionStatusPreview')
                    : t('home.sessionStatusSoon');
                  const statusCls = tpl.status === 'live-demo' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : tpl.status === 'design-preview' ? 'bg-amber-50 text-amber-800 border-amber-200'
                    : 'bg-slate-100 text-slate-600 border-slate-200';
                  return (
                    <Link
                      key={tpl.id}
                      to={`/templates/${tpl.slug}`}
                      className="group flex flex-col rounded-xl border border-border-faint bg-surface-softer p-4 transition hover:border-accent/50 hover:bg-white"
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-xl leading-none">{tpl.emoji}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${statusCls}`}>
                          {statusLabel}
                        </span>
                      </div>
                      <div className="text-sm font-semibold tracking-tight transition group-hover:text-accent">{tpl.label}</div>
                      <p className="mt-1 flex-1 text-xs leading-snug text-ink-muted">{tpl.tagline}</p>
                      <div className="mt-3 text-xs font-semibold text-accent">{t('home.sessionView')}</div>
                    </Link>
                  );
                })}
              </div>
              <div className="mt-4 text-right">
                <Link to="/templates" className="text-xs font-semibold text-accent hover:underline">{t('home.sessionsSeeAll')}</Link>
              </div>
            </section>
          )}

          {/* Agent connection setup has moved to /mcp; homepage now points to the desktop app. */}
          <section className="w-full rounded-2xl border border-border bg-white p-6 shadow-card sm:p-8">
            <h2 className="text-sm font-bold tracking-tight">{t('home.downloadDesktopTitle')}</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t('home.downloadDesktopBody')}</p>
            <a
              href="https://github.com/704986409/agent-room/releases"
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
            >
              {t('home.downloadDesktopLink')}
            </a>
          </section>
        </div>
      </main>
    </div>
  );
}
