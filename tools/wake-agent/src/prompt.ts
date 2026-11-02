/**
 * Hosted-seat prompts.
 *
 * Shared wake/sleep semantics live in the outer `rules.md` and are also
 * inlined into each seat's `AGENTS.md` (for CLIs that auto-load cwd docs).
 * Per-seat 职位 / seatKey / 房间码 / MCP 别名 live only in AGENT_ROOM_* env
 * at CLI launch — not in a state.md file.
 * Wake inject is a short human line with 动作游标 (= since) only —
 * seatKey is not repeated in the inject text.
 *
 * Never force absolute install-disk paths (e.g. D:\\Agent Room\...) into
 * "请阅读" lines: Codex Windows elevated sandbox often lacks those read_roots
 * and codex-windows-sandbox-setup.exe can spin forever on the file-read tool.
 */

export function firstRunPrompt(input: {
  code: string;
  name: string;
  readFrom: number;
  seatKey: string;
  gap?: readonly [number, number];
  /** When set, short prompt: rules are in AGENTS.md; seat fields in AGENT_ROOM_*. */
  rulesPath?: string;
  /** @deprecated Ignored — seat fields are env-only; kept for call-site compat. */
  statePath?: string;
}): string {
  if (input.rulesPath) {
    const lines = [
      `你是房间 ${input.code} 的座位 ${input.name}。`,
      '本座位已经加入房间：本机托管进程已经用邀请码完成进房。你已经在这个座位上。',
      '禁止调用 room_join。不要向用户索要邀请码，也不要再进一次房。',
      '本工作目录已有 AGENTS.md（规则已内联）。座位字段只用环境变量 AGENT_ROOM_CODE / AGENT_ROOM_NAME / AGENT_ROOM_SEAT_KEY / AGENT_ROOM_MCP_ALIAS（不要 printenv / Get-Content / shell 探测，不要读 state.md，不要写进回复）。',
      '直接按 AGENTS.md 规则工作：立刻 room_listen，不要先列目录或探测环境。不要用文件读取工具去打开安装盘上的绝对路径（Windows 沙箱可能卡住）。',
      '禁止主动发「已上线」/进房问候；只有被 @ 或有明确工作时才 room_send。',
      `执行唤醒监听，动作游标=${input.readFrom}`,
      '追历史只用一次 timeoutMs:0；随后必须用默认 hold（勿再传 timeoutMs:0）；Quiet / listenStatus=sleep 时只调 room_sleep。',
      'MCP 工具已预先批准，直接调用即可。不要修改任何配置文件、权限文件或 MCP 设置。',
    ];
    if (input.gap) lines.push(`注意：第 ${input.gap[0]}–${input.gap[1] - 1} 条消息已被房间清除，无法读取。`);
    return lines.join('\n');
  }

  // Legacy fallback when rooms/rules files were not written (unit tests / old installs).
  const seatKey = JSON.stringify(input.seatKey);
  return [
    `你是房间 ${input.code} 的座位 ${input.name}。`,
    '本座位已经加入房间：本机托管进程已经用邀请码完成进房。你已经在这个座位上。',
    '禁止调用 room_join。不要向用户索要邀请码，也不要再进一次房。',
    `如果你仍然调用 room_join，必须传入 seatKey: ${seatKey}（与环境变量 AGENT_ROOM_SEAT_KEY 是同一个值）。不要向用户索要邀请码。优先只调用 room_listen。`,
    `cursor 用 ${input.readFrom}，与环境变量 AGENT_ROOM_CURSOR 相同。`,
    '接下来只调用 room_listen 读取并处理消息、完成房间里交给你的工作，没有新的 @ 时调用 room_sleep。',
    '下面示例里的 seatKey 就是本座位的值。调用房间 MCP 工具时直接照填（不要用 shell/cat/printenv 去读，也不要打印或写进回复）。',
    'MCP 工具已预先批准，直接调用即可，不要等用户在终端里逐个点批准。不要修改任何配置文件、权限文件或 MCP 设置（包括 ~/.cursor、~/.codex、cli-config 等）。',
    wakePrompt(input),
  ].join('\n');
}

/**
 * Full wake text for stop+resume when rules paths are unknown.
 * Prefer reuseWakePrompt + on-disk rules when the PTY is still alive.
 */
export function wakePrompt(input: {
  code: string;
  name: string;
  readFrom: number;
  seatKey: string;
  gap?: readonly [number, number];
  rulesPath?: string;
  /** @deprecated Ignored — seat fields are env-only. */
  statePath?: string;
}): string {
  if (input.rulesPath) {
    const lines = [
      `执行唤醒监听，动作游标=${input.readFrom}`,
      '按本工作目录 AGENTS.md 与环境变量 AGENT_ROOM_* 调用 room_listen / room_sleep；不要读 state.md。',
      '追历史只用一次 timeoutMs:0；随后默认 hold；Quiet / listenStatus=sleep 只 room_sleep，禁止 timeoutMs:0 连打。',
      '不要用文件工具打开安装盘绝对路径。不要改配置或权限，不要把 seatKey 写进回复。',
    ];
    if (input.gap) lines.push(`注意：第 ${input.gap[0]}–${input.gap[1] - 1} 条消息已被房间清除，无法读取。`);
    return lines.join('\n');
  }

  const seatKey = JSON.stringify(input.seatKey);
  const lines = [
    `你在房间 ${input.code} 被 @ 了。`,
    'MCP 工具已预先批准。直接调用房间工具，不要等用户在终端里逐个批准，也不要改配置文件或权限列表。',
    `1) 先调用 room_listen({ code: "${input.code}", name: "${input.name}", since: ${input.readFrom}, timeoutMs: 0, managed: { seatKey: ${seatKey} } })`,
    '   读取未处理的消息，并处理其中给你的工作、在房间里回复。不要把 seatKey 写进回复。',
    `2) 处理完后调用 room_listen({ code: "${input.code}", name: "${input.name}", since: <上一步返回的 cursor>, managed: { seatKey: ${seatKey} } })`,
    '   正常监听一轮；有新的 @ 就继续处理。',
    `3) 一轮内没有新的 @：调用 room_sleep({ code: "${input.code}", name: "${input.name}", cursor: <最新 cursor>, seatKey: ${seatKey} }) 后结束。`,
  ];
  if (input.gap) lines.push(`注意：第 ${input.gap[0]}–${input.gap[1] - 1} 条消息已被房间清除，无法读取。`);
  return lines.join('\n');
}

/** Short follow-up when the existing PTY/session is still alive — no seatKey, no full blob. */
export function reuseWakePrompt(input: {
  readFrom: number;
  /** Optional; ignored for the short line but kept so call sites can pass seat fields. */
  code?: string;
  name?: string;
  seatKey?: string;
}): string {
  return `执行唤醒监听，动作游标=${input.readFrom}`;
}

export function launchPrompt(code: string, name: string): string {
  return [
    `请加入 Agent Room 房间 ${code}。`,
    `调用 room_join({ code: "${code}", name: "${name}" })，然后按房间规则工作。`,
    'seatKey 由 MCP 客户端保存，不要把 seatKey 或设备凭据写进回复。',
  ].join('\n');
}
