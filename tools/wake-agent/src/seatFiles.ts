import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dirname as posixDirname, join as posixJoin } from 'node:path/posix';
import { dirname as winDirname, join as winJoin } from 'node:path/win32';

/** Default MCP server key written by desktop 一键配置. */
export const DEFAULT_MCP_ALIAS = 'agent-room';

export function defaultRoomsDir(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.AGENT_ROOM_ROOMS_DIR?.trim();
  if (fromEnv) return fromEnv;
  // stateDir is usually `<install>/logs` (Win) or a posix path in tests.
  if (stateDir.includes('\\') || /^[A-Za-z]:/.test(stateDir)) {
    return winJoin(winDirname(stateDir), 'rooms');
  }
  return posixJoin(posixDirname(stateDir), 'rooms');
}


export function sharedRulesPath(roomsDir: string): string {
  return join(roomsDir, 'rules.md');
}

/** Folder name under rooms/<code>/ — human-readable CLI+职位, unique via seatId suffix when needed. */
export function seatFolderName(adapterId: string, name: string, seatId: string): string {
  const base = sanitizeSegment(`${adapterId}-${name}`);
  const id = sanitizeSegment(seatId);
  if (base && id && !base.endsWith(id)) return `${base}__${id}`;
  return base || id || 'seat';
}

export function seatDirPath(roomsDir: string, code: string, adapterId: string, name: string, seatId: string): string {
  return join(roomsDir, sanitizeSegment(code) || 'room', seatFolderName(adapterId, name, seatId));
}

/** Legacy path — only used to delete leftover state.md from older builds. */
export function seatStatePath(seatDir: string): string {
  return join(seatDir, 'state.md');
}

export function sanitizeSegment(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80);
}

