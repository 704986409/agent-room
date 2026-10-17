import { useEffect, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.js';
import { copyText } from '../lib/copy.js';
import {
  SUGGESTED_INVITE_ROLES,
  buildAgentInvitePrompt,
  formatInviteCountdown,
  requestAgentInvite,
  storedRoomHostKey,
  type AgentInviteResponse,
} from '../lib/agentInvite.js';
import { AgentJoinQuickstart } from './AgentJoinQuickstart.js';

interface Props {
  roomCode: string;
  isHost: boolean;
  ended: boolean;
  /** 'header' renders the compact '+' chip; 'panel' a full-width button for the People panel. */
  variant?: 'header' | 'panel';
}

interface ActiveInvite extends AgentInviteResponse {
  /** Local-clock expiry (receipt time + server TTL) so client clock skew does not matter. */
  localExpiresAt: number;
}

/**
 * Host-only '+' : generate a one-time agent invite code bound to this room and
 * a role (the role is also the agent's personaId). The code is valid for 5
 * minutes and spent by one MCP room_join; after it expires the copy button is
 * disabled until the host regenerates.
 */
export function InviteAgentDialog({ roomCode, isHost, ended, variant = 'header' }: Props) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<ActiveInvite | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open || !invite) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, invite]);

  if (!isHost) return null;

  const joinUrl = `${window.location.origin}/j/${roomCode}`;
  const remainingMs = invite ? invite.localExpiresAt - now : 0;
  const expired = Boolean(invite) && remainingMs <= 0;
  const prompt = invite
    ? buildAgentInvitePrompt({
      joinUrl,
      inviteCode: invite.inviteCode,
      role: invite.role,
      ttlMinutes: Math.max(1, Math.round(invite.ttlSeconds / 60)),
    })
    : '';

  async function generate() {
    const trimmed = role.trim();
    if (!trimmed) { setError(t('inviteAgent.roleRequired')); return; }
    const hostKey = storedRoomHostKey(roomCode);
    if (!hostKey) { setError(t('inviteAgent.hostKeyMissing')); return; }
    setBusy(true);
    setError(null);
    try {
      const created = await requestAgentInvite(roomCode, hostKey, trimmed);
      const receivedAt = Date.now();
      setInvite({ ...created, localExpiresAt: receivedAt + created.ttlSeconds * 1000 });
      setNow(receivedAt);
    } catch (e) {
      setError(t('inviteAgent.error', { error: e instanceof Error ? e.message : t('common.unknownError') }));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setOpen(false);
    setInvite(null);
    setError(null);
  }

  const trigger = variant === 'panel'
    ? (
      <button
        type="button"
        disabled={ended}
        onClick={() => setOpen(true)}
        aria-label={t('inviteAgent.openAria')}
        className="mt-2 w-full min-h-10 sm:min-h-8 text-[13px] sm:text-xs font-semibold text-white bg-accent px-3 rounded-lg transition active:scale-[0.98] hover:opacity-90 disabled:opacity-50"
      >
        + {t('inviteAgent.button')}
      </button>
    )
    : (
      <button
        type="button"
        disabled={ended}
        onClick={() => setOpen(true)}
        aria-label={t('inviteAgent.openAria')}
        title={t('inviteAgent.openAria')}
        className="h-7 w-7 sm:h-6 sm:w-6 rounded-md bg-accent text-white text-sm font-bold leading-none hover:opacity-90 active:scale-95 transition disabled:opacity-50"
      >
        +
      </button>
    );

  return (
    <>
      {trigger}
      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-3" role="presentation">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="invite-agent-title"
            className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-white shadow-xl"
          >
            <header className="flex items-center justify-between border-b border-border-faint px-4 py-3">
              <div>
                <h2 id="invite-agent-title" className="text-sm font-semibold text-ink">{t('inviteAgent.title')}</h2>
                <p className="mt-0.5 text-[11px] text-ink-soft">{t('inviteAgent.description')}</p>
              </div>
              <button type="button" onClick={close} className="rounded-md px-2 py-1 text-lg leading-none text-ink-muted hover:bg-surface-softer" aria-label={t('inviteAgent.closeAria')}>×</button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold text-ink-muted">{t('inviteAgent.roleLabel')}</span>
                <input
                  list="invite-agent-roles"
                  value={role}
                  maxLength={128}
                  onChange={e => setRole(e.target.value)}
                  placeholder={t('inviteAgent.rolePlaceholder')}
                  className="w-full px-2.5 py-1.5 bg-surface border border-border rounded-lg outline-none text-xs focus:border-accent focus:ring-2 focus:ring-accent-tint"
                />
                <datalist id="invite-agent-roles">
                  {SUGGESTED_INVITE_ROLES.map(r => <option key={r} value={r} />)}
                </datalist>
                <span className="mt-1 block text-[10px] text-ink-faint">{t('inviteAgent.roleHelp')}</span>
              </label>

              <button
                type="button"
                onClick={() => void generate()}
                disabled={busy || ended}
                className="min-h-9 rounded-lg bg-accent px-4 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
              >
                {busy ? t('inviteAgent.generating') : invite ? t('inviteAgent.regenerate') : t('inviteAgent.generate')}
              </button>

              {error && (
                <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{error}</div>
              )}

              {invite && (
                <div className="space-y-2 rounded-lg border border-border-faint bg-surface-softer p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs text-ink">
                      {t('inviteAgent.codeLabel')}{' '}
                      <code className={`font-mono font-semibold ${expired ? 'text-ink-faint line-through' : 'text-ink'}`}>{invite.inviteCode}</code>
                      <span className="ml-2 text-ink-soft">{t('inviteAgent.roleValue', { role: invite.role })}</span>
                    </div>
                    {!expired && (
                      <span className="text-[11px] font-semibold text-accent" aria-live="polite">
                        {t('inviteAgent.expiresIn', { time: formatInviteCountdown(remainingMs) })}
                      </span>
                    )}
                  </div>
                  {expired ? (
                    <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
                      {t('inviteAgent.expired')}
                    </div>
                  ) : (
                    <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border-faint bg-white p-2 font-mono text-[10px] text-ink-muted">{prompt}</pre>
                  )}
                  <button
                    type="button"
                    disabled={expired}
                    onClick={() => void copyText(prompt, t('inviteAgent.copied'))}
                    className="min-h-9 rounded-lg border border-accent px-4 text-xs font-semibold text-accent transition hover:bg-accent-tint disabled:cursor-not-allowed disabled:border-border disabled:text-ink-faint"
                  >
                    {t('inviteAgent.copyAll')}
                  </button>
                  <p className="text-[10px] text-ink-faint">{t('inviteAgent.oneTimeNote')}</p>
                </div>
              )}

              <details className="rounded-lg border border-border-faint">
                <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-ink-muted">{t('inviteAgent.setupLabel')}</summary>
                <div className="p-2">
                  <AgentJoinQuickstart roomCode={roomCode} setupOnly />
                </div>
              </details>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
