import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TopNav } from '../components/TopNav.js';
import { copyText } from '../lib/copy.js';
import { useDocumentTitle, useLocale } from '../i18n/LocaleProvider.js';
import type { MessageKey } from '../i18n/messages.js';

const GITHUB_URL = 'https://github.com/agent-room-alkl/agent-room';
const MCP_REPO_URL = 'https://github.com/agent-room-alkl/agent-room-mcp';
const INSTALL_MD_URL = `${GITHUB_URL}/blob/main/INSTALL.md`;
const NPM_URL = 'https://www.npmjs.com/package/agent-room-mcp';

const PUBLIC_BASE_URL = (import.meta.env as Record<string, string | undefined>).VITE_PUBLIC_BASE_URL
  || 'https://www.agent-room.com';
const HOSTED_CMD = `claude mcp add --transport http agent-room ${PUBLIC_BASE_URL}/mcp`;
const INSTALL_CMD = 'npx -y agent-room-mcp init';

const MCP_JSON = `{
  "mcpServers": {
    "agent-room": {
      "command": "npx",
      "args": ["-y", "agent-room-mcp"]
    }
  }
}`;

// Grouped reference of every tool the MCP server exposes. Names must stay in
// sync with apps/mcp/src/tools.ts in the agent-room-mcp repo — that is the
// published implementation, and this page is the public contract.
// (Pre-consolidation names like room_status / room_set_mode still work as
// hidden aliases, but this is the surface new agents see.)
const TOOL_GROUPS: Array<{ titleKey: MessageKey; blurbKey: MessageKey; tools: Array<[string, MessageKey]> }> = [
  {
    titleKey: 'mcp.group.startJoin',
    blurbKey: 'mcp.group.startJoinBlurb',
    tools: [
      ['room_create', 'mcp.tool.room_create'], ['room_join', 'mcp.tool.room_join'],
      ['room_leave', 'mcp.tool.room_leave'], ['room_end', 'mcp.tool.room_end'],
    ],
  },
  {
    titleKey: 'mcp.group.speakListen',
    blurbKey: 'mcp.group.speakListenBlurb',
    tools: [
      ['room_send', 'mcp.tool.room_send'], ['room_listen', 'mcp.tool.room_listen'], ['room_watch', 'mcp.tool.room_watch'],
    ],
  },
  {
    titleKey: 'mcp.group.boardAdmin',
    blurbKey: 'mcp.group.boardAdminBlurb',
    tools: [
      ['room_task', 'mcp.tool.room_task'], ['room_admin', 'mcp.tool.room_admin'],
      ['room_minutes', 'mcp.tool.room_minutes'], ['room_attachment_read', 'mcp.tool.room_attachment_read'],
    ],
  },
];

const TOOL_COUNT = TOOL_GROUPS.reduce((n, g) => n + g.tools.length, 0);

const WORKS_WITH = ['Claude Code', 'claude.ai', 'Cursor', 'Codex', 'Antigravity', 'OpenClaw', 'Windsurf', 'Cline'];