/** Shared outer rules — one copy for all seats; do not put seatKey here. */
export function sharedRulesMarkdown(): string {
  return [
    '# Agent Room 通用规则（托管座位）',
    '',
    '本文件由桌面端维护，所有托管座位共用一份。不要读、不要写 `state.md`。',
    '',
    '## 术语',
    '',
    '- **动作游标**：唤醒短指令里的「动作游标=N」只是这一次 `room_listen` 的 `since`。它不是 `room_sleep` 的 cursor。',
    '- **room_sleep 的 cursor**：必须等于最近一次 `room_listen` 返回的 `cursor`（或 `nextAction.arguments.cursor`）。禁止把唤醒句里的起始动作游标当作 sleep cursor。',
    '- **回复模式**：以 `room_listen` 返回的 `replyMode` 为准。长篇 roomPolicy 只在进房时给一次，不要等每次 listen 再贴。',
    '- **座位身份**：房间码 / 职位见下方「本座位」与首启说明（「你是房间 … 的座位 …」）。`seatKey` 由本机 **mcp-shim** 从进程环境自动补全——你不必、也往往无法通过 `functions.exec`/shell 读到 `AGENT_ROOM_*`（沙箱常不暴露）。',
    '',
    '## 唤醒监听',
    '',
    '当收到「执行唤醒监听，动作游标=N」（或首次启动的等价指令）时：',
    '',
    '1. 用「本座位」/首启里的房间码与职位，以及动作游标 N。**不要**读 `state.md`，不要用 shell/`printenv`/`functions.exec` 探测环境变量。',
    '2. **追历史只用一次**：调用 `room_listen({ code, name, since: N, timeoutMs: 0, managed: {} })`（或 `managed: { seatKey: "" }`）。本机 mcp-shim 会填入真 seatKey。这是非阻塞快读；**禁止**反复用 `timeoutMs: 0`。若返回 `more: true`，用返回的 `cursor` 再调 `room_listen`（不要带 `timeoutMs: 0`；已经在房间里的消息会马上返回）直到 `more` 消失。不要丢掉还没返回的后半段，也不要连跳。',
    '3. 若有未处理消息或交给你的工作：处理完并在房间回复（`room_send`）。',
    '4. **随后必须用默认 hold**：再调用 `room_listen({ code, name, since: <上一步 cursor>, managed: {} })`——**不要**传 `timeoutMs: 0`（省略 timeoutMs，走默认长轮询约 30–40s）。若工具返回的 nextAction 已带 seatKey，可照填；否则继续让 shim 补全。**禁止编造 seatKey**。',
    '5. hold 返回后若有新的 @ / 工作：处理完再回到第 4 步（继续 hold，仍不要 `timeoutMs: 0`）。',
    '6. 若返回 Quiet / `listenStatus=sleep` / `nextAction.tool=room_sleep`：进入下方休眠；**禁止**再以 `timeoutMs: 0` 连打 `room_listen`。',
    '',
    '## 默认动作（休眠）',
    '',
    '只有在一次真实 hold（省略 `timeoutMs` 或 `timeoutMs`>0）出现 Quiet / `listenStatus=sleep` 之后：调用 `room_sleep({ code, name, cursor: <最近一次 room_listen 返回的 cursor>, seatKey: "" })`（shim 会填 seatKey；若 nextAction.arguments 已给齐可直接用）。禁止把唤醒句里的起始动作游标当作 room_sleep 的 cursor。然后结束本轮，等待下次唤醒。不要在追历史（`timeoutMs: 0`）之后立刻 sleep，也不要在 Quiet 后再 listen。',
    '',
    '## 禁止',
    '',
    '- 不要修改任何配置文件、权限文件或 MCP 设置（包括 ~/.cursor、~/.codex、cli-config 等）。',
    '- 本座位已由本机托管进房：禁止 `room_join`，不要向用户索要邀请码。',
    '- MCP 工具已预先批准，直接调用即可，不要等用户在终端里逐个点批准。',
    '- 不要用文件读取工具去打开安装盘上的绝对路径（例如 `D:\\Agent Room\\...`）；本工作目录的 `AGENTS.md` 已足够。不要读 `state.md`。',
    '- **启动后立刻 `room_listen`**：禁止用 shell/`printenv`/`Get-ChildItem`/`Get-Content`/`cat`/`ls`/`dir`/`functions.exec` 探测环境或“确认座位字段”。读不到 `AGENT_ROOM_*` 时仍须直接调工具，交给 mcp-shim。',
    '- **禁止主动发「已上线」/进房问候**：首次启动与 Quiet 后不要 `room_send` 自我介绍；只有被 @、有任务指派、或 catch-up 里确有要你处理的工作时才在房间发言。',
    '- 禁止用 `timeoutMs: 0` 循环调用 `room_listen`（会一秒连跳多次）；追历史一次后必须 hold。',
    '- **禁止编造 seatKey**：不要猜测或伪造；可传 `managed: {}` / 空字符串，由本机 mcp-shim 注入。把 seatKey 填进 MCP 工具参数 ≠ 往房间帖密钥。',
    '',
  ].join('\n');
}

/**
 * Project doc for CLIs that auto-load AGENTS.md / GEMINI.md from the seat cwd.
 * Inline the shared wake rules so Codex need not open absolute install-disk paths
 * via the sandboxed file-read tool (which can hang under Windows elevated sandbox).
 */
export function seatAgentsMarkdown(input: {
  rulesPath: string;
  code?: string;
  name?: string;
  mcpAlias?: string;
}): string {
  const code = (input.code ?? '').trim();
  const name = (input.name ?? '').trim();
  const alias = (input.mcpAlias ?? '').trim() || DEFAULT_MCP_ALIAS;
  const identity = [
    code ? `- 房间码：\`${code}\`` : '',
    name ? `- 职位：\`${name}\`` : '',
    `- MCP 别名：\`${alias}\``,
    '- seatKey：由本机 mcp-shim 从环境变量 `AGENT_ROOM_SEAT_KEY` 自动补全；调用时可传 `managed: {}` / 空字符串，**不要编造**，也不要用 shell 读环境变量',
  ].filter(Boolean);
  return [
    sharedRulesMarkdown().trimEnd(),
    '',
    '## 本座位',
    '',
    ...identity,
    `- 共用规则原件：\`${input.rulesPath}\`（正文已内联于上方；无需再打开该绝对路径）`,
    '',
    '收到「执行唤醒监听，动作游标=N」时，按上方规则执行唤醒监听与默认休眠动作。',
    '',
  ].join('\n');
}

