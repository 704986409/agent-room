/** Loopback port the desktop daemon binds by default. No Tauri command is required. */
export const DESKTOP_CONTROL_PORT = 17421;

export const DESKTOP_CONTROL_ORIGIN = `http://127.0.0.1:${DESKTOP_CONTROL_PORT}`;

export type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

interface TauriInternals {
  invoke?: TauriInvoke;
  transformCallback?: (callback: (response: unknown) => void, once?: boolean) => number;
  unregisterCallback?: (id: number) => void;
}

interface TauriGlobal {
  core?: { invoke?: TauriInvoke };
}

interface DesktopWindow {
  __TAURI_INTERNALS__?: TauriInternals | unknown;
  __TAURI__?: TauriGlobal | unknown;
  __AGENT_ROOM_DESKTOP__?: unknown;
}

function invokeFrom(view: DesktopWindow): TauriInvoke | null {
  const internals = view.__TAURI_INTERNALS__;
  if (internals && typeof internals === 'object' && 'invoke' in internals) {
    const invoke = (internals as TauriInternals).invoke;
    if (typeof invoke === 'function') return invoke;
  }
  const tauri = view.__TAURI__;
  if (tauri && typeof tauri === 'object' && 'core' in (tauri as TauriGlobal)) {
    const invoke = (tauri as TauriGlobal).core?.invoke;
    if (typeof invoke === 'function') return invoke;
  }
  return null;
}

/** Tauri `invoke` inside the desktop webview. Null in a normal browser. */
export function desktopTauriInvoke(target?: DesktopWindow): TauriInvoke | null {
  const view = target ?? (typeof window === 'undefined' ? undefined : window as DesktopWindow);
  if (!view) return null;
  return invokeFrom(view);
}

/**
 * Ask the shell to open this seat's embedded terminal. The control token stays in Rust.
 * Returns a short failure detail, or null when the window was asked to open (or there is nothing to open).
 * A missing invoke or a command error does not throw — hosting already succeeded.
 */
export async function revealManagedTerminal(
  seatId: string | undefined,
  invoke?: TauriInvoke | null,
): Promise<string | null> {
  const id = seatId?.trim();
  if (!id) return null;
  const call = invoke === undefined ? desktopTauriInvoke() : invoke;
  if (!call) return null;
  try {
    await call('open_managed_terminal', { seatId: id });
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn('open_managed_terminal failed', detail);
    return detail;
  }
}

function eventPayload(response: unknown): unknown {
  if (response && typeof response === 'object' && 'payload' in response) {
    return (response as { payload: unknown }).payload;
  }
  return response;
}

/**
 * Listen for a shell event (used when a popped-out terminal window closes).
 * Returns an unlisten function, or null when the webview cannot listen.
 */
export async function listenDesktopEvent(
  event: string,
  handler: (payload: unknown) => void,
  target?: DesktopWindow,
): Promise<(() => void) | null> {
  const view = target ?? (typeof window === 'undefined' ? undefined : window as DesktopWindow);
  const internals = view?.__TAURI_INTERNALS__;
  if (!internals || typeof internals !== 'object') return null;
  const api = internals as TauriInternals;
  if (typeof api.invoke !== 'function' || typeof api.transformCallback !== 'function') return null;
  const handlerId = api.transformCallback(response => {
    handler(eventPayload(response));
  });
  try {
    await api.invoke('plugin:event|listen', {
      event,
      target: { kind: 'Any' },
      handler: handlerId,
    });
  } catch (error) {
    api.unregisterCallback?.(handlerId);
    console.warn('desktop event listen failed', error);
    return null;
  }
  return () => {
    void api.invoke?.('plugin:event|unlisten', { event, handler: handlerId });
    api.unregisterCallback?.(handlerId);
  };
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
