/**
 * First launch, after the daemon has already joined the room.
 * The seatKey value is embedded in the tool calls. Name AGENT_ROOM_SEAT_KEY as the
 * same value so a model that still calls room_join can resume, but do not tell it
 * to print the environment.
 */
export function firstRunPrompt(input: {
  code: string;
  name: string;
  readFrom: number;
  seatKey: string;
  gap?: readonly [number, number];
}): string {
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

/** Wake prompt. Tool calls carry the seatKey value. It does not include a message body. */
export function wakePrompt(input: {
  code: string;
  name: string;
  readFrom: number;
  seatKey: string;
  gap?: readonly [number, number];
}): string {
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

export function launchPrompt(code: string, name: string): string {
  return [
    `请加入 Agent Room 房间 ${code}。`,
    `调用 room_join({ code: "${code}", name: "${name}" })，然后按房间规则工作。`,
    'seatKey 由 MCP 客户端保存，不要把 seatKey 或设备凭据写进回复。',
  ].join('\n');
}
