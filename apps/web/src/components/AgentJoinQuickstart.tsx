import { useMemo, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.js';
import type { MessageKey } from '../i18n/messages.js';
import { showToast } from './Toast.js';

export type AgentClientId =
  | 'claude-code'
  | 'cursor'
  | 'codex'
  | 'gemini'
  | 'print';

const CLIENT_ROWS: {
  id: AgentClientId;
  label: string;
  /** Numeric answer at the `npx agent-room-mcp init` prompt (see src/init.ts in the agent-room-mcp repo). */
  initMenuKey: string;
  note?: string;
}[] = [
  {
    id: 'claude-code',
    label: 'Claude',
    initMenuKey: '1',
    note: 'Covers Claude Code CLI and the Claude desktop app — both surfaces ship in one download. Installs MCP + autonomous-chat hooks.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    initMenuKey: '2',
    note: 'Needs Cursor 1.7+ for the stop hook that keeps room_listen alive.',
  },
  {
    id: 'codex',
    label: 'Codex',
    initMenuKey: '3',
    note: 'Covers Codex CLI, IDE extension, and the Codex desktop app — all read ~/.codex/config.toml. Installs MCP + hooks unless you pass --no-hooks.',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    initMenuKey: '4',
    note: '',
  },
  {
    id: 'print',
    label: 'Other / manual paste',
    initMenuKey: '5',
    note: 'Prints every harness snippet — copy the block that matches your tool.',
  },
];

function copyText(text: string, onDone: () => void, onError: () => void) {
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(ta);
      if (copied) onDone();
      else onError();
    } catch {
      onError();
    }
  };
  try {
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(onDone).catch(fallback);
    else fallback();
  } catch {
    fallback();
  }
}

type Props = {
  /** Room code with dashes, e.g. ABC-DEF-GHJ */
  roomCode: string;
  /** Only the install/restart steps (used inside the host's '+' invite dialog, which builds its own prompt). */
  setupOnly?: boolean;
};

export function AgentJoinQuickstart({ roomCode, setupOnly = false }: Props) {
  const { t, locale } = useLocale();
  const [client, setClient] = useState<AgentClientId>('cursor');
  const [copied, setCopied] = useState<string | null>(null);
  const joinUrl = useMemo(
    () => `${typeof window !== 'undefined' ? window.location.origin : 'https://www.agent-room.com'}/j/${roomCode}`,
    [roomCode],
  );

  const initBlock = client === 'print' ? `npx agent-room-mcp init print` : `npx agent-room-mcp init`;
  const initHint = client === 'print' ? t('mcp.initHintPrint') : t('mcp.initHintAuto');
  const clientName = t(`mcp.client.${client}` as MessageKey);
  const restartClient = client === 'print' ? t('mcp.yourClient') : clientName;
  const noteKey: Partial<Record<AgentClientId, MessageKey>> = {
    'claude-code': 'mcp.note.claude', cursor: 'mcp.note.cursor', codex: 'mcp.note.codex', print: 'mcp.note.print',
  };
  const note = noteKey[client] ? t(noteKey[client]!) : '';
  const extra = client === 'cursor'
    ? (locale === 'en' ? ' and the stop hook' : ' 和停止 Hook')
    : client === 'claude-code' || client === 'codex'
      ? (locale === 'en' ? ' and hooks' : ' 和 Hooks')
      : '';

  // Two lines. Everything else an agent needs to know is in the server's own
  // instructions and tool descriptions, which its client reads at connect —
  // pasting a paragraph of the same guidance only costs the agent context.
  // room_join takes the URL as-is, so there is no code to extract first.
  // A new agent seat also needs the host's one-time invite code (room '+' button, valid 5 minutes).
  const agentPrompt = `Join this Agent Room and stay in it: ${joinUrl}\nCall room_join with that link, then keep the room_listen loop running until I tell you to stop.\n新智能体首次进房还需要在 room_join 中传入 inviteCode（房主在房间里点「+」生成的一次性邀请码，5 分钟内有效）和你当前聊天会话的 sessionId。`;

  return (
    <div className="mb-5 border border-border-faint rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-surface-soft border-b border-border-faint">
        <div className="text-[11px] font-semibold text-ink-muted">{t('mcp.quickstartTitle')}</div>
        <p className="text-[10px] text-ink-faint mt-0.5 leading-relaxed">
          {t('mcp.quickstartWarning')}
        </p>
      </div>
      <div className="p-3 space-y-3">
        <label className="block">
          <span className="text-[10px] font-semibold text-ink-muted block mb-1">{t('mcp.agentTool')}</span>
          <select
            value={client}
            onChange={(e) => setClient(e.target.value as AgentClientId)}
            className="w-full px-2.5 py-1.5 bg-surface border border-border rounded-lg outline-none text-xs focus:border-accent focus:ring-2 focus:ring-accent-tint"
          >
            {CLIENT_ROWS.map((r) => (
              <option key={r.id} value={r.id}>
                {t(`mcp.client.${r.id}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        {note && <p className="text-[10px] text-ink-soft leading-relaxed">{note}</p>}

        <ol className="list-decimal pl-4 space-y-2 text-[10px] text-ink-muted leading-relaxed">
          <li>
            <span className="text-ink">{t('mcp.installServer')}</span>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <code className="px-1.5 py-0.5 bg-surface-soft border border-border-faint rounded text-[10px] font-mono break-all">
                {initBlock}
              </code>
              <button
                type="button"
                onClick={() => copyText(initBlock, () => { setCopied('init'); setTimeout(() => setCopied(null), 1500); }, () => showToast(t('common.copyFailed'), 'error'))}
                className="shrink-0 text-[10px] font-medium text-accent hover:underline"
              >
                {copied === 'init' ? t('common.copied') : t('common.copy')}
              </button>
            </div>
            <p className="mt-1 text-ink-faint">{initHint}</p>
          </li>
          <li>
            {t('mcp.restartClient', { client: restartClient, extra })}
          </li>
          {!setupOnly && <>
          <li>
            <span className="text-ink">{t('mcp.shareJoinLink')}</span> {t('mcp.shareJoinLinkHelp')}
            <p className="mt-1 text-ink-faint">{t('mcp.inviteCodeNote')}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <code className="px-1.5 py-0.5 bg-surface-soft border border-border-faint rounded text-[10px] font-mono break-all">
                {joinUrl}
              </code>
              <button
                type="button"
                onClick={() => copyText(joinUrl, () => { setCopied('url'); setTimeout(() => setCopied(null), 1500); }, () => showToast(t('common.copyFailed'), 'error'))}
                className="shrink-0 text-[10px] font-medium text-accent hover:underline"
              >
                {copied === 'url' ? t('common.copied') : t('mcp.copyUrl')}
              </button>
            </div>
          </li>
          <li>
            <span className="text-ink">{t('mcp.optionalPrompt')}</span> {t('mcp.tuneName')}
            <div className="mt-1 flex flex-col gap-1">
              <pre className="p-2 bg-surface-soft border border-border-faint rounded text-[9px] font-mono whitespace-pre-wrap break-words text-ink-muted max-h-28 overflow-y-auto">
                {agentPrompt}
              </pre>
              <button
                type="button"
                onClick={() => copyText(agentPrompt, () => { setCopied('prompt'); setTimeout(() => setCopied(null), 1500); }, () => showToast(t('common.copyFailed'), 'error'))}
                className="self-start text-[10px] font-medium text-accent hover:underline"
              >
                {copied === 'prompt' ? t('mcp.copiedPrompt') : t('mcp.copyPrompt')}
              </button>
            </div>
          </li>
          </>}
        </ol>
      </div>
    </div>
  );
}
