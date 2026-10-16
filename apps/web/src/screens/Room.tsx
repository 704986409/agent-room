import { useRef, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useRoom } from '../hooks/useRoom.js';
import { useTaskBoard } from '../hooks/useTaskBoard.js';
import { Bubble } from '../components/Bubble.js';
import { TaskBoard, canRuleOn } from '../components/TaskBoard.js';
import { DeliverPlanBar } from '../components/DeliverPlanBar.js';
import { DeliverEventCard, isDeliverEvent } from '../components/DeliverEventCard.js';
import { VoiceButton } from '../components/VoiceButton.js';
import { MeetingCodePill } from '../components/MeetingCodePill.js';
import { LocaleSwitcher } from '../i18n/LocaleSwitcher.js';
import { useDocumentTitle, useLocale } from '../i18n/LocaleProvider.js';
import type { MessageKey, MessageValues } from '../i18n/messages.js';
import { Avatar } from '../components/Avatar.js';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { AgentJoinNotice } from '../components/AgentJoinNotice.js';
import { MemoryReviewPanel } from '../components/MemoryReviewPanel.js';
import { SpeakBlockedNotice } from '../components/SpeakBlockedNotice.js';
import { Composer, TEXTAREA_MAX_HEIGHT, TEXTAREA_MIN_HEIGHT } from '../components/Composer.js';
import { colorForName, initialsFor } from '../lib/colors.js';
import { participantPresenceStatus, activeDeliverPlan, extractArtifacts, webSpeakGate, type Message, type MessageAttachment, type Participant, type ReplyMode, type ReplyModeConfig, type Room, type SystemEventType } from '@agent-room/shared';
import { appendSystemMessage, directInvoke, getTurnState, hostSkipCurrent, setMuted, setReplyMode, createClient, createRoomReport, endRoom as endRoomApi, reactivateRoom as reactivateRoomApi, removeParticipant, onDeliverHostMessage, runDeliverSweep, startDeliverPlanAndWake, type TurnState } from '@agent-room/upstash-client';
import { ENV } from '../env.js';
import { copyText } from '../lib/copy.js';
import { localizedTemplate, templateById } from '../lib/templates.js';
import { deleteRoomBlobs } from '../lib/upload.js';

const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour — long enough that humans + agents discussing intermittently don't trip it
const AUTO_CLOSE_COUNTDOWN = 5;          // seconds
interface SelfIdentity { name: string; role: string }

function readStoredSelf(code: string): SelfIdentity | null {
  const stored = sessionStorage.getItem(`room:${code}:self`);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as SelfIdentity;
  } catch {
    return null;
  }
}