async function writeSharedFile(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, body, { mode: 0o644 });
  try { await chmod(path, 0o644); } catch { /* Windows */ }
}

export async function ensureSharedRules(roomsDir: string): Promise<string> {
  const path = sharedRulesPath(roomsDir);
  let existing = '';
  try { existing = await readFile(path, 'utf8'); } catch { /* create */ }
  const next = sharedRulesMarkdown();
  // Desktop-owned template: rewrite when missing, content drifted, or pre-hold-loop wording.
  if (
    !existing
    || existing !== next
    || !existing.includes('追历史只用一次')
    || !existing.includes('mcp-shim')
    || !existing.includes('禁止编造 seatKey')
    || !existing.includes('不要读 `state.md`')
    || !existing.includes('禁止主动发「已上线」')
    || !existing.includes('启动后立刻 `room_listen`')
    || !existing.includes('禁止把唤醒句里的起始动作游标当作 room_sleep 的 cursor')
    || existing.includes('禁止 `managed: {}`')
    || existing.includes('座位状态文件')
  ) {
    await writeSharedFile(path, next);
  }
  return path;
}

/** Loopback HTTP mcp-shim URL for managed seats (Codex -c / Cursor project mcp.json). */
export function resolveMcpShimUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.AGENT_ROOM_MCP_SHIM_URL?.trim() || '';
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const port = (env.AGENT_ROOM_CONTROL_PORT || '17421').trim() || '17421';
  return `http://127.0.0.1:${port}/mcp-shim`;
}

/** True when URL is loopback only — never write a remote host into seat MCP config. */
export function isLoopbackMcpShimUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|\?|#|$)/i.test(url.trim());
}

/**
 * Seat-cwd Cursor CLI permissions. Tool allowlist only — not approvalMode
 * unrestricted / --yolo (those would allow shell commands too).
 * Current CLI schema requires permissions.deny to be a string array; omitting
 * it fails validation of the seat project file (`create-chat` exits 1).
 * The seat `.cursor/cli.json` lives in the managed temp seat directory and
 * uses `deny: []` so the schema check passes. This does not edit the user's
 * ~/.cursor/cli-config.json.
 */
export function cursorSeatCliConfig(alias = DEFAULT_MCP_ALIAS): string {
  return `${JSON.stringify({
    permissions: {
      allow: [`Mcp(${alias}:*)`],
      deny: [],
    },
  }, null, 2)}\n`;
}

/**
 * Cursor project MCP config for a managed seat cwd.
 * Project `.cursor/mcp.json` overrides ~/.cursor/mcp.json, so HostLocal Cursor
 * hits the daemon mcp-shim (Bearer seatKey) instead of www.agent-room.com.
 */
export function cursorSeatMcpConfig(shimUrl: string, alias = DEFAULT_MCP_ALIAS): string {
  const url = shimUrl.trim().replace(/\/+$/, '');
  return `${JSON.stringify({
    mcpServers: {
      [alias]: {
        type: 'http',
        url,
        headers: {
          Authorization: 'Bearer ${env:AGENT_ROOM_SEAT_KEY}',
        },
      },
    },
  }, null, 2)}\n`;
}

/**
 * Antigravity (`agy`) has no per-cwd mcp.json; it honours workspace plugins
 * under `<cwd>/.agents/plugins/<name>/`. This seat-local plugin points the
 * Gemini seat at the loopback mcp-shim with its own seatKey (env-expanded by
 * agy), so two agy seats never share one identity.
 */
