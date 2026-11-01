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
    '本文件由桌面端维护，所有托管座位共用一份。职位、seatKey、房间码、MCP 别名等常变项在各座位目录的 `state.md`。',
    '',
    '## 术语',
    '',
    '- **动作游标**：即 `room_listen` 的 `since`（处理完后也用返回的 `cursor` 作为下一轮动作游标）。唤醒短指令里的「动作游标=N」就是 N。',
    '- **座位状态文件**：本座位目录下的 `state.md`。调用房间工具时从中读取 seatKey 等字段；不要把 seatKey 写进聊天回复，也不要用 shell/cat/printenv 打印它。',
    '- **环境变量兜底**：`AGENT_ROOM_CODE` / `AGENT_ROOM_NAME` / `AGENT_ROOM_SEAT_KEY`（以及可选的 `AGENT_ROOM_CURSOR`）与 state.md 同义。文件工具不可用时直接用这些值调用 MCP，不要 printenv 打到屏幕。',
    '',
    '## 唤醒监听',
    '',
    '当收到「执行唤醒监听，动作游标=N」（或首次启动的等价指令）时：',
    '',
    '1. 取得房间码、职位（name）、seatKey、MCP 别名：优先读本座位 `state.md`；若不宜再用文件工具，直接使用环境变量 `AGENT_ROOM_CODE` / `AGENT_ROOM_NAME` / `AGENT_ROOM_SEAT_KEY`（MCP 别名默认 `agent-room`）。',
    '2. 调用 `room_listen({ code, name, since: N, timeoutMs: 0, managed: { seatKey } })`。',
    '3. 读取未处理消息，完成交给你的工作并在房间回复。',
    '4. 处理完后继续 `room_listen`（`since` 用上一步返回的 cursor）；有新的 @ 就继续处理。',
    '',
    '## 默认动作（休眠）',
    '',
    '一轮内没有新的 @：调用 `room_sleep({ code, name, cursor: <最新动作游标>, seatKey })` 后结束本轮，等待下次唤醒。',
    '',
    '## 禁止',
    '',
    '- 不要修改任何配置文件、权限文件或 MCP 设置（包括 ~/.cursor、~/.codex、cli-config 等）。',
    '- 本座位已由本机托管进房：禁止 `room_join`，不要向用户索要邀请码。',
    '- MCP 工具已预先批准，直接调用即可，不要等用户在终端里逐个点批准。',
    '- 不要用文件读取工具去打开安装盘上的绝对路径（例如 `D:\\Agent Room\\...`）；本工作目录的 `AGENTS.md` / `state.md` 或环境变量已足够。',
    '',
  ].join('\n');
}

export function seatStateMarkdown(input: {
  name: string;
  code: string;
  seatKey: string;
  adapterId: string;
  mcpAlias?: string;
  rulesPath: string;
}): string {
  const alias = input.mcpAlias?.trim() || DEFAULT_MCP_ALIAS;
  return [
    '# 座位状态（本机托管）',
    '',
    '关闭本托管终端并确认后，桌面端会删除本文件，避免串座。通用规则文件保留。',
    '',
    `- 职位: ${input.name}`,
    `- 房间码: ${input.code}`,
    `- seatKey: ${input.seatKey}`,
    `- MCP 别名: ${alias}`,
    `- 适配器: ${input.adapterId}`,
    `- 通用规则路径: ${input.rulesPath}`,
    '',
    '调用房间 MCP 时直接使用以上字段；不要把 seatKey 写进回复。',
    '',
  ].join('\n');
}

/**
 * Project doc for CLIs that auto-load AGENTS.md / GEMINI.md from the seat cwd.
 * Inline the shared wake rules so Codex need not open absolute install-disk paths
 * via the sandboxed file-read tool (which can hang under Windows elevated sandbox).
 */
export function seatAgentsMarkdown(input: { rulesPath: string; statePath: string }): string {
  return [
    sharedRulesMarkdown().trimEnd(),
    '',
    '## 本座位文件',
    '',
    '- 座位状态：同目录 `state.md`（职位 / 房间码 / seatKey / MCP 别名）',
    `- 共用规则原件：\`${input.rulesPath}\`（正文已内联于上方；无需再打开该绝对路径）`,
    `- 本文件对应座位状态路径：\`${input.statePath}\``,
    '',
    '收到「执行唤醒监听，动作游标=N」时，按上方规则执行唤醒监听与默认休眠动作。',
    '',
  ].join('\n');
}

async function writePrivateFile(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, body, { mode: 0o600 });
  try { await chmod(path, 0o600); } catch { /* Windows */ }
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
  // Refresh when missing or clearly stale (no 动作游标 / env fallback yet).
  if (
    !existing
    || !existing.includes('动作游标')
    || !existing.includes('唤醒监听')
    || !existing.includes('AGENT_ROOM_SEAT_KEY')
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
}): Promise<{ seatDir: string; rulesPath: string; statePath: string }> {
  const rulesPath = await ensureSharedRules(input.roomsDir);
  const seatDir = seatDirPath(input.roomsDir, input.code, input.adapterId, input.name, input.seatId);
  const statePath = seatStatePath(seatDir);
  await writePrivateFile(statePath, seatStateMarkdown({
    name: input.name,
    code: input.code,
    seatKey: input.seatKey,
    adapterId: input.adapterId,
    mcpAlias: input.mcpAlias,
    rulesPath,
  }));
  const agents = seatAgentsMarkdown({ rulesPath, statePath });
  await writeSharedFile(join(seatDir, 'AGENTS.md'), agents);
  await writeSharedFile(join(seatDir, 'GEMINI.md'), agents);
  return { seatDir, rulesPath, statePath };
}

/** After 关闭确认：删座位 state.md（及同目录说明），保留共用 rules.md。 */
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