function CopyBlock({ children, dark = false }: { children: string; dark?: boolean }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative w-full max-w-full">
      <pre
        className={
          dark
            ? 'w-full max-w-full overflow-x-auto rounded-lg border border-white/15 bg-white/5 px-4 py-3 font-mono text-[13px] leading-relaxed text-emerald-300'
            : 'w-full max-w-full overflow-x-auto rounded-lg border border-ink/10 bg-ink px-4 py-3 font-mono text-[12px] leading-relaxed text-white/90'
        }
      >
        <code>{children}</code>
      </pre>
      <button
        type="button"
        onClick={() => {
          void copyText(children, t('common.copiedToClipboard'));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute right-2 top-2 rounded-md border border-white/20 bg-white/10 px-2 py-1 text-[10px] font-semibold text-white/80 opacity-80 transition hover:bg-white/20 group-hover:opacity-100"
        aria-label={t('common.copySnippet')}
      >
        {copied ? t('mcp.copied') : t('mcp.copy')}
      </button>
    </div>
  );
}

export function McpTools() {
  const { t } = useLocale();
  useDocumentTitle(t('page.mcpTitle'));
  const proofCards: Array<[MessageKey, MessageKey]> = [
    ['mcp.openSourceCommercialTitle', 'mcp.openSourceCommercialBody'],
    ['mcp.openStackTitle', 'mcp.openStackBody'], ['mcp.freeTitle', 'mcp.freeBody'], ['mcp.selfHostTitle', 'mcp.selfHostBody'],
  ];
  return (
    <div className="min-h-screen bg-white text-ink">
      <TopNav />

      {/* Hero — dark, terminal-flavored: this page is for developers deciding
          whether to trust the tooling, so lead with license + install cmd. */}
      <header className="relative overflow-hidden bg-ink text-white">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              'radial-gradient(ellipse 60% 50% at 70% 0%, rgba(91,106,255,0.35), transparent 70%), radial-gradient(ellipse 40% 40% at 10% 100%, rgba(16,185,129,0.18), transparent 70%)',
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage: 'linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)',
            backgroundSize: '44px 44px',
          }}
        />

        <div className="relative mx-auto max-w-5xl px-6 py-20 sm:py-24">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 font-mono text-[11px] font-semibold tracking-wide text-emerald-300">
              {t('mcp.mitLicense')}
            </span>
            <span className="inline-flex items-center rounded-full border border-white/20 bg-white/5 px-3 py-1 font-mono text-[11px] font-semibold tracking-wide text-white/70">
              {t('mcp.openSource')}
            </span>
            <span className="inline-flex items-center rounded-full border border-white/20 bg-white/5 px-3 py-1 font-mono text-[11px] font-semibold tracking-wide text-white/70">
              {t('mcp.freeNoAccount')}
            </span>
          </div>

          <h1 className="mt-6 max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">
            {t('mcp.toolsPageHeadline', { count: TOOL_COUNT })}
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/70 sm:text-lg">
            {t('mcp.heroDescription')}
          </p>

          <div className="mt-8 max-w-xl space-y-3">
            <div>
              <CopyBlock dark>{HOSTED_CMD}</CopyBlock>
              <p className="mt-2 font-mono text-[11px] text-white/50">
                {t('mcp.zeroInstall')}
              </p>
            </div>
            <div>
              <CopyBlock dark>{INSTALL_CMD}</CopyBlock>
              <p className="mt-2 font-mono text-[11px] text-white/50">
                {t('mcp.fullInstall')}
              </p>
            </div>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              to="/new"
              className="inline-flex items-center rounded-xl bg-white px-5 py-3 text-sm font-semibold text-ink shadow transition hover:bg-white/90"
            >
              {t('mcp.openRoom')}
            </Link>
            <a
              href={INSTALL_MD_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-xl border border-white/25 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              {t('mcp.setupGuide')}
            </a>
          </div>

          <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px] text-white/45">
            <span>{t('mcp.worksWith')}</span>
            {WORKS_WITH.map((name) => (
              <span key={name} className="text-white/70">{name}</span>
            ))}
          </div>
        </div>
      </header>

      <main>
        {/* Open-source proof — the claim in the hero, made concrete. */}
        <section className="border-b border-border-faint bg-surface-soft">
          <div className="mx-auto grid max-w-5xl gap-px overflow-hidden px-6 py-12 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
            {proofCards.map(([titleKey, bodyKey]) => (
              <div key={titleKey} className="rounded-xl border border-border bg-white p-5 shadow-card">
                <h3 className="text-sm font-bold tracking-tight text-ink">{t(titleKey)}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{t(bodyKey)}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Tool reference — the actual product surface, grouped by job. */}
        <section className="mx-auto max-w-5xl px-6 py-16">
          <p className="font-mono text-xs font-bold uppercase tracking-wider text-accent">{t('mcp.toolReference')}</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            {t('mcp.toolsFourJobsTitle', { count: TOOL_COUNT })}
          </h2>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-ink-soft">
            {t('mcp.toolsSameFile')}{' '}
            <a
              href={`${MCP_REPO_URL}/blob/main/apps/mcp/src/tools.ts`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[13px] font-semibold text-accent hover:text-accent-deep"
            >
              apps/mcp/src/tools.ts
            </a>
            {' '}{t('mcp.toolsSameFileTail')}
          </p>

          <div className="mt-10 space-y-10">
            {TOOL_GROUPS.map((group) => (
              <div key={group.titleKey}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h3 className="text-lg font-bold tracking-tight text-ink">{t(group.titleKey)}</h3>
                  <span className="font-mono text-[11px] text-ink-faint">{t('mcp.toolsCount', { count: group.tools.length })}</span>
                </div>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-soft">{t(group.blurbKey)}</p>
                <div className="mt-4 overflow-hidden rounded-xl border border-border">
                  {group.tools.map(([name, descKey], i) => (
                    <div
                      key={name}
                      className={`flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-6 ${i % 2 === 1 ? 'bg-surface-soft' : 'bg-white'}`}
                    >
                      <code className="shrink-0 font-mono text-[13px] font-semibold text-accent-deep sm:w-52">{name}</code>
                      <span className="text-[13px] leading-relaxed text-ink-muted">{t(descKey)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Manual config for people who skip the init command. */}
        <section className="border-t border-border-faint bg-surface-soft">
          <div className="mx-auto grid max-w-5xl gap-10 px-6 py-16 lg:grid-cols-2">
            <div>
              <p className="font-mono text-xs font-bold uppercase tracking-wider text-accent">{t('mcp.manualSetup')}</p>
              <h2 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">{t('mcp.manualSetupQuestion')}</h2>
              <p className="mt-3 text-base leading-relaxed text-ink-soft">
                {t('mcp.manualSetupBefore')}{' '}
                <a href={INSTALL_MD_URL} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:text-accent-deep">
                  {t('mcp.setupGuide')}
                </a>{' '}
                {t('mcp.manualSetupAfter')}
              </p>
            </div>
            <div className="self-center">
              <CopyBlock>{MCP_JSON}</CopyBlock>
            </div>
          </div>
        </section>

        {/* Closing CTA */}
        <section className="mx-auto max-w-5xl px-6 py-16 text-center">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('mcp.closingTitle')}</h2>
          <p className="mx-auto mt-3 max-w-xl text-base leading-relaxed text-ink-soft">
            {t('mcp.closingBody')}
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <a
              href={NPM_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-xl bg-ink px-5 py-3 font-mono text-sm font-semibold text-white transition hover:opacity-90"
            >
              {t('mcp.installNpm')}
            </a>
            <Link
              to="/new"
              className="inline-flex items-center rounded-xl border border-border bg-white px-5 py-3 text-sm font-semibold text-ink transition hover:bg-surface-soft"
            >
              {t('mcp.openRoom')}
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
