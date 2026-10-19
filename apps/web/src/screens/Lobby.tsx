import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { createClient, getRoom, RoomNotFoundError } from '@agent-room/upstash-client';
import type { Room } from '@agent-room/shared';
import { ROOM_POLL_MS } from '@agent-room/shared';
import { ENV } from '../env.js';
import { Avatar } from '../components/Avatar.js';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { roomApi } from '../lib/roomWrites.js';
import { copyText } from '../lib/copy.js';
import { CopyInviteButton } from '../components/CopyInviteButton.js';
import { templateById, localizedRoleLabel, localizedTemplate } from '../lib/templates.js';
import { LocaleSwitcher } from '../i18n/LocaleSwitcher.js';
import { useDocumentTitle, useLocale } from '../i18n/LocaleProvider.js';

export function Lobby() {
  const { locale, t } = useLocale();
  useDocumentTitle(t('lobby.title'));
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [room, setRoom] = useState<Room | null>(() => seedRoomFromCreate(code));
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const client = createClient(ENV.upstash);
    const stored = sessionStorage.getItem(`room:${code}:self`);
    const self = stored ? JSON.parse(stored) as { name: string; role: string } : null;

    let cancelled = false;

    async function ensureJoined() {
      try {
        // Just-created rooms already contain the host; skip the redundant join.
        const justCreated = sessionStorage.getItem(`room:${code}:created`) !== null;
        if (self && !justCreated && !cancelled) {
          // Read in parallel with the join so the first paint isn't serialized.
          await Promise.all([roomApi.join({ code, role: self.role }), refresh()]);
        }
        await refresh();
        sessionStorage.removeItem(`room:${code}:created`);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof RoomNotFoundError ? 'Room not found' : String(e));
      }
    }

    async function refresh() {
      try {
        const r = await getRoom(client, code);
        if (!cancelled) setRoom(r);
      } catch (e) {
        if (!cancelled) setErr(e instanceof RoomNotFoundError ? 'Room not found' : String(e));
      }
    }

    ensureJoined();
    const t = setInterval(refresh, ROOM_POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [code]);

  const header = (
    <div className="bg-white px-6 py-5">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
        <Link to="/" aria-label={t('common.agentRoomHome')} className="inline-block hover:opacity-85 transition">
          <AgentRoomLogo markClassName="h-7 w-7" wordmarkClassName="text-base" />
        </Link>
        <LocaleSwitcher />
      </div>
    </div>
  );

  if (err) {
    const knownError = err === 'Room not found' || err.startsWith('host-name-reserved:');
    return <>{header}<div role="alert" className="mx-auto max-w-3xl p-6 sm:p-10 text-red-700">
      {knownError ? (
        err === 'Room not found' ? t('common.roomNotFound')
          : t('join.hostNameReserved', { name: err.slice('host-name-reserved:'.length) })
      ) : (
        <>
          <p>{t('common.somethingWentWrong')}</p>
          <details className="mt-1">
            <summary className="cursor-pointer">{t('common.errorDetails')}</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-ink-soft">{err}</pre>
          </details>
        </>
      )}
    </div></>;
  }
  if (!room) return <>{header}<div className="p-10 text-ink-soft">{t('common.loading')}</div></>;
  const current = room;

  async function inviteText() {
    const invite = await roomApi.createInvite({ code });
    const url = `${window.location.origin}/i/${invite.token}`;
    return t('room.inviteText', { topic: current.topic, code, url });
  }
  const rawTemplate = templateById(sessionStorage.getItem(`room:pending-template:${code}`));
  const template = rawTemplate ? localizedTemplate(rawTemplate, locale) : undefined;

  return (
    <>
      {header}
      <div className="max-w-md mx-auto mt-10 p-8 bg-surface border border-border rounded-xl shadow-card">
      <h1 className="text-lg font-semibold tracking-tight">{t('lobby.title')}</h1>
      <p className="text-xs text-ink-soft mt-1 mb-5">{t('lobby.instructions')}</p>

      <div className="bg-surface-soft border border-border rounded-xl p-5 text-center mb-4 relative">
        <div className="text-[9px] uppercase tracking-widest font-semibold text-ink-faint mb-1.5">{t('lobby.meetingCode')}</div>
        <div className="font-mono text-2xl font-bold tracking-[0.06em]">{code}</div>
        <button onClick={() => copyText(code, t('lobby.meetingCodeCopied'))} aria-label={t('accessibility.copyCode')}
          className="absolute top-2.5 right-2.5 bg-surface border border-border w-7 h-7 rounded-md text-ink-soft text-xs">⎘</button>
      </div>

      <div className="mb-4">
        <CopyInviteButton
          label={t('lobby.copyInviteLink')}
          successMsg={t('lobby.inviteCopied')}
          getText={inviteText}
          className="w-full bg-accent-tint text-accent border border-accent/20 py-2 rounded-lg text-xs font-semibold disabled:opacity-60"
        />
      </div>

      {template && template.suggestedRoleIds.length > 0 && (
        <div className="mb-6 rounded-lg border border-accent-tint-border bg-accent-tint/40 p-3">
          <div className="text-[10px] font-semibold text-accent-deep mb-2 uppercase tracking-wider flex items-center gap-1.5">
            <span>{template.emoji}</span>
            <span>{t('lobby.suggestedRoles', { template: template.label })}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {template.suggestedRoleIds.map(rid => (
              <span key={rid} className="text-[10px] font-semibold text-accent bg-white border border-accent-tint-border px-2 py-0.5 rounded">
                {localizedRoleLabel(rid, locale)}
              </span>
            ))}
          </div>
          <div className="text-[10px] text-ink-soft mt-2 leading-relaxed">
            {t('lobby.suggestedRolesHelp')}
          </div>
        </div>
      )}

      <div className="mb-6">
        <div className="flex items-center gap-1.5 mb-2">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
          <span className="text-[10px] font-semibold text-ink-muted">{t('lobby.participants', { count: room.participants.length })}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {room.participants.map(p => (
            <div key={p.name} className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-soft rounded-md text-xs">
              <Avatar initials={p.initials} color={p.color} size="md" />
              <span className="font-semibold">{p.name}</span>
              {p.role && <span className="text-[9px] text-ink-faint">· {p.role}</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={() => navigate('/')} className="flex-1 bg-surface border border-border py-2.5 rounded-lg text-sm font-semibold text-ink-muted">{t('lobby.inviteLater')}</button>
        <button onClick={() => navigate(`/r/${code}`)} className="flex-1 bg-accent text-white py-2.5 rounded-lg text-sm font-semibold">{t('lobby.enterRoom')}</button>
      </div>
      </div>
    </>
  );
}

/** Minimal Room built from the create response (stashed by CreateMeeting) so
 *  the lobby paints immediately; the first proxy read replaces it. */
function seedRoomFromCreate(code: string): Room | null {
  try {
    const raw = sessionStorage.getItem(`room:${code}:created`);
    if (!raw) return null;
    const c = JSON.parse(raw) as { topic: string; name: string; role: string; at: number };
    if (!c?.name || Date.now() - c.at > 5 * 60_000) return null;
    const initials = c.name.replace(/\s+/g, '').slice(0, 2).toUpperCase() || '?';
    return {
      code, topic: c.topic, createdAt: c.at, createdBy: c.name, status: 'active', version: 0,
      participants: [{ name: c.name, role: c.role ?? '', color: '#6366f1', initials, client: 'web', joinedAt: c.at, lastSeenAt: c.at }],
    } as unknown as Room;
  } catch {
    return null;
  }
}
