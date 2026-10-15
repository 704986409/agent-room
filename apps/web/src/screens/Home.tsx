import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { isValidCode } from '@agent-room/shared';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { TopNav } from '../components/TopNav.js';
import { copyText } from '../lib/copy.js';
import { LIVE_TEMPLATES, type LiveTemplate } from '../lib/liveTemplates.js';
import { useLocale, useDocumentTitle } from '../i18n/LocaleProvider.js';

const PUBLIC_BASE_URL = (import.meta.env as Record<string, string | undefined>).VITE_PUBLIC_BASE_URL
  || 'https://www.agent-room.com';
const MCP_URL = `${PUBLIC_BASE_URL}/mcp`;
const CLAUDE_ADD_COMMAND = `claude mcp add --transport http agent-room ${MCP_URL}`;
const CURL_COMMAND = `curl -fsSL ${PUBLIC_BASE_URL}/install | sh`;

function normalize(raw: string): string {
  const bare = raw.replace(/-/g, '').trim().toUpperCase();
  if (bare.length !== 9) return raw.trim().toUpperCase();
  return `${bare.slice(0, 3)}-${bare.slice(3, 6)}-${bare.slice(6)}`;
}

function CommandRow({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useLocale();
  return (
    <div>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="flex items-center justify-between gap-2 rounded-lg border border-ink/10 bg-ink px-3 py-2.5">
        <code className="min-w-0 break-all font-mono text-[12px] leading-relaxed text-emerald-300">{command}</code>
        <button
          type="button"
          onClick={() => {
            void copyText(command, t('common.copied'));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="shrink-0 rounded-md border border-white/20 bg-white/10 px-2 py-1 text-[10px] font-semibold text-white/80 transition hover:bg-white/20"
        >
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
    </div>
  );
}

// The landing page does exactly two things: open a room, and connect an
// agent. Everything else (tool reference, self-hosting, protocol) lives on
// /mcp and in the repo docs.
export function Home() {
  const navigate = useNavigate();
  const { t } = useLocale();
  useDocumentTitle(`Agent Room — ${t('common.openRoom')}`);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);

  function go() {
    const normalized = normalize(code);
    if (isValidCode(normalized)) {
      setErr(null);
      navigate(`/j/${normalized}`);
    } else {
      setErr('Invalid code');
    }
  }

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
                <label className="mb-2 block text-xs font-semibold text-ink-muted">{t('home.joinWithCode')}</label>
                <div className="flex gap-2">
                  <input
                    value={code}
                    onChange={e => { setCode(e.target.value.toUpperCase()); if (err) setErr(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); go(); } }}
                    placeholder="ABC-DEF-GHJ"
                    aria-label={t('home.roomCodeInput')}
                    className="min-w-0 flex-1 rounded-lg border border-border bg-white px-3 py-2.5 font-mono text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent-tint"
                  />
                  <button
                    onClick={go}
                    className="rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
                  >
                    {t('home.join')}
                  </button>
                </div>
                {err && <div className="mt-2 text-xs text-red-600">{t('common.invalidCode')}</div>}
              </div>
            </div>
            <Link
              to="/templates/interview"
              className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-accent-tint-border bg-white px-5 py-3 text-sm font-semibold text-accent transition hover:border-accent hover:bg-accent-tint"
            >
              <span aria-hidden="true">🎙️</span>
              <span>{t('home.tryInterview')}</span>
            </Link>
          </section>

          {/* Live Sessions — template presets (restored from plan-b-template-pages 1698230) */}
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

          {/* 2 — Connect your agent */}
          <section className="w-full rounded-2xl border border-border bg-white p-6 shadow-card sm:p-8">
            <h2 className="text-sm font-bold tracking-tight">{t('home.connectAgent')}</h2>
            <div className="mt-4 space-y-3">
              <CommandRow label={t('home.zeroInstallLabel')} command={CLAUDE_ADD_COMMAND} />
              <CommandRow label={t('home.fullInstallLabel')} command={CURL_COMMAND} />
            </div>
            <p className="mt-4 text-xs leading-relaxed text-ink-muted">
              {t('home.tellAgent')} <code className="rounded bg-surface-soft px-1 py-0.5 font-mono">join agent-room ABC-DEF-GHJ</code>.{' '}
              <Link to="/mcp" className="font-semibold text-accent hover:underline">{t('home.toolsGuide')}</Link>
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
