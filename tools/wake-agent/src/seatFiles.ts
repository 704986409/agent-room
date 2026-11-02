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
    '本文件由桌面端维护，所有托管座位共用一份。职位、seatKey、房间码、MCP 别名等座位字段只在进程环境变量 `AGENT_ROOM_*` 里；不要读、不要写 `state.md`。',
    '',
    '## 术语',
    '',
    '- **动作游标**：即 `room_listen` 的 `since`（处理完后也用返回的 `cursor` 作为下一轮动作游标）。唤醒短指令里的「动作游标=N」就是 N。',
    '- **座位字段（环境变量）**：`AGENT_ROOM_CODE`（房间码）、`AGENT_ROOM_NAME`（职位）、`AGENT_ROOM_SEAT_KEY`（seatKey）、`AGENT_ROOM_MCP_ALIAS`（MCP 别名，缺省 `agent-room`），以及可选的 `AGENT_ROOM_CURSOR` / `AGENT_ROOM_ADAPTER`。调用房间工具时直接使用这些值；不要 printenv/Get-Content/cat 打到屏幕，也不要把 seatKey 写进聊天回复。',
    '',
    '## 唤醒监听',
    '',
    '当收到「执行唤醒监听，动作游标=N」（或首次启动的等价指令）时：',
    '',
    '1. 取得房间码、职位（name）、seatKey、MCP 别名：只用环境变量 `AGENT_ROOM_CODE` / `AGENT_ROOM_NAME` / `AGENT_ROOM_SEAT_KEY` / `AGENT_ROOM_MCP_ALIAS`（别名缺省 `agent-room`）。**不要**读 `state.md`，也不要再打开本目录其它座位字段文件。',
    '2. **追历史只用一次**：调用 `room_listen({ code, name, since: N, timeoutMs: 0, managed: { seatKey } })`。这是非阻塞快读，只用于补齐未读；**禁止**反复用 `timeoutMs: 0`。',
    '3. 若有未处理消息或交给你的工作：处理完并在房间回复（`room_send`）。',
    '4. **随后必须用默认 hold**：再调用 `room_listen({ code, name, since: <上一步 cursor>, managed: { seatKey: "<AGENT_ROOM_SEAT_KEY 真值>" } })`——**不要**传 `timeoutMs: 0`（省略 timeoutMs，走默认长轮询约 30–40s）。**禁止** `managed: {}`；始终带非空 `managed.seatKey`。',
    '5. hold 返回后若有新的 @ / 工作：处理完再回到第 4 步（继续 hold，仍不要 `timeoutMs: 0`）。',
    '6. 若返回 Quiet / `listenStatus=sleep` / `nextAction.tool=room_sleep`：进入下方休眠；**禁止**再以 `timeoutMs: 0` 连打 `room_listen`。',
    '',
    '## 默认动作（休眠）',
    '',
    '只有在一次真实 hold（省略 `timeoutMs` 或 `timeoutMs`>0）出现 Quiet / `listenStatus=sleep` 之后：调用 `room_sleep({ code, name, cursor: <最新动作游标>, seatKey })`，然后结束本轮，等待下次唤醒。不要在追历史（`timeoutMs: 0`）之后立刻 sleep，也不要在 Quiet 后再 listen。',
    '',
    '## 禁止',
    '',
    '- 不要修改任何配置文件、权限文件或 MCP 设置（包括 ~/.cursor、~/.codex、cli-config 等）。',
    '- 本座位已由本机托管进房：禁止 `room_join`，不要向用户索要邀请码。',
    '- MCP 工具已预先批准，直接调用即可，不要等用户在终端里逐个点批准。',
    '- 不要用文件读取工具去打开安装盘上的绝对路径（例如 `D:\\Agent Room\\...`）；本工作目录的 `AGENTS.md` 与环境变量 `AGENT_ROOM_*` 已足够。不要读 `state.md`。',
    '- 禁止用 `timeoutMs: 0` 循环调用 `room_listen`（会一秒连跳多次）；追历史一次后必须 hold。',
    '- **禁止 `managed: {}`**：`managed.seatKey` 必须是 `AGENT_ROOM_SEAT_KEY` 里的真值。空对象会导致 Quiet 后永不 sleep。把 seatKey 填进 MCP 工具参数 ≠ 往房间帖密钥；不要省略、不要传空。',
    '',
  ].join('\n');
}

/**
 * Project doc for CLIs that auto-load AGENTS.md / GEMINI.md from the seat cwd.
 * Inline the shared wake rules so Codex need not open absolute install-disk paths
 * via the sandboxed file-read tool (which can hang under Windows elevated sandbox).
 */
export function seatAgentsMarkdown(input: { rulesPath: string }): string {
  return [
    sharedRulesMarkdown().trimEnd(),
    '',
    '## 本座位',
    '',
    '- 座位字段：只用环境变量 `AGENT_ROOM_CODE` / `AGENT_ROOM_NAME` / `AGENT_ROOM_SEAT_KEY` / `AGENT_ROOM_MCP_ALIAS`（不要读 `state.md`）',
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
    || !existing.includes('AGENT_ROOM_SEAT_KEY')
    || !existing.includes('禁止 `managed: {}`')
    || !existing.includes('不要读 `state.md`')
    || existing.includes('座位状态文件')
  ) {
    await writeSharedFile(path, next);
  }
  return path;
}

export async function writeSeatFiles(input: {
  roomsDir: string;
  code: string;
  name: string;
  seatId: string;
  adapterId: string;
  seatKey: string;
  mcpAlias?: string;
}): Promise<{ seatDir: string; rulesPath: string }> {
  const rulesPath = await ensureSharedRules(input.roomsDir);
  const seatDir = seatDirPath(input.roomsDir, input.code, input.adapterId, input.name, input.seatId);
  // Drop leftover state.md from older builds (seat fields live in AGENT_ROOM_* only).
  await rm(seatStatePath(seatDir), { force: true }).catch(() => undefined);
  const agents = seatAgentsMarkdown({ rulesPath });
  await writeSharedFile(join(seatDir, 'AGENTS.md'), agents);
  await writeSharedFile(join(seatDir, 'GEMINI.md'), agents);
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
  // Best-effort: remove empty seat folder; keep room folder + shared rules.
  await rm(seatDir, { recursive: false, force: true }).catch(() => undefined);
}
