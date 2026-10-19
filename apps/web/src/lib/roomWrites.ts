// Browser writes go to the server. The Redis proxy credential cannot write.

export class RoomWriteError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = code || 'RoomWriteError';
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
  if (!response.ok) {
    throw new RoomWriteError(payload.message || 'Request failed.', response.status, payload.error || 'request_failed');
  }
  return payload as T;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'include' });
  const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
  if (!response.ok) {
    throw new RoomWriteError(payload.message || 'Request failed.', response.status, payload.error || 'request_failed');
  }
  return payload as T;
}

export interface TaskWriteBody {
  op: 'create' | 'verify' | 'reopen' | 'block' | 'cancel' | 'reassign';
  code: string;
  id?: string;
  title?: string;
  dod?: string;
  owner?: string;
  ownerClient?: 'web' | 'cc';
  verifier?: string;
  verifierClient?: 'web' | 'cc';
  verdict?: 'done' | 'rejected';
  note?: string;
  reason?: string;
  followUp?: { target: string; request: string; targetClient?: 'web' | 'cc' };
  patch?: { owner?: string; ownerClient?: 'web' | 'cc'; verifier?: string; verifierClient?: 'web' | 'cc' };
}

export const roomApi = {
  createRoom(body: { topic: string; displayName: string; role?: string; code?: string }) {
    return post<{ code: string; topic: string; name: string; role: string; hostKey: string }>('/api/web/room-create', body);
  },
  join(body: { code: string; role?: string }) {
    return post<{ code: string; name: string; role: string }>('/api/web/join', body);
  },
  whoami(code: string) {
    return get<{ code: string; name: string; role: 'owner' | 'member' | 'guest'; userId: string | null }>(`/api/web/whoami?code=${encodeURIComponent(code)}`);
  },
  sendChat(body: { code: string; text: string; id?: number; role?: string; attachments?: unknown[] }) {
    return post<{ message: { id: number } }>('/api/web/chat-send', body);
  },
  presence(code: string) {
    return post<{ ok: true }>('/api/web/presence', { code });
  },
  typing(body: { code: string; active: boolean }) {
    return post<{ ok: true }>('/api/web/typing', body);
  },
  task(body: TaskWriteBody) {
    return post<unknown>('/api/web/task', body);
  },
  host(body: Record<string, unknown>) {
    return post<Record<string, unknown>>('/api/web/host', body);
  },
  deliver(body: { code: string; op: 'start' | 'sweep' }) {
    return post<unknown>('/api/web/deliver', body);
  },
  createInvite(body: { code: string; expiresInMs?: number; maxUses?: number }) {
    return post<{ token: string; inviteId: string; expiresAt: number | null; maxUses: number | null }>('/api/web/invite', body);
  },
  revokeInvite(body: { code: string; inviteId: string; revokeGuests?: boolean }) {
    return post<{ ok: true }>('/api/web/invite-revoke', body);
  },
  acceptInvite(body: { token: string; displayName?: string }) {
    return post<{ code: string; name: string; role: 'owner' | 'member' | 'guest' }>('/api/web/invite-accept', body);
  },
};

export function submitTask(body: TaskWriteBody): Promise<unknown> {
  return roomApi.task(body);
}
