// Pieces of the host's '+' (invite an agent) dialog that do not need React.

/** Suggested roles. The chosen role is also the agent's personaId (profession = Persona identity). */
export const SUGGESTED_INVITE_ROLES: readonly string[] = [
  '记忆审核员',
  '开发工程师',
  '测试工程师',
  '产品经理',
  '架构师',
  '代码审查员',
  '研究员',
];

export interface AgentInviteResponse {
  inviteCode: string;
  role: string;
  personaId: string;
  createdAt: number;
  expiresAt: number;
  ttlSeconds: number;
}

/** mm:ss for the countdown; never negative. */
export function formatInviteCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The one-click copy block handed to the agent (Simplified Chinese, per product
 * decision). It names every room_join argument the invite needs.
 */
export function buildAgentInvitePrompt(input: {
  joinUrl: string;
  inviteCode: string;
  role: string;
  ttlMinutes: number;
}): string {
  const quoted = (value: string) => JSON.stringify(value);
  return [
    `请通过 MCP 加入这个 Agent Room，并一直留在房间里：${input.joinUrl}`,
    `邀请码：${input.inviteCode}（一次性，生成后 ${input.ttlMinutes} 分钟内有效，只能使用一次）`,
    '调用 room_join，参数如下：',
    `- code: ${quoted(input.joinUrl)}（直接传这个链接即可）`,
    '- name: 你自己的智能体名称',
    `- inviteCode: ${quoted(input.inviteCode)}`,
    `- personaId: ${quoted(input.role)}`,
    `- role: ${quoted(input.role)}`,
    '- sessionId: 你当前聊天会话的 ID',
    '加入后持续运行 room_listen 循环，直到我让你停止。之后重连请带上 room_join 返回的 seatKey，不需要再用邀请码。',
    '如果返回 invite_code_expired 或 invite_code_invalid，请告诉我重新生成邀请码，不要反复重试。',
  ].join('\n');
}

/** POST /api/room action createAgentInvite (host-only; hostKey from this browser). */
export async function requestAgentInvite(code: string, hostKey: string, role: string): Promise<AgentInviteResponse> {
  const response = await fetch('/api/room', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'createAgentInvite', code, hostKey, role }),
  });
  const body = await response.json().catch(() => ({})) as { invite?: AgentInviteResponse; error?: string; message?: string };
  if (!response.ok || !body.invite) {
    throw new Error(body.message || body.error || `HTTP ${response.status}`);
  }
  return body.invite;
}

export function storedRoomHostKey(code: string): string | null {
  try {
    return localStorage.getItem(`room:${code}:hostKey`) ?? sessionStorage.getItem(`room:${code}:hostKey`);
  } catch {
    return null;
  }
}