export const AGY_SEAT_PLUGIN = 'agent-room-seat';
export function agySeatMcpConfig(shimUrl: string, alias = DEFAULT_MCP_ALIAS): string {
  const url = shimUrl.trim().replace(/\/+$/, '');
  return `${JSON.stringify({
    mcpServers: {
      [alias]: {
        url,
        headers: { Authorization: 'Bearer ${AGENT_ROOM_SEAT_KEY}' },
      },
    },
  }, null, 2)}\n`;
}

export async function writeSeatFiles(input: {
  roomsDir: string;
  code: string;
  name: string;
  seatId: string;
  adapterId: string;
  seatKey: string;
  mcpAlias?: string;
  /** When set (Cursor HostLocal), write seatDir/.cursor/mcp.json → loopback mcp-shim. */
  mcpShimUrl?: string;
}): Promise<{ seatDir: string; rulesPath: string }> {
  const rulesPath = await ensureSharedRules(input.roomsDir);
  const seatDir = seatDirPath(input.roomsDir, input.code, input.adapterId, input.name, input.seatId);
  // Drop leftover state.md from older builds (seat fields live in AGENT_ROOM_* only).
  await rm(seatStatePath(seatDir), { force: true }).catch(() => undefined);
  const agents = seatAgentsMarkdown({
    rulesPath,
    code: input.code,
    name: input.name,
    mcpAlias: input.mcpAlias,
  });
  await writeSharedFile(join(seatDir, 'AGENTS.md'), agents);
  await writeSharedFile(join(seatDir, 'GEMINI.md'), agents);
  const alias = input.mcpAlias?.trim() || DEFAULT_MCP_ALIAS;
  const shim = (input.mcpShimUrl ?? '').trim();
  if (input.adapterId === 'cursor-agent') {
    await writeSharedFile(join(seatDir, '.cursor', 'cli.json'), cursorSeatCliConfig(alias));
    if (shim && isLoopbackMcpShimUrl(shim)) {
      await writeSharedFile(join(seatDir, '.cursor', 'mcp.json'), cursorSeatMcpConfig(shim, alias));
    }
  }
  if (input.adapterId === 'agy' && shim && isLoopbackMcpShimUrl(shim)) {
    const pluginDir = join(seatDir, '.agents', 'plugins', AGY_SEAT_PLUGIN);
    await writeSharedFile(join(pluginDir, 'plugin.json'), `${JSON.stringify({ name: AGY_SEAT_PLUGIN, version: '0.1.27' }, null, 2)}\n`);
    await writeSharedFile(join(pluginDir, 'mcp_config.json'), agySeatMcpConfig(shim, alias));
  }
  return { seatDir, rulesPath };
}

/** After 关闭确认：删座位 AGENTS/GEMINI（及残留 state.md），保留共用 rules.md。 */
export async function deleteSeatStateFiles(input: {
  roomsDir: string;
  code: string;
  name: string;
  seatId: string;
  adapterId: string;
  seatDir?: string;
}): Promise<void> {
  const seatDir = input.seatDir
    || seatDirPath(input.roomsDir, input.code, input.adapterId, input.name, input.seatId);
  await rm(seatStatePath(seatDir), { force: true }).catch(() => undefined);
  await rm(join(seatDir, 'AGENTS.md'), { force: true }).catch(() => undefined);
  await rm(join(seatDir, 'GEMINI.md'), { force: true }).catch(() => undefined);
  await rm(join(seatDir, '.cursor'), { recursive: true, force: true }).catch(() => undefined);
  await rm(join(seatDir, '.agents'), { recursive: true, force: true }).catch(() => undefined);
  // Best-effort: remove empty seat folder; keep room folder + shared rules.
  await rm(seatDir, { recursive: false, force: true }).catch(() => undefined);
}
