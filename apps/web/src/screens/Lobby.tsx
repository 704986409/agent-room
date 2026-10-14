import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { createClient, getRoom, joinRoom, verifyHostKey, HostNameTakenError, RoomNotFoundError } from '@agent-room/upstash-client';
import type { Room } from '@agent-room/shared';
import { ROOM_POLL_MS } from '@agent-room/shared';
import { ENV } from '../env.js';
import { Avatar } from '../components/Avatar.js';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { colorForName, initialsFor } from '../lib/colors.js';
import { copyText } from '../lib/copy.js';
import { templateById, localizedRoleLabel, localizedTemplate } from '../lib/templates.js';
import { LocaleSwitcher } from '../i18n/LocaleSwitcher.js';
import { useDocumentTitle, useLocale } from '../i18n/LocaleProvider.js';

export function Lobby() {
  const { locale, t } = useLocale();
  useDocumentTitle(t('lobby.title'));
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [room, setRoom] = useState<Room | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const client = createClient(ENV.upstash);
    const stored = sessionStorage.getItem(`room:${code}:self`);
    const self = stored ? JSON.parse(stored) as { name: string; role: string } : null;

    let cancelled = false;

    async function ensureJoined() {
      try {
        if (self && !cancelled) {
          // Pre-flight: if we're claiming the host's display name, prove
          // we own the host key. Without this, anyone with the code could
          // pretend to be the host.
          const room = await getRoom(client, code);
          if (self.name === room.createdBy) {
            // Read from localStorage (room-scoped, survives tab close) with
            // a sessionStorage fallback for hosts who created the room before
            // we moved the key — keeps their existing tab working.
            const hostKey = localStorage.getItem(`room:${code}:hostKey`)
              ?? sessionStorage.getItem(`room:${code}:hostKey`)
              ?? undefined;
            await verifyHostKey(client, code, hostKey);
          }
          // priorIdentity tells joinRoom this is the same logical session
          // updating its own row, so a refresh doesn't get auto-suffixed.
          await joinRoom(client, code, {
            name: self.name,
            role: self.role,
            color: colorForName(self.name),
            initials: initialsFor(self.name),
            client: 'web',
            joinedAt: Date.now(),
            lastSeenAt: Date.now(),
          }, {
            priorIdentity: { name: self.name, client: 'web' },
          });
        }
        await refresh();
      } catch (e) {
        if (cancelled) return;
        if (e instanceof HostNameTakenError) {
          // Wipe the bogus self entry and bounce to the Join page so they
          // can pick a different name.
          sessionStorage.removeItem(`room:${code}:self`);
          setErr(`host-name-reserved:${self?.name ?? '?'}`);
          setTimeout(() => navigate(`/j/${code}`, { replace: true }), 1500);
          return;
        }
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

  const joinUrl = `${window.location.origin}/j/${code}`;
  const inviteText = t('room.inviteText', { topic: room.topic, code, url: joinUrl });
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

      <div className="bg-surface-softer border border-dashed border-border rounded-lg p-3 text-[10px] text-ink-soft leading-relaxed mb-4 relative whitespace-pre-line">
        <button onClick={() => copyText(inviteText, t('lobby.inviteCopied'))}
          className="absolute top-2 right-2 bg-surface border border-border px-2 py-0.5 rounded text-[9px] font-semibold text-ink-muted">{t('lobby.copyInvite')}</button>
        {inviteText}
      </div>

      <button onClick={() => copyText(joinUrl, t('lobby.linkCopied'))}
        className="w-full mb-4 bg-accent-tint text-accent border border-accent/20 py-2 rounded-lg text-xs font-semibold">
        {t('lobby.copyInviteLink')}
      </button>

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