export function Room() {
  const { locale, t, formatDateTime } = useLocale();
  const { code = '' } = useParams();
  const navigate = useNavigate();
  // Identity is whatever Join wrote into sessionStorage. If it's missing
  // (visiting /r/CODE without going through Join — e.g. an invite link
  // someone forwarded after pruning the path), we redirect to /j/CODE
  // below. We previously "recovered" by becoming room.createdBy, which
  // silently impersonated the host for any unknown visitor.
  const [self, _setSelf] = useState<SelfIdentity | null>(() => readStoredSelf(code));
  useEffect(() => {
    if (!self) navigate(`/j/${code}`, { replace: true });
  }, [self, code, navigate]);
  const { room, messages, error, sendMessage, refreshRoom, forceRefresh } = useRoom(code, self?.name ?? '');
  useDocumentTitle(t('page.roomTitle', { topic: room?.topic ?? t('common.loading') }));
  const [text, setText] = useState('');
  const [modeBusy, setModeBusy] = useState(false);
  const [turnState, setTurnState] = useState<TurnState | null>(null);
  const [now, setNow] = useState(Date.now());
  const feedRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeAudioUrlRef = useRef<string | null>(null);

  // Auto-grow the textarea: shrink to min, then expand to scrollHeight up to max.
  // Runs after every value change (typed, pasted, Draft injected, voice transcript).
  function autoGrow(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(Math.max(el.scrollHeight, TEXTAREA_MIN_HEIGHT), TEXTAREA_MAX_HEIGHT);
    el.style.height = `${next}px`;
  }
  useEffect(() => {
    autoGrow(textareaRef.current);
  }, [text]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(interval);
  }, []);

  // --- Share ---
  const joinUrl = `${window.location.origin}/j/${code}`;

  // --- Voice playback for AI (cc) messages ---
  // Robin's product ask: "I want voice auto-play in the meeting room."
  // Every time a NEW message from a cc-client participant arrives we
  // speak it via the browser's built-in TTS (Web Speech API). Two
  // guards make this safe in real rooms (which can have 50+ historical
  // messages):
  //   1. We baseline the highest message id we saw on first render
  //      and ONLY speak ids strictly greater than that — so refreshing
  //      a room with backlog doesn't replay every old AI line.
  //   2. We dedupe via spokenIdsRef so re-renders or strict-mode
  //      double-mounts can't double-fire.
  // A fallback timer clears the speaking-id state in case onend never
  // fires (some browsers swallow it on tab background).
  const [speakingMessageId, setSpeakingMessageId] = useState<number | null>(null);
  const spokenIdsRef = useRef<Set<number>>(new Set());
  const baselineMaxIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    if (messages.length === 0) return;
    if (baselineMaxIdRef.current === null) {
      // First batch: don't replay history. Mark everything we already
      // see as "seen" so only future arrivals trigger autoplay.
      const maxId = messages.reduce((max, m) => (m.id > max ? m.id : max), 0);
      baselineMaxIdRef.current = maxId;
      for (const m of messages) spokenIdsRef.current.add(m.id);
      return;
    }
    const ownName = self?.name;
    // Find the latest cc message we haven't spoken yet, and that
    // arrived after our baseline. Speak only ONE per effect tick to
    // avoid a backlog burst when the tab returns from background.
    const latestUnspoken = [...messages].reverse().find(m =>
      m.type === 'msg' &&
      m.client === 'cc' &&
      m.text.trim().length > 0 &&
      m.id > (baselineMaxIdRef.current ?? 0) &&
      !spokenIdsRef.current.has(m.id) &&
      m.name !== ownName,
    );
    if (!latestUnspoken) return;
    const messageToSpeak = latestUnspoken;
    spokenIdsRef.current.add(messageToSpeak.id);
    setSpeakingMessageId(messageToSpeak.id);

    const fallback = window.setTimeout(
      () => setSpeakingMessageId(curr => (curr === messageToSpeak.id ? null : curr)),
      Math.max(8000, messageToSpeak.text.length * 90),
    );

    let cancelled = false;

    function clearSpeaking() {
      window.clearTimeout(fallback);
      setSpeakingMessageId(curr => (curr === messageToSpeak.id ? null : curr));
    }

    async function playElevenLabsOrFallback() {
      try {
        const resp = await fetch('/api/elevenlabs-tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: messageToSpeak.text }),
        });
        const contentType = resp.headers.get('content-type') ?? '';
        if (!resp.ok || !contentType.includes('audio/')) throw new Error('ElevenLabs unavailable');
        const blob = await resp.blob();
        if (cancelled) return;
        if (activeAudioRef.current) {
          activeAudioRef.current.pause();
          activeAudioRef.current = null;
        }
        if (activeAudioUrlRef.current) {
          URL.revokeObjectURL(activeAudioUrlRef.current);
          activeAudioUrlRef.current = null;
        }
        const url = URL.createObjectURL(blob);
        activeAudioUrlRef.current = url;
        const audio = new Audio(url);
        activeAudioRef.current = audio;
        audio.onended = clearSpeaking;
        audio.onerror = clearSpeaking;
        await audio.play();
        return;
      } catch {
        // Local vite dev does not serve Vercel functions, or the key may
        // be missing. Fall back to browser TTS so the UX still works.
      }

      if (cancelled || !('speechSynthesis' in window)) {
        clearSpeaking();
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(messageToSpeak.text);
      utterance.rate = 0.95;
      utterance.pitch = 1;
      utterance.onend = clearSpeaking;
      utterance.onerror = clearSpeaking;
      window.setTimeout(() => {
        if (!cancelled) window.speechSynthesis.speak(utterance);
      }, 120);
    }

    void playElevenLabsOrFallback();

    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
      // Don't kill the audio mid-effect-cleanup — React 18 strict-mode
      // would silence every line. Browser handles overlap when the next
      // effect fires its own cancel().
    };
  }, [messages, self?.name]);

  // First-gesture unlock: most browsers refuse speak() until the user
  // has clicked something on the page. We poke speechSynthesis with a
  // silent utterance on the first pointerdown / keydown so subsequent
  // auto-plays land without a per-message manual click.
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    let unlocked = false;
    const unlock = () => {
      if (unlocked) return;
      unlocked = true;
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        window.speechSynthesis.speak(u);
      } catch { /* ignore */ }
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
  }, []);

  // --- End meeting ---
  const [ended, setEnded] = useState(false);
  const [showIdlePrompt, setShowIdlePrompt] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_CLOSE_COUNTDOWN);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMsgTimeRef = useRef(Date.now());

  // Sync ended state from room — both directions, so a server-side reactivation
  // (or another client reactivating) flips us back to active too.
  useEffect(() => {
    if (room?.status === 'ended') setEnded(true);
    else if (room?.status === 'active') setEnded(false);
  }, [room?.status]);

  useEffect(() => {
    if (!room || (room.replyMode ?? 'open') === 'open') {
      setTurnState(null);
      return;
    }
    let cancelled = false;
    async function pullTurnState() {
      try {
        const client = createClient(ENV.upstash);
        const next = await getTurnState(client, code);
        if (!cancelled) setTurnState(next);
      } catch {
        if (!cancelled) setTurnState(null);
      }
    }
    void pullTurnState();
    const id = window.setInterval(() => void pullTurnState(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [code, room?.replyMode, messages.length, room?.version]);

  // Template opener: if CreateMeeting stashed a template id for this room and
  // the host is opening an empty room, post the template's opening message
  // once and clear the marker. Guarded by `messages.length === 0` so a host
  // re-entering an active room doesn't re-post the opener.
  const openerSentRef = useRef(false);
  useEffect(() => {
    if (!room || !self || ended || openerSentRef.current) return;
    if (room.createdBy !== self.name) return;
    if (messages.length !== 0) return;
    const key = `room:pending-template:${code}`;
    const tplId = sessionStorage.getItem(key);
    const rawTpl = templateById(tplId);
    const tpl = rawTpl ? localizedTemplate(rawTpl, locale) : undefined;
    if (!tpl || !tpl.openingMessage) return;
    openerSentRef.current = true;
    sessionStorage.removeItem(key);
    const msg: Message = {
      id: Date.now(),
      type: 'msg',
      name: self.name,
      role: self.role || 'host',
      initials: initialsFor(self.name),
      color: colorForName(self.name),
      client: 'web',
      text: tpl.openingMessage,
      time: Date.now(),
    };
    sendMessage(msg).catch(() => {
      // If sending fails, give the user another shot on next mount by
      // clearing our local guard. The sessionStorage key is already gone,
      // so they'd need to re-create the room — acceptable miss for v1.
      openerSentRef.current = false;
    });
  }, [room, self, ended, messages.length, code, sendMessage, locale]);

  // Detect being kicked: once we've seen ourselves in the participants list
  // (so we know the room poll is working), if we then disappear from it we
  // were removed. Redirect to /j/CODE so the user can rejoin if they want,
  // and show a toast to make it not feel like a network glitch.
  const sawSelfRef = useRef(false);
  useEffect(() => {
    if (!room || !self || ended) return;
    const presentNow = room.participants.some(p => p.name === self.name && p.client === 'web');
    if (presentNow) {
      sawSelfRef.current = true;
      return;
    }
    if (sawSelfRef.current) {
      // We were here, now we're not — host kicked us.
      sessionStorage.removeItem(`room:${code}:self`);
      (async () => {
        const { showToast } = await import('../components/Toast.js');
        showToast(t('room.removedByHost'), 'info');
      })();
      navigate(`/j/${code}`, { replace: true });
    }
  }, [room, self, ended, code, navigate, t]);

  // Track last message time for idle detection
  useEffect(() => {
    if (messages.length > 0) {
      lastMsgTimeRef.current = Date.now();
      // Reset idle prompt if new message arrives
      if (showIdlePrompt) {
        setShowIdlePrompt(false);
        setCountdown(AUTO_CLOSE_COUNTDOWN);
        if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
      }
    }
  }, [messages.length]);

  // Idle timer: show prompt after 5 min of no messages
  useEffect(() => {
    if (ended) return;

    function resetIdle() {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        setShowIdlePrompt(true);
      }, IDLE_TIMEOUT_MS);
    }

    resetIdle();
    // Reset on new messages
    const interval = setInterval(() => {
      if (Date.now() - lastMsgTimeRef.current < IDLE_TIMEOUT_MS) return;
      if (!showIdlePrompt) setShowIdlePrompt(true);
    }, 10_000);

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      clearInterval(interval);
    };
  }, [ended, messages.length]);

  // Auto-close countdown
  useEffect(() => {
    if (!showIdlePrompt || ended) return;

    setCountdown(AUTO_CLOSE_COUNTDOWN);
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          handleEndMeeting();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    };
  }, [showIdlePrompt, ended]);

  const dismissIdlePrompt = useCallback(() => {
    setShowIdlePrompt(false);
    setCountdown(AUTO_CLOSE_COUNTDOWN);
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    lastMsgTimeRef.current = Date.now(); // reset idle clock
  }, []);

  // Host-only. Toggle mute on a participant. Muted participants stay in
  // the room (presence + read access intact) but room_send is rejected
  // server-side until they're unmuted.
  async function handleToggleMute(p: { name: string; client: 'web' | 'cc'; canSpeak?: boolean }) {
    if (!room || !self || room.createdBy !== self.name) return;
    const wantMuted = p.canSpeak !== false; // currently can speak → going to mute
    try {
      const client = createClient(ENV.upstash);
      await setMuted(client, code, self.name, p.name, p.client, wantMuted);
      await refreshRoom();
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(t('room.muteFailed', { error: e instanceof Error ? e.message : t('common.unknownError') }), 'error');
    }
  }

  // Host-only. Removes (name, client) from the room. The kicked client will
  // notice it's gone on its next room poll / room_listen and can be told to
  // leave by their UI. Reconnection is not blocked — they'd need to be re-joined.
  async function handleKick(p: { name: string; client: 'web' | 'cc' }) {
    if (!room || !self || room.createdBy !== self.name) return;
    if (p.name === self.name && p.client === 'web') return; // host can't kick themselves
    const clientLabel = t(p.client === 'web' ? 'room.browser' : 'room.cli');
    if (!confirm(t('room.removeParticipantConfirm', { name: p.name, client: clientLabel }))) return;
    try {
      const client = createClient(ENV.upstash);
      await removeParticipant(client, code, self.name, p.name, p.client);
      await refreshRoom();
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(t('room.kickFailed', { error: e instanceof Error ? e.message : t('common.unknownError') }), 'error');
    }
  }

  async function handleEndMeeting() {
    try {
      const client = createClient(ENV.upstash);
      await endRoomApi(client, code);
      setEnded(true);
      setShowIdlePrompt(false);
      if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
      // Per Robin: attachments shouldn't outlive the meeting. Fire-and-
      // forget so a Blob hiccup doesn't keep the user staring at a spinner.
      // Best-effort only — TTL expiry is handled by a cron sweep later.
      void deleteRoomBlobs(code);
    } catch {
      // ignore — room may already be ended
      setEnded(true);
    }
  }

  const [mobilePanel, setMobilePanel] = useState<'chat' | 'tasks' | 'people'>('chat');
  const [reportBusy, setReportBusy] = useState(false);
  const artifacts = extractArtifacts(messages);
  // Board lives here, not inside TaskBoard, so the tab strip can badge how
  // many deliveries are waiting on a ruling while the user is on Chat.
  const taskBoard = useTaskBoard(code);
  const openTaskCount = taskBoard.board?.tasks.filter(
    t => t.state !== 'done' && t.state !== 'rejected' && t.state !== 'cancelled',
  ).length ?? 0;
  const reviewTaskCount = taskBoard.board?.tasks.filter(
    t => canRuleOn(t, { name: self?.name ?? '', client: 'web' }, ended),
  ).length ?? 0;

  async function handleExportReport() {
    if (!room) return;
    setReportBusy(true);
    try {
      const client = createClient(ENV.upstash);
      await createRoomReport(client, room, messages);
      // A1: copy the share link to clipboard alongside navigating.
      // The report key has a seven-day TTL measured from export (see
      // packages/upstash-client/src/reports.ts), so it can outlive the room's
      // seven-day creation deadline — that's exactly the "Save"
      // half of "Save & Share". Copy first so the toast lives across the
      // route change (ToastHost is mounted at router level).
      const reportUrl = `${window.location.origin}/r/${code}/report`;
      await copyText(reportUrl, t('room.linkSaved'));
      navigate(`/r/${code}/report`);
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(t('room.exportFailed', { error: e instanceof Error ? e.message : t('common.unknownError') }), 'error');
    } finally {
      setReportBusy(false);
    }
  }

  useEffect(() => {
    feedRef.current?.scrollTo(0, feedRef.current.scrollHeight);
  }, [messages.length]);

  // Deliver mode has no server cron here. While the host's room is open, this
  // tab runs the board sweep: reassign overdue reviews, wake the lead about an
  // absent owner, escalate what the room cannot resolve, and post the delivery
  // report once the plan settles. Agents run the same sweep inside
  // room_listen; escalations are rate-limited, so both running is harmless.
  const deliverSweepRoom = room && room.replyMode === 'deliver' && self?.name === room.createdBy && room.status !== 'ended'
    ? room
    : null;
  useEffect(() => {
    if (!deliverSweepRoom) return;
    const client = createClient(ENV.upstash);
    const tick = () => { void runDeliverSweep(client, code, deliverSweepRoom).catch(() => { /* best-effort */ }); };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [code, deliverSweepRoom?.version, deliverSweepRoom?.replyMode, !!deliverSweepRoom]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startDeliverPlan() {
    if (!room) return;
    try {
      await startDeliverPlanAndWake(createClient(ENV.upstash), code, room.createdBy);
      await taskBoard.reload();
      await forceRefresh();
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(e instanceof Error ? `Start failed: ${e.message}` : 'Start failed', 'error');
    }
  }

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const resetOnDesktop = () => {
      if (mq.matches) setMobilePanel('chat');
    };
    resetOnDesktop();
    mq.addEventListener('change', resetOnDesktop);
    return () => mq.removeEventListener('change', resetOnDesktop);
  }, []);

  if (error && !room) return <RoomRecoverySurface room={room} error={error} />;
  // An agent handed /r/CODE lands here, not on Join: there is no stored
  // identity, so the effect above bounces it to /j/CODE. That bounce is a
  // client-side navigation, and an agent that snapshots the page before it
  // settles would otherwise read a bare "Redirecting to join…" and learn
  // nothing. Carry the same notice through the interstitial.
  if (!self) {
    return (
      <div className="mx-auto max-w-md p-10">
        <div className="mb-4 flex justify-end"><LocaleSwitcher compact /></div>
        <AgentJoinNotice code={code} />
        <div className="text-ink-soft">{t('room.redirectingToJoin')}</div>
      </div>
    );
  }
  if (!room) return <div className="p-10 text-ink-soft"><div className="mb-4 flex justify-end"><LocaleSwitcher compact /></div>{t('common.loading')}</div>;

  // From here down `self` is non-null (early-returned above). Capture it in a
  // narrowed const so closures inside JSX don't have to re-check.
  const me = self;
  const activeRoom = room;

  // Speaking gate: everyone joins able to speak. The host can mute via
  // setMuted() to suspend a specific participant. canSpeak === undefined
  // (legacy rooms before this field existed) is treated as approved so
  // already-running meetings don't break. The rule itself is in
  // @agent-room/shared/speakPermission, next to the server's own gate.
  const { isHost, myCanSpeak } = webSpeakGate(room, me.name);
  const mutedCount = room.participants.filter(p => p.canSpeak === false).length;
  const replyMode = activeRoom.replyMode ?? 'open';
  const replyModeConfig = activeRoom.modeConfig;
  const canConfigureReplyMode = isHost && !ended;
  const roomAgents = activeRoom.participants.filter(p => p.client === 'cc');
  const activeRoomAgents = roomAgents.filter(p => p.canSpeak !== false);
  const fallbackAgent = activeRoomAgents[0] ?? roomAgents[0];
  const selectedLeadAgentName = replyModeConfig?.leadAgentName ?? fallbackAgent?.name ?? '';
  const selectedModeratorAgentName = replyModeConfig?.moderatorAgentName ?? fallbackAgent?.name ?? '';
  const currentSpeaker = turnState?.currentName && turnState.currentClient
    ? activeRoom.participants.find(p => p.name === turnState.currentName && p.client === turnState.currentClient)
    : undefined;
  const currentDeadlineMs = turnState?.deadline ? Math.max(0, turnState.deadline - now) : null;

  function modeLabel(mode: ReplyMode): string {
    if (mode === 'sequential') return t('room.modeSequential');
    if (mode === 'moderator') return t('room.modeModerator');
    if (mode === 'deliver') return t('room.modeDeliver');
    return t('room.modeOpen');
  }

  function buildModeConfig(mode: ReplyMode, overrides: Partial<ReplyModeConfig> = {}): ReplyModeConfig | undefined {
    const timeoutMs = replyModeConfig?.timeoutMs;
    if (mode === 'open') return timeoutMs ? { timeoutMs } : undefined;

    const base: ReplyModeConfig = { ...(replyModeConfig ?? {}), ...overrides };
    // Deliver's lead is configured exactly like sequential's.
    if (mode === 'sequential' || mode === 'deliver') {
      const leadName = overrides.leadAgentName ?? base.leadAgentName ?? fallbackAgent?.name;
      return {
        ...base,
        ...(timeoutMs ? { timeoutMs } : {}),
        leadAgentName: leadName,
        leadAgentClient: leadName ? 'cc' : undefined,
      };
    }

    const moderatorName = overrides.moderatorAgentName ?? base.moderatorAgentName ?? fallbackAgent?.name;
    return {
      ...base,
      ...(timeoutMs ? { timeoutMs } : {}),
      moderatorAgentName: moderatorName,
      moderatorAgentClient: moderatorName ? 'cc' : undefined,
    };
  }

  async function updateReplyMode(mode: ReplyMode, overrides: Partial<ReplyModeConfig> = {}) {
    if (!canConfigureReplyMode) return;
    const nextConfig = buildModeConfig(mode, overrides);
    if (mode !== 'open' && !fallbackAgent) {
      const { showToast } = await import('../components/Toast.js');
      showToast(t('room.sequentialNeedsAgent'), 'info');
      return;
    }
    setModeBusy(true);
    try {
      const client = createClient(ENV.upstash);
      await setReplyMode(client, code, me.name, mode, nextConfig);
      await refreshRoom();
      const { showToast } = await import('../components/Toast.js');
      showToast(t('room.replyModeSet', { mode: modeLabel(mode) }));
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(t('room.modeChangeFailed', { error: e instanceof Error ? e.message : t('common.unknownError') }), 'error');
    } finally {
      setModeBusy(false);
    }
  }

  async function refreshTurnAndMessages() {
    try {
      const client = createClient(ENV.upstash);
      setTurnState(await getTurnState(client, code));
    } catch {
      setTurnState(null);
    }
    await forceRefresh();
  }

  async function emitTurnSystemMessage(
    textValue: string,
    eventType: SystemEventType,
    target: { name: string; client: 'web' | 'cc' },
    extra: Partial<NonNullable<Message['metadata']>> = {},
  ) {
    const client = createClient(ENV.upstash);
    const nowMs = Date.now();
    const msg: Message = {
      id: nowMs,
      type: 'sys',
      name: 'system',
      role: '',
      initials: 'AR',
      color: '#5B6AFF',
      client: 'cc',
      text: textValue,
      time: nowMs,
      metadata: {
        eventType,
        modeAtSend: replyMode,
        targetAgentName: target.name,
        targetAgentClient: target.client,
        ...extra,
      },
    };
    await appendSystemMessage(client, code, msg);
  }

  async function handleAskAgent(p: Participant) {
    if (!canConfigureReplyMode || p.client !== 'cc') return;
    if (replyMode === 'open') {
      appendText(`@${p.name} `);
      return;
    }
    if (!turnState) {
      const { showToast } = await import('../components/Toast.js');
      showToast(t('room.sendFirst'), 'info');
      return;
    }
    setModeBusy(true);
    try {
      const client = createClient(ENV.upstash);
      const added = await directInvoke(client, code, { name: p.name, client: p.client }, 'host');
      if (!added) {
        const { showToast } = await import('../components/Toast.js');
        showToast(t('room.agentQueued', { name: p.name }), 'info');
        return;
      }
      await emitTurnSystemMessage(
        `Host directly invoked @${p.name}.`,
        'host_invoked',
        { name: p.name, client: p.client },
        { invocationType: 'host_directed' },
      );
      await refreshTurnAndMessages();
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(t('room.askFailed', { error: e instanceof Error ? e.message : t('common.unknownError') }), 'error');
    } finally {
      setModeBusy(false);
    }
  }

  async function handleSkipCurrent() {
    if (!canConfigureReplyMode || !currentSpeaker) return;
    setModeBusy(true);
    try {
      const client = createClient(ENV.upstash);
      const skipped = await hostSkipCurrent(client, code, activeRoom);
      if (!skipped) {
        const { showToast } = await import('../components/Toast.js');
        showToast(t('room.noActiveAgent'), 'info');
        return;
      }
      await emitTurnSystemMessage(
        `Host skipped @${skipped.name}'s ${skipped.role} slot.`,
        'skipped_by_host',
        { name: skipped.name, client: skipped.client },
        { roleAtSend: skipped.role, skippedBy: 'host' },
      );
      await refreshTurnAndMessages();
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(t('room.skipFailed', { error: e instanceof Error ? e.message : t('common.unknownError') }), 'error');
    } finally {
      setModeBusy(false);
    }
  }

  function fillPrompt(kind: 'minutes' | 'reply') {
    const agent = activeRoom.participants.find(p => p.client !== 'web' && p.canSpeak !== false)?.name ?? 'Claude';
    const target = `@${agent}`;
    const prompt = kind === 'minutes'
      ? `${target} Please generate concise meeting minutes for this room. Include topic, participants, key decisions, open questions, and action items. Use markdown.`
      : `${target} Please draft a concise reply to the latest message in this room. Keep it practical and mention any assumptions.`;
    setText(prompt);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      autoGrow(textareaRef.current);
    });
  }

  // Hands one message to the room. Rejects on failure so the Composer can put
  // the draft (text + attachments) back where the user left it.
  async function submitMessage(body: string, attachments: MessageAttachment[]) {
    const msg: Message = {
      id: Date.now(),
      type: 'msg',
      name: me.name,
      role: me.role,
      initials: initialsFor(me.name),
      color: colorForName(me.name),
      client: 'web',
      text: body,
      time: Date.now(),
      attachments: attachments.length ? attachments : undefined,
    };
    await sendMessage(msg);
    // Deliver: the host's message is either the go for a waiting plan
    // ("Start" / 开工) or a goal the lead should plan for.
    if (isHost && replyMode === 'deliver') {
      void onDeliverHostMessage(createClient(ENV.upstash), code, activeRoom, body)
        .then(() => taskBoard.reload())
        .catch(() => { /* best-effort */ });
    }
  }

  function appendText(value: string) {
    setText(prev => {
      if (!prev.trim()) return value;
      return `${prev}\n${value}`;
    });
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      autoGrow(textareaRef.current);
    });
  }

  return (
    <RoomRecoverySurface room={room} error={error}>
    <div className="h-full flex items-center justify-center p-0 sm:px-3 sm:py-4">
      <div className="w-full max-w-7xl h-full sm:h-[88vh] grid grid-rows-[auto_auto_1fr] bg-surface border-0 sm:border border-border rounded-none sm:rounded-xl shadow-none sm:shadow-card overflow-hidden">
        <header className="px-3.5 py-2.5 sm:px-4 sm:py-3 border-b border-border-faint flex justify-between items-center bg-surface shrink-0">
          <div className="min-w-0 flex items-center gap-2.5 sm:gap-3">
            <AgentRoomLogo showWordmark={false} markClassName="h-7 w-7 sm:h-8 sm:w-8" />
            <div className="min-w-0">
              <div className="text-xs sm:text-sm font-semibold truncate text-ink">{room.topic}</div>
              <div className="text-[10px] text-ink-soft flex items-center gap-1.5">
                {ended ? (
                  <span className="text-red-500 font-semibold">{t('room.meetingEnded')}</span>
                ) : (
                  <>
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span>{t('room.participantsCount', { count: room.participants.length })}</span>
                    <span className="hidden lg:inline">· {t('room.messagesCount', { count: messages.length })}</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <div className="hidden sm:flex">
              {room.participants.slice(0, 5).map((p, i) => (
                <div key={p.name} style={{ marginLeft: i === 0 ? 0 : -6 }} className="ring-2 ring-white rounded-full">
                  <Avatar initials={p.initials} color={p.color} size="sm" />
                </div>
              ))}
            </div>
            <LocaleSwitcher compact className="border-0 bg-transparent p-0" />
            <MemoryReviewPanel roomCode={code} isHost={room.createdBy === self?.name} ended={ended} />
            <button
              onClick={() => copyText(joinUrl, t('room.inviteLinkCopied'))}
              className="text-[11px] sm:text-[10px] font-semibold text-accent bg-accent-tint px-2.5 py-1.5 sm:px-2 sm:py-1 rounded-md hover:bg-accent/20 active:scale-95 transition"
            >
              {t('room.share')}
            </button>
            <MeetingCodePill code={code} />
          </div>
        </header>

        {/*
          Mobile tab strip. Tasks sits second because handing work to an agent
          and ruling on what came back is the reason a host opens this on a
          phone; People is the occasional admin trip. 44px targets (the old
          38px row was hard to hit one-handed), and the Tasks tab carries an
          amber count when deliveries are waiting on a ruling so the signal
          reaches the user while they are still reading Chat.
        */}
        <div className="lg:hidden grid grid-cols-3 gap-1.5 border-b border-border-faint bg-surface-softer p-1.5 shrink-0" role="tablist">
          {([
            ['chat', t('room.chat'), messages.length, false],
            ['tasks', t('room.tasks'), openTaskCount, reviewTaskCount > 0],
            ['people', t('room.people'), room.participants.length, false],
          ] as const).map(([key, label, count, alert]) => {
            const active = mobilePanel === key;
            return (
              <button
                key={key}
                role="tab"
                aria-selected={active}
                onClick={() => setMobilePanel(key)}
                className={`min-h-11 rounded-lg px-2 text-[13px] font-semibold flex items-center justify-center gap-1.5 transition active:scale-[0.98] ${
                  active
                    ? 'bg-accent text-white shadow-sm'
                    : 'text-ink-muted hover:text-ink bg-surface border border-border-faint'
                }`}
              >
                <span>{label}</span>
                <span
                  className={`text-[11px] px-1.5 py-0.5 rounded-full font-bold ${
                    active
                      ? 'bg-white/25 text-white'
                      : alert
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-surface-sunken text-ink-faint'
                  }`}
                >
                  {alert ? t('task.toReviewCount', { count: reviewTaskCount }) : count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="min-h-0 min-w-0 overflow-x-hidden grid lg:grid-cols-[260px_minmax(0,1fr)_340px] bg-surface-soft">
          <aside className={`${mobilePanel === 'people' ? 'flex' : 'hidden'} lg:flex min-h-0 min-w-0 flex-col border-r border-border-faint bg-surface`}>
            <div className="p-4 border-b border-border-faint">
              <h2 className="hidden lg:block text-sm font-semibold leading-snug">{room.topic}</h2>
              <div className="hidden lg:block mt-3">
                <MeetingCodePill code={code} />
              </div>
              <button
                onClick={() => copyText(joinUrl, t('room.inviteLinkCopied'))}
                className="mt-3 w-full min-h-10 sm:min-h-8 text-[13px] sm:text-xs font-semibold text-accent bg-accent-tint px-3 rounded-lg transition active:scale-[0.98] hover:bg-accent/20"
              >
                {t('room.copyInviteLink')}
              </button>
              <div className="mt-3 lg:mt-3 rounded-lg border border-border-faint bg-surface-softer p-2.5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[12px] font-semibold text-ink-muted">{t('room.whoReplies')}</span>
                </div>
                {canConfigureReplyMode ? (
                  <div className="space-y-2">
                    <select
                      value={replyMode}
                      onChange={e => { void updateReplyMode(e.target.value as ReplyMode); }}
                      disabled={modeBusy}
                      className="h-11 sm:h-9 w-full rounded-lg border border-border bg-white px-2.5 text-[15px] sm:text-xs font-semibold text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-tint disabled:opacity-60"
                    >
                      <option value="open">{t('room.modeOpen')}</option>
                      <option value="sequential">{t('room.modeSequential')}</option>
                      <option value="moderator">{t('room.modeModerator')}</option>
                      <option value="deliver">{t('room.modeDeliver')}</option>
                    </select>
                    {(replyMode === 'sequential' || replyMode === 'deliver') && (
                      <select
                        value={selectedLeadAgentName}
                        onChange={e => { void updateReplyMode(replyMode, { leadAgentName: e.target.value, leadAgentClient: 'cc' }); }}
                        disabled={modeBusy || activeRoomAgents.length === 0}
                        className="h-11 sm:h-9 w-full rounded-lg border border-border bg-white px-2.5 text-[15px] sm:text-xs font-semibold text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-tint disabled:opacity-60"
                        aria-label={t('room.leadAgentLabel')}
                      >
                        {activeRoomAgents.length === 0 ? (
                          <option value="">{t('room.noAgents')}</option>
                        ) : activeRoomAgents.map(agent => (
                          <option key={`${agent.name}-${agent.client}`} value={agent.name}>{t('room.leadAgent', { name: agent.name })}</option>
                        ))}
                      </select>
                    )}
                    {replyMode === 'moderator' && (
                      <select
                        value={selectedModeratorAgentName}
                        onChange={e => { void updateReplyMode('moderator', { moderatorAgentName: e.target.value, moderatorAgentClient: 'cc' }); }}
                        disabled={modeBusy || activeRoomAgents.length === 0}
                        className="h-11 sm:h-9 w-full rounded-lg border border-border bg-white px-2.5 text-[15px] sm:text-xs font-semibold text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-tint disabled:opacity-60"
                        aria-label={t('room.moderatorAgentLabel')}
                      >
                        {activeRoomAgents.length === 0 ? (
                          <option value="">{t('room.noAgents')}</option>
                        ) : activeRoomAgents.map(agent => (
                          <option key={`${agent.name}-${agent.client}`} value={agent.name}>{t('room.moderatorAgent', { name: agent.name })}</option>
                        ))}
                      </select>
                    )}
                    {replyMode !== 'open' && replyMode !== 'deliver' && (
                      <div className="rounded-md border border-border-faint bg-white px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-[12px] font-semibold text-ink">
                              {currentSpeaker ? t('room.nowSpeaker', { name: currentSpeaker.name }) : t('room.noActiveTurn')}
                            </div>
                            <div className="text-[11px] text-ink-soft">
                              {currentSpeaker && currentDeadlineMs !== null
                                ? t('room.secondsLeft', { count: Math.ceil(currentDeadlineMs / 1000) })
                                : t('room.waiting')}
                            </div>
                          </div>
                          {currentSpeaker && (
                            <button
                              type="button"
                              onClick={() => { void handleSkipCurrent(); }}
                              disabled={modeBusy}
                              className="h-10 sm:h-8 rounded-lg border border-amber-200 bg-amber-50 px-3 text-[12px] sm:text-[11px] font-semibold text-amber-700 transition active:scale-[0.98] hover:bg-amber-100 disabled:opacity-60"
                            >
                              {t('room.skip')}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs font-semibold text-ink-muted">{modeLabel(replyMode)}</div>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <div className="mb-2.5 text-[13px] font-semibold text-ink">{t('room.inRoom')}</div>
              <div className="space-y-2">
                {room.participants.map(p => {
                  const isMeHost = room.createdBy === self.name;
                  const isSelf = p.name === self.name && p.client === 'web';
                  const canKick = isMeHost && !isSelf && !ended;
                  const isMuted = p.canSpeak === false;
                  const canMuteToggle = isMeHost && !isSelf && !ended;
                  const canAsk = canConfigureReplyMode && p.client === 'cc' && !isMuted;
    const presence = participantPresence(p, now, t);
                  // Whole-row visual fade for participants who haven't been
                  // seen in a while — keeps the row legible but signals
                  // "probably gone" without screaming about it.
                  const rowFade = presence.kind === 'idle'
                    ? 'opacity-65'
                    : presence.kind === 'disconnected'
                      ? 'opacity-50'
                      : '';
                  return (
                    <div
                      key={`${p.name}-${p.client}`}
                      className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 transition ${rowFade} ${isMuted ? 'border-amber-300 bg-amber-50/60' : 'border-border-faint bg-surface-softer'}`}
                    >
                      <Avatar initials={p.initials} color={p.color} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] sm:text-xs font-semibold truncate flex items-center gap-1 flex-wrap">
                          {p.name}
                          {p.name === room.createdBy && <span className="text-[10px] font-semibold text-accent bg-accent-tint px-1.5 py-0.5 rounded">{t('room.host')}</span>}
                          {isMuted && <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">{t('room.muted')}</span>}
                        </div>
                        <div className="text-[11px] text-ink-soft truncate">
                          {[p.role, t(p.client === 'cc' ? 'room.cli' : 'room.browser')].filter(Boolean).join(' · ')}
                        </div>
                        <div className={`mt-1 flex items-center gap-1 text-[11px] font-medium ${presence.className}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${presence.dotClassName}`} />
                          <span>{presence.label}</span>
                          {presence.detail && <span className="text-ink-faint">· {presence.detail}</span>}
                        </div>
                      </div>
                      {/*
                        Host controls — always visible (no hover-to-reveal).
                        Hover-only buttons hid the kick action so badly that
                        a user reported "the delete agent button isn't
                        obvious" and "the mute button feels cramped". Keep
                        them quiet visually (low contrast, neutral border)
                        but always discoverable, and only render at all when
                        the viewer is actually the host.
                      */}
                      {(canAsk || canMuteToggle || canKick) && (
                        <div className="flex items-center gap-1">
                          {canAsk && (
                            <button
                              onClick={() => { void handleAskAgent(p); }}
                              title={t('room.askTitle', { name: p.name })}
                              aria-label={t('room.askTitle', { name: p.name })}
                              disabled={modeBusy}
                              className="flex h-10 min-w-10 sm:h-8 sm:min-w-8 items-center justify-center rounded-lg border border-accent-tint-border bg-accent-tint px-2.5 text-[12px] sm:text-[11px] font-semibold text-accent transition hover:bg-accent-tint-border active:scale-[0.98] disabled:opacity-60"
                            >
                              {t('room.ask')}
                            </button>
                          )}
                          {canMuteToggle && (
                            <button
                              onClick={() => handleToggleMute({ name: p.name, client: p.client, canSpeak: p.canSpeak })}
                              title={t(isMuted ? 'room.unmuteTitle' : 'room.muteTitle', { name: p.name })}
                              aria-label={t(isMuted ? 'room.unmuteTitle' : 'room.muteTitle', { name: p.name })}
                              className={`flex h-10 w-10 sm:h-8 sm:w-8 items-center justify-center rounded-lg border text-[11px] transition active:scale-[0.98] ${isMuted
                                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                : 'border-border-faint bg-surface text-ink-soft hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700'}`}
                            >
                              {/* Speaker glyph: solid when can speak, slashed when muted. */}
                              {isMuted ? (
                                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M8 3.5 4.5 6.25H2.5v3.5h2L8 12.5z" />
                                  <path d="m11 6 3 4M14 6l-3 4" />
                                </svg>
                              ) : (
                                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M8 3.5 4.5 6.25H2.5v3.5h2L8 12.5z" />
                                  <path d="M11 5.75c.75.6 1.25 1.4 1.25 2.25s-.5 1.65-1.25 2.25" />
                                </svg>
                              )}
                            </button>
                          )}
                          {canKick && (
                            <button
                              onClick={() => handleKick({ name: p.name, client: p.client })}
                              title={t('room.removeTitle', { name: p.name })}
                              aria-label={t('room.removeTitle', { name: p.name })}
                              className="flex h-10 w-10 sm:h-8 sm:w-8 items-center justify-center rounded-lg border border-border-faint bg-surface text-ink-soft transition active:scale-[0.98] hover:border-red-300 hover:bg-red-50 hover:text-red-600"
                            >
                              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
                                <path d="m4 4 8 8M12 4l-8 8" />
                              </svg>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="p-4 border-t border-border-faint flex gap-2">
              {!ended && room.createdBy === self.name && (
                <button
                  onClick={handleEndMeeting}
                  className="flex-1 min-h-10 sm:min-h-8 text-[13px] sm:text-xs font-semibold text-red-600 bg-red-50 px-3 rounded-lg transition active:scale-[0.98] hover:bg-red-100"
                >
                  {t('room.end')}
                </button>
              )}
              <button onClick={() => navigate('/')} className="flex-1 min-h-10 sm:min-h-8 text-[13px] sm:text-xs font-semibold text-ink-muted bg-surface-softer px-3 rounded-lg transition active:scale-[0.98]">
                {t('common.home')}
              </button>
            </div>
          </aside>

          <section className={`${mobilePanel === 'chat' ? 'flex' : 'hidden'} lg:flex min-h-0 min-w-0 flex-col`}>
            <div className="hidden lg:flex px-5 py-3 border-b border-border-faint bg-surface items-center justify-between">
              <div>
                <div className="text-sm font-semibold">{t('room.discussion')}</div>
                <div className="text-[10px] text-ink-soft">{t('room.liveChat')}</div>
              </div>
              {ended && <span className="text-[10px] font-semibold text-red-500">{t('room.ended')}</span>}
            </div>

            {replyMode === 'deliver' && (
              <DeliverPlanBar
                board={taskBoard.board}
                canStart={isHost && !ended}
                onStart={startDeliverPlan}
                onOpenBoard={() => setMobilePanel('tasks')}
              />
            )}
            <div ref={feedRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-3 sm:p-5 flex flex-col gap-3 bg-surface-soft relative">
              {(() => {
                // Names that appear with more than one client in the room get
                // disambiguated as "Name · web" / "Name · cc" in each bubble.
                const byName = new Map<string, Set<string>>();
                for (const p of room?.participants ?? []) {
                  if (!byName.has(p.name)) byName.set(p.name, new Set());
                  byName.get(p.name)!.add(p.client);
                }
                const ambiguousNames = new Set<string>();
                for (const [n, cs] of byName) if (cs.size > 1) ambiguousNames.add(n);
                const waitingPlan = activeDeliverPlan(taskBoard.board);
                const startPlanId = isHost && waitingPlan && !waitingPlan.startedAt ? waitingPlan.id : undefined;
                return messages.map(m => (isDeliverEvent(m) ? (
                  <DeliverEventCard
                    key={m.id}
                    message={m}
                    onViewTaskBoard={() => setMobilePanel('tasks')}
                    onStart={startPlanId ? startDeliverPlan : undefined}
                    startPlanId={startPlanId}
                  />
                ) : (
                  <Bubble
                    key={m.id}
                    message={m}
                    self={m.name === self.name}
                    ambiguousNames={ambiguousNames}
                    speakingMessageId={speakingMessageId}
                  />
                )));
              })()}

              {messages.length === 0 && (
                <div className="m-auto max-w-xs px-2 text-center">
                  <h2 className="text-[15px] font-semibold text-ink">{t('room.nothingSaid')}</h2>
                  <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                    {roomAgents.length === 0
                      ? t('room.noMessagesNoAgent')
                      : t('room.noMessagesWithAgent')}
                  </p>
                  {roomAgents.length === 0 && (
                    <button
                      type="button"
                      onClick={() => copyText(joinUrl, t('room.inviteLinkCopied'))}
                      className="mt-4 min-h-10 rounded-lg bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition active:scale-[0.98] hover:opacity-90"
                    >
                      {t('room.copyInviteLink')}
                    </button>
                  )}
                </div>
              )}

              {showIdlePrompt && !ended && (
                <div className="sticky bottom-0 mx-auto bg-white border border-border rounded-xl shadow-lg p-4 text-center max-w-sm">
                  <p className="text-sm font-semibold text-ink mb-1">{t('room.noActivity')}</p>
                  <p className="text-xs text-ink-soft mb-3">{t('room.closesIn', { seconds: countdown })}</p>
                  <div className="flex gap-2 justify-center">
                    <button onClick={dismissIdlePrompt} className="px-4 py-1.5 bg-accent text-white text-xs font-semibold rounded-lg">
                      {t('room.keepOpen')}
                    </button>
                    <button onClick={handleEndMeeting} className="px-4 py-1.5 bg-red-50 text-red-600 text-xs font-semibold rounded-lg border border-red-200">
                      {t('room.endNow')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {ended ? (
              // A1: ended-room CTA pivots from "Reactivate-only" to a primary
              // "Save & Share" call-to-action. Once the meeting wraps, the most
              // valuable next step is to freeze it into a shareable report
              // report (creates the asset + copies the link to clipboard);
              // Reactivate stays available as a secondary option, Back-to-home
              // tertiary. This makes share-link generation a one-click move
              // and feeds the viral loop: every shared link is also a demo of
              // the product.
              <div className="border-t border-border-faint p-4 bg-surface-softer">
                <p className="text-xs text-ink-soft mb-3 text-center">
                  {t('room.endedReportPrompt')}
                </p>
                <div className="flex flex-wrap gap-3 justify-center items-center">
                  <button
                    onClick={handleExportReport}
                    disabled={reportBusy || messages.length === 0}
                    className="text-xs font-semibold text-white bg-accent px-4 py-1.5 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {reportBusy ? t('task.saving') : t('task.saveReport')}
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        const client = createClient(ENV.upstash);
                        await reactivateRoomApi(client, code);
                        // Reset the full idle pipeline. Without these the idle timer
                        // would immediately re-fire (lastMsgTimeRef is still hours
                        // old, showIdlePrompt may still be true) and the room would
                        // close again 5 seconds later — the "reactivate → close →
                        // reactivate → close" loop users hit.
                        lastMsgTimeRef.current = Date.now();
                        setShowIdlePrompt(false);
                        setCountdown(AUTO_CLOSE_COUNTDOWN);
                        if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
                        if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
                        setEnded(false);
                        await refreshRoom();
                      } catch {}
                    }}
                    className="text-xs font-semibold text-ink-muted bg-surface border border-border px-4 py-1.5 rounded-lg hover:border-accent/40 hover:text-accent transition"
                  >
                    {t('room.reactivate')}
                  </button>
                  <button onClick={() => navigate('/')} className="text-xs font-semibold text-ink-faint hover:text-ink-muted">{t('room.backHome')}</button>
                </div>
              </div>
            ) : !myCanSpeak ? (
              <SpeakBlockedNotice host={room.createdBy} />
            ) : (
              <Composer
                roomCode={code}
                text={text}
                onTextChange={setText}
                onAppendText={appendText}
                onSubmit={submitMessage}
                ended={ended}
                textareaRef={textareaRef}
                banner={isHost && mutedCount > 0 ? (
                  <div className="text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 flex items-center gap-2">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                      <path d="M8 3.5 4.5 6.25H2.5v3.5h2L8 12.5z" />
                      <path d="m11 6 3 4M14 6l-3 4" />
                    </svg>
                    <span>{t(mutedCount === 1 ? 'room.mutedOne' : 'room.mutedCount', { count: mutedCount })}</span>
                  </div>
                ) : null}
                deck={(
                /*
                  Command deck. Targeting an agent used to live only as an
                  "Ask" button inside each People row, so on a phone giving one
                  agent a job meant leaving Chat, finding the row, tapping Ask,
                  then coming back. The agents are now chips on the composer
                  itself: tap to address one (or to hand it the turn directly
                  in sequential / moderator mode) without losing the thread.
                */
                <div className="flex w-full min-w-0 flex-wrap items-center gap-2 py-0.5 shrink-0">
                  {roomAgents.length === 0 ? (
                    messages.length > 0 && (
                      <span className="w-full text-[12px] text-ink-soft">
                        {t('room.noAgentsHint')}
                      </span>
                    )
                  ) : (
                    roomAgents.map(agent => {
                      const muted = agent.canSpeak === false;
                      return (
                        <button
                          key={`${agent.name}-${agent.client}`}
                          type="button"
                          disabled={modeBusy || muted}
                          onClick={() => { void handleAskAgent(agent); }}
                          title={muted ? t('room.mutedTitle', { name: agent.name }) : t('room.askTitle', { name: agent.name })}
                          className="shrink-0 min-h-10 rounded-full border border-accent-tint-border bg-accent-tint px-3.5 text-[13px] font-semibold text-accent transition hover:bg-accent-tint-border active:scale-[0.98] disabled:opacity-45 disabled:cursor-not-allowed"
                        >
                          @{agent.name}
                        </button>
                      );
                    })
                  )}
                  {roomAgents.length > 0 && (<>
                  <button
                    type="button"
                    onClick={() => fillPrompt('minutes')}
                    className="shrink-0 min-h-10 rounded-full border border-border bg-surface-softer px-3.5 text-[13px] font-semibold text-ink-muted transition hover:border-accent/40 hover:text-accent active:scale-[0.98]"
                  >
                    {t('room.minutes')}
                  </button>
                  <button
                    type="button"
                    onClick={() => fillPrompt('reply')}
                    className="shrink-0 min-h-10 rounded-full border border-border bg-surface-softer px-3.5 text-[13px] font-semibold text-ink-muted transition hover:border-accent/40 hover:text-accent active:scale-[0.98]"
                  >
                    {t('room.replyDraft')}
                  </button>
                  </>)}
                </div>
                )}
                tools={(
                  <VoiceButton
                    // Plan B: speak, stop, and the transcript is sent at once (any
                    // pending typed draft is merged in front of it).
                    onTranscript={async (spoken) => {
                      if (ended || !spoken.trim()) return;
                      const merged = text.trim() ? `${text.trim()} ${spoken.trim()}` : spoken.trim();
                      const msg: Message = {
                        id: Date.now(),
                        type: 'msg',
                        name: me.name,
                        role: me.role,
                        initials: initialsFor(me.name),
                        color: colorForName(me.name),
                        client: 'web',
                        text: merged,
                        time: Date.now(),
                      };
                      setText('');
                      try {
                        await sendMessage(msg);
                        if (isHost && replyMode === 'deliver') {
                          void onDeliverHostMessage(createClient(ENV.upstash), code, activeRoom, merged)
                            .then(() => taskBoard.reload())
                            .catch(() => { /* best-effort */ });
                        }
                      } catch (e) {
                        const { showToast } = await import('../components/Toast.js');
                        showToast(t('room.sendFailed', { error: e instanceof Error ? e.message : t('common.unknownError') }), 'error');
                        setText(merged); // restore draft so the user can retry
                      }
                    }}
                    disabled={ended}
                  />
                )}
              />
            )}
          </section>

          <aside className={`${mobilePanel === 'tasks' ? 'flex' : 'hidden'} lg:flex min-h-0 min-w-0 flex-col border-l border-border-faint bg-surface`}>
            {/*
              The task board the MCP server has always had (room_task: owner,
              a different verifier, evidence, verdicts) but the web client
              never rendered. Before this, a host on a phone could only infer
              agent progress from chat prose and regex-scraped [TODO] markers.
            */}
            <TaskBoard
              code={code}
              room={activeRoom}
              me={me}
              isHost={isHost}
              ended={ended}
              agents={roomAgents}
              artifacts={artifacts}
              canExport={messages.length > 0}
              reportBusy={reportBusy}
              onExportReport={handleExportReport}
              onMention={appendText}
              taskBoard={taskBoard}
            />
          </aside>
        </div>
      </div>
    </div>
    </RoomRecoverySurface>
  );
}

export function RoomRecoverySurface({ room, error, children }: {
  room: Room | null;
  error: string | null;
  children?: ReactNode;
}) {
  const { t } = useLocale();
  if (error && !room) return (
    <div className="mx-auto max-w-3xl p-6 sm:p-10 text-red-700">
      <div className="mb-4 flex justify-end"><LocaleSwitcher compact /></div>
      <p>{t('common.somethingWentWrong')}</p>
      <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-ink-soft">{error}</pre>
    </div>
  );

  return (
    <>
      {room && error && (
        <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          {t('room.connectionRetry')}
        </div>
      )}
      {children}
    </>
  );
}

function participantPresence(p: Participant, now: number, t: (key: MessageKey, values?: MessageValues) => string) {
  const status = participantPresenceStatus(p, now);
  if (status === 'listening') {
    return {
      kind: 'listening' as const,
      label: t('room.listeningNow'),
      detail: '',
      className: 'text-emerald-700',
      dotClassName: 'bg-emerald-500',
    };
  }
  if (status === 'online') {
    return {
      kind: 'online' as const,
      label: t('room.online'),
      detail: '',
      className: 'text-blue-700',
      dotClassName: 'bg-blue-500',
    };
  }
  if (status === 'recent_activity') {
    return {
      kind: 'idle' as const,
      label: t('room.notListening'),
      detail: t('room.recentlyActive'),
      className: 'text-ink-soft',
      dotClassName: 'bg-slate-400',
    };
  }
  if (status === 'disconnected') {
    return {
      kind: 'disconnected' as const,
      label: t('room.disconnected'),
      detail: p.client === 'cc' ? t('room.hostCanRemove') : '',
      className: 'text-ink-faint',
      dotClassName: 'bg-slate-400',
    };
  }
  return {
    kind: 'idle' as const,
    label: t('room.idle'),
    detail: p.client === 'cc' ? t('room.notListeningDetail') : '',
    className: 'text-ink-faint',
    dotClassName: 'bg-slate-300',
  };
}
