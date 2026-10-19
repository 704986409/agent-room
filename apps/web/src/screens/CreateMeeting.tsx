import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ROLE_PRESETS } from '@agent-room/shared';
import { roomApi, RoomWriteError } from '../lib/roomWrites.js';
import { ROOM_TEMPLATES, localizedRoleLabel, localizedTemplate, templateById } from '../lib/templates.js';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { LocaleSwitcher } from '../i18n/LocaleSwitcher.js';
import { useDocumentTitle, useLocale } from '../i18n/LocaleProvider.js';

const TEMPLATE_KEY = 'room:pending-template:';

export function CreateMeeting() {
  const { locale, t } = useLocale();
  useDocumentTitle(t('create.title'));
  // A4: optional `?topic=...&from=<code>` query params let the report
  // page deep-link a reader straight into a new-room flow with the topic
  // pre-seeded. `from` is preserved purely for downstream attribution /
  // debugging — no UI behavior reads it today, but it lives in the URL
  // so the upcoming room ever needs to know "which shared report
  // converted you", we don't have to refactor the wire format.
  const [searchParams] = useSearchParams();
  const initialTopic = searchParams.get('topic') ?? '';
  const [templateId, setTemplateId] = useState<string>('blank');
  const [topic, setTopic] = useState(initialTopic);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const rawTemplate = templateById(templateId);
  const template = rawTemplate ? localizedTemplate(rawTemplate, locale) : undefined;

  function pickTemplate(id: string) {
    setTemplateId(id);
    const picked = templateById(id);
    // Only autofill the topic if the user hasn't typed something yet — picking
    // a different template after typing shouldn't clobber their work.
    if (picked && !topic.trim()) setTopic(localizedTemplate(picked, locale).topicSeed);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!topic.trim() || !name.trim()) return;
    setBusy(true); setError(null);
    try {
      const created = await roomApi.createRoom({ topic: topic.trim(), displayName: name.trim(), role: role.trim() });
      const code = created.code;
      sessionStorage.setItem(`room:${code}:self`, JSON.stringify({ name: created.name, role: role.trim() }));
      localStorage.setItem(`room:${code}:hostKey`, created.hostKey);
      // Stash the chosen template so Lobby (and the room itself) can post the
      // opening message + show suggested roles. We use sessionStorage and not
      // a route param so re-opens or refreshes don't re-trigger the opener.
      if (template && template.id !== 'blank') {
        sessionStorage.setItem(`${TEMPLATE_KEY}${code}`, template.id);
      }
      navigate(`/r/${code}/lobby`);
    } catch (e: unknown) {
      if (e instanceof RoomWriteError && e.status === 401) {
        navigate('/login?next=/new');
        return;
      }
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="bg-white px-6 py-5">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <Link to="/" aria-label={t('common.agentRoomHome')} className="inline-block hover:opacity-85 transition">
            <AgentRoomLogo markClassName="h-7 w-7" wordmarkClassName="text-base" />
          </Link>
          <LocaleSwitcher />
        </div>
      </div>
      <form onSubmit={submit} className="max-w-2xl mx-auto mt-8 p-8 bg-surface border border-border rounded-xl shadow-card">
      <h1 className="text-lg font-semibold tracking-tight">{t('create.title')}</h1>
      <p className="text-xs text-ink-soft mt-1 mb-6">{t('create.instructions')}</p>

      {error && (
        <div role="alert" className="text-[11px] text-red-600 mb-3">
          <p>{t('common.somethingWentWrong')}</p>
          <details className="mt-1">
            <summary className="cursor-pointer">{t('common.errorDetails')}</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words">{error}</pre>
          </details>
        </div>
      )}

      <div className="mb-6">
        <span className="text-xs font-semibold text-ink-muted block mb-2">{t('create.template')}</span>
        <div className="grid sm:grid-cols-2 gap-2">
          {ROOM_TEMPLATES.map(raw => {
            const item = localizedTemplate(raw, locale);
            const active = item.id === templateId;
            return (
              <button
                type="button"
                key={item.id}
                onClick={() => pickTemplate(item.id)}
                className={`text-left rounded-lg border px-3 py-2.5 transition ${
                  active
                    ? 'border-accent bg-accent-tint ring-2 ring-accent/20'
                    : 'border-border bg-white hover:border-accent/40'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <span className="text-base leading-none">{item.emoji}</span>
                  <span>{item.label}</span>
                </div>
                <div className="text-[11px] text-ink-soft leading-snug mt-1">{item.description}</div>
                {item.suggestedRoleIds.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {item.suggestedRoleIds.map(rid => (
                      <span key={rid} className="text-[9px] font-semibold text-accent bg-white border border-accent-tint-border px-1.5 py-px rounded">
                        {localizedRoleLabel(rid, locale)}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <label className="block mb-4">
        <span className="text-xs font-semibold text-ink-muted block mb-1.5">{t('create.topic')}</span>
        <input value={topic} onChange={e => setTopic(e.target.value)} required
          placeholder={template?.topicSeed || t('create.topicPlaceholder')}
          className="w-full px-3 py-2 bg-surface border border-border rounded-lg outline-none text-sm focus:border-accent focus:ring-4 focus:ring-accent-tint" />
        {template && template.id !== 'blank' && (
          <span className="text-[10px] text-ink-faint mt-1 block">
            {t('create.templateTip')} <code className="bg-surface-softer px-1 rounded text-[10px]">{'{...}'}</code> {t('create.templateTipTail')}
          </span>
        )}
      </label>
      <label className="block mb-4">
        <span className="text-xs font-semibold text-ink-muted block mb-1.5">{t('common.yourName')}</span>
        <input value={name} onChange={e => setName(e.target.value)} required
          className="w-full px-3 py-2 bg-surface border border-border rounded-lg outline-none text-sm focus:border-accent focus:ring-4 focus:ring-accent-tint" />
      </label>
      <label className="block mb-6">
        <span className="text-xs font-semibold text-ink-muted block mb-1.5">{t('common.yourRole')} <span className="text-ink-faint font-medium">{t('common.optional')}</span></span>
        <select
          value={ROLE_PRESETS.some(p => p.role === role) ? role : ''}
          onChange={e => setRole(e.target.value)}
          className="w-full mb-2 px-3 py-2 bg-surface border border-border rounded-lg outline-none text-sm focus:border-accent focus:ring-4 focus:ring-accent-tint"
        >
          <option value="">{t('common.customRole')}</option>
          {ROLE_PRESETS.map(p => <option key={p.id} value={p.role}>{localizedRoleLabel(p.id, locale)}</option>)}
        </select>
        <input value={role} onChange={e => setRole(e.target.value)} placeholder={t('create.rolePlaceholder')}
          className="w-full px-3 py-2 bg-surface border border-border rounded-lg outline-none text-sm focus:border-accent focus:ring-4 focus:ring-accent-tint" />
      </label>

      <button disabled={busy} type="submit" className="w-full bg-accent text-white py-2.5 rounded-lg font-semibold text-sm disabled:opacity-50">
        {busy ? t('create.creating') : t('create.submit')}
      </button>
      </form>
    </>
  );
}
