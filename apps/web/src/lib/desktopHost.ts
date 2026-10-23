/** Loopback port the desktop daemon binds by default. No Tauri command is required. */
export const DESKTOP_CONTROL_PORT = 17421;

export const DESKTOP_CONTROL_ORIGIN = `http://127.0.0.1:${DESKTOP_CONTROL_PORT}`;

interface DesktopWindow {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: unknown;
  __AGENT_ROOM_DESKTOP__?: unknown;
}

/** True inside the Agent Room desktop webview. A normal browser has none of these. */
export function isDesktopShell(target?: DesktopWindow): boolean {
  const view = target ?? (typeof window === 'undefined' ? undefined : window as DesktopWindow);
  if (!view) return false;
  return Boolean(view.__TAURI_INTERNALS__ || view.__TAURI__ || view.__AGENT_ROOM_DESKTOP__);
}

export interface DesktopHostInput {
  code: string;
  inviteCode: string;
  name: string;
}

export interface DesktopHostResult {
  ok: true;
  seat: { seatId?: string; name?: string; code?: string };
}

/** Ask the local daemon to join this room as a managed seat. The invite is the authorization. */
export async function hostOnThisMachine(
  input: DesktopHostInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopHostResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${DESKTOP_CONTROL_ORIGIN}/api/desktop/host`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-room-desktop': '1',
      },
      body: JSON.stringify(input),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'network';
    throw new Error(`本机后台没有响应（${detail}）。请确认桌面端已打开。`);
  }
  const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; hint?: string; seat?: DesktopHostResult['seat'] };
  if (!response.ok || !body.ok) {
    throw new Error(body.hint || body.error || `本机托管失败（HTTP ${response.status}）`);
  }
  return { ok: true, seat: body.seat ?? {} };
}
