/**
 * First launch, after the daemon has already joined the room.
 * Names the seatKey env var and never includes the secret itself.
 */
export function firstRunPrompt(input: {
  code: string;
  name: string;
  readFrom: number;
  gap?: readonly [number, number];
}): string {
  return [
    `你是房间 ${input.code} 的座位 ${input.name}。`,
    '你的 seatKey 在环境变量 AGENT_ROOM_SEAT_KEY 里。调用房间 MCP 工具时直接把它填进 `seatKey` / `managed.seatKey` 参数（不要用 shell/cat/printenv 去读，也不要打印或写进回复）。room_sleep 的 seatKey 同样填这个值，不要留空，也不要写占位符。',
    'MCP 工具已预先批准，直接调用即可，不要等用户在终端里逐个点批准。不要修改任何配置文件、权限文件或 MCP 设置（包括 ~/.cursor、~/.codex、cli-config 等）。',
    wakePrompt({ code: input.code, name: input.name, readFrom: input.readFrom, gap: input.gap }),
  ].join('\n');
}

/** Wake prompt from the design. It names the seatKey env var and never includes the secret or a message body. */
export function wakePrompt(input: {
  code: string;
  name: string;
  readFrom: number;
  gap?: readonly [number, number];
}): string {
  const lines = [
    `你在房间 ${input.code} 被 @ 了。`,
    'MCP 工具已预先批准。直接调用房间工具，不要等用户在终端里逐个批准，也不要改配置文件或权限列表。',
    `1) 先调用 room_listen({ code: "${input.code}", name: "${input.name}", since: ${input.readFrom}, timeoutMs: 0, managed: { seatKey: "<AGENT_ROOM_SEAT_KEY>" } })`,
    '   读取未处理的消息，并处理其中给你的工作、在房间里回复。seatKey 用环境变量里的值，不要写进回复。',
    `2) 处理完后调用 room_listen({ code: "${input.code}", name: "${input.name}", since: <上一步返回的 cursor>, managed: { seatKey: "<AGENT_ROOM_SEAT_KEY>" } })`,
    '   正常监听一轮；有新的 @ 就继续处理。',
    `3) 一轮内没有新的 @：调用 room_sleep({ code: "${input.code}", name: "${input.name}", cursor: <最新 cursor>, seatKey: "<AGENT_ROOM_SEAT_KEY>" }) 后结束。`,
  ];
  if (input.gap) lines.push(`注意：第 ${input.gap[0]}–${input.gap[1] - 1} 条消息已被房间清除，无法读取。`);
  return lines.join('\n');
}

export function launchPrompt(code: string, name: string): string {
  return [
    `请加入 Agent Room 房间 ${code}。`,
    `调用 room_join({ code: "${code}", name: "${name}" })，然后按房间规则工作。`,
    'seatKey 由 MCP 客户端保存，不要把 seatKey 或设备凭据写进回复。',
  ].join('\n');
}
