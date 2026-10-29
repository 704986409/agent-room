import { useEffect, useRef, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.js';
import {
  INVITE_ROLE_PROFILE_MAX_CHARS,
  SUGGESTED_INVITE_ROLES,
  requestAgentInvite,
  storedRoomHostKey,
} from '../lib/agentInvite.js';
import {
  hostOnThisMachine,
  listInstalledDesktopAdapters,
  type DesktopAdapterChoice,
  type DesktopHostResult,
} from '../lib/desktopHost.js';

const ADAPTER_LABELS: Record<string, string> = {
  codex: 'Codex',
  'cursor-agent': 'Cursor',
  agy: 'Gemini',
  claude: 'Claude',
};

function adapterLabel(id: string): string {
  return ADAPTER_LABELS[id] ?? id;
}

/**
 * Host-only dialog: pick a role (and optional profile), an installed CLI, and a model,
 * then create a one-time invite and start that seat on this machine.
 */
export function HostLocalDialog({ roomCode, ended, onClose, onHosted, onBusyChange }: {
  roomCode: string;
  ended: boolean;
  onClose: () => void;
  onHosted?: (seat: DesktopHostResult['seat']) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLocale();
  const tRef = useRef(t);
  tRef.current = t;
  const [role, setRole] = useState('');
  const [customRole, setCustomRole] = useState(false);
  const [roleProfile, setRoleProfile] = useState('');
  const [adapters, setAdapters] = useState<DesktopAdapterChoice[]>([]);
  const [adapterId, setAdapterId] = useState('');
  const [model, setModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void listInstalledDesktopAdapters()
      .then(rows => {
        if (cancelled) return;
        setAdapters(rows);
      })
      .catch(e => {
        if (cancelled) return;
        setAdapters([]);
        setLoadError(tRef.current('desktopHost.adaptersFailed', {
          error: e instanceof Error ? e.message : tRef.current('common.unknownError'),
        }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const selected = adapters.find(item => item.id === adapterId);
  const models = selected?.models ?? [];
  const canHost = !ended && !busy && !loading && !loadError && adapters.length > 0
    && role.trim().length > 0 && adapterId.length > 0 && model.length > 0 && models.includes(model);

  function chooseAdapter(id: string) {
    setAdapterId(id);
    const next = adapters.find(item => item.id === id);
    setModel(next?.models[0] ?? '');
  }

  async function host() {
    if (busyRef.current || !canHost) return;
    const trimmed = role.trim();
    if (!trimmed) { setError(t('inviteAgent.roleRequired')); return; }
    if (!adapterId || !model) { setError(t('desktopHost.noAdapters')); return; }
    const hostKey = storedRoomHostKey(roomCode);
    if (!hostKey) { setError(t('inviteAgent.hostKeyMissing')); return; }
    busyRef.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const invite = await requestAgentInvite(roomCode, hostKey, trimmed, roleProfile.trim() || undefined);
      const seated = await hostOnThisMachine({
        code: roomCode,
        inviteCode: invite.inviteCode,
        name: trimmed,
        adapterId,
        model,
      });
      onHosted?.(seated.seat.name ? seated.seat : { ...seated.seat, name: trimmed });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.unknownError'));
    } finally {
      busyRef.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-3" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-local-title"
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-white shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-border-faint px-4 py-3">
          <div>
            <h2 id="host-local-title" className="text-sm font-semibold text-ink">{t('desktopHost.title')}</h2>
            <p className="mt-0.5 text-[11px] text-ink-soft">{t('desktopHost.description')}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md px-2 py-1 text-lg leading-none text-ink-muted hover:bg-surface-softer disabled:opacity-50" aria-label={t('desktopHost.closeAria')}>×</button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-ink-muted">{t('inviteAgent.roleLabel')}</span>
            <select
              value={customRole ? '__custom__' : role}
              onChange={e => {
                if (e.target.value === '__custom__') {
                  setCustomRole(true);
                  if ((SUGGESTED_INVITE_ROLES as readonly string[]).includes(role)) setRole('');
                  return;
                }
                setCustomRole(false);
                setRole(e.target.value);
              }}
              className="w-full px-2.5 py-1.5 bg-surface border border-border rounded-lg outline-none text-xs focus:border-accent focus:ring-2 focus:ring-accent-tint"
            >
              <option value="">{t('inviteAgent.rolePlaceholder')}</option>
              {SUGGESTED_INVITE_ROLES.map(item => <option key={item} value={item}>{item}</option>)}
              <option value="__custom__">{t('inviteAgent.roleCustom')}</option>
            </select>
            {customRole && (
              <input
                value={role}
                maxLength={128}
                onChange={e => setRole(e.target.value)}
                placeholder={t('inviteAgent.rolePlaceholder')}
                className="mt-2 w-full px-2.5 py-1.5 bg-surface border border-border rounded-lg outline-none text-xs focus:border-accent focus:ring-2 focus:ring-accent-tint"
              />
            )}
            <span className="mt-1 block text-[10px] text-ink-faint">{t('inviteAgent.roleHelp')}</span>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-ink-muted">{t('inviteAgent.profileLabel')}</span>
            <textarea
              value={roleProfile}
              maxLength={INVITE_ROLE_PROFILE_MAX_CHARS}
              rows={5}
              onChange={e => setRoleProfile(e.target.value)}
              placeholder={t('inviteAgent.profilePlaceholder')}
              className="w-full resize-y px-2.5 py-1.5 bg-surface border border-border rounded-lg outline-none text-xs leading-relaxed focus:border-accent focus:ring-2 focus:ring-accent-tint"
            />
            <span className="mt-1 flex justify-between gap-2 text-[10px] text-ink-faint">
              <span>{t('inviteAgent.profileHelp')}</span>
              <span className="shrink-0">{t('inviteAgent.profileCount', { count: [...roleProfile].length, max: INVITE_ROLE_PROFILE_MAX_CHARS })}</span>
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-ink-muted">{t('desktopHost.cliLabel')}</span>
            <select
              value={adapterId}
              disabled={loading || adapters.length === 0}
              onChange={e => { chooseAdapter(e.target.value); }}
              className="w-full px-2.5 py-1.5 bg-surface border border-border rounded-lg outline-none text-xs focus:border-accent focus:ring-2 focus:ring-accent-tint disabled:opacity-50"
            >
              <option value="">{t('desktopHost.cliPlaceholder')}</option>
              {adapters.map(item => <option key={item.id} value={item.id}>{adapterLabel(item.id)}</option>)}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-ink-muted">{t('desktopHost.modelLabel')}</span>
            <select
              value={models.includes(model) ? model : ''}
              disabled={!selected}
              onChange={e => { setModel(e.target.value); }}
              className="w-full px-2.5 py-1.5 bg-surface border border-border rounded-lg outline-none text-xs focus:border-accent focus:ring-2 focus:ring-accent-tint disabled:opacity-50"
            >
              <option value="">{t('desktopHost.modelPlaceholder')}</option>
              {models.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>

          {loading && <p className="text-[11px] text-ink-soft">{t('desktopHost.loadingAdapters')}</p>}
          {loadError && (
            <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{loadError}</div>
          )}
          {!loading && !loadError && adapters.length === 0 && (
            <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{t('desktopHost.noAdapters')}</div>
          )}
          {error && (
            <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{error}</div>
          )}

          <button
            type="button"
            onClick={() => { void host(); }}
            disabled={!canHost}
            className="min-h-9 rounded-lg bg-emerald-700 px-4 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <span role="status" className="inline-flex items-center gap-2"><span aria-hidden="true" className="inline-block size-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />{t('desktopHost.starting')}</span> : t('desktopHost.host')}
          </button>
        </div>
      </section>
    </div>
  );
}
