export interface AccountUser {
  id: string;
  username: string;
  email: string | null;
  role: 'admin' | 'user';
  disabled: boolean;
  createdAt: number;
}

export interface AccountDevice {
  deviceId: string;
  name: string;
  platform: string;
  hostname: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export interface AccountSession {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** Short device label, e.g. 'Chrome · Windows' or '脚本/API'. */
  label: string;
  ip: string;
  current: boolean;
}

export class AccountApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AccountApiError';
  }
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new AccountApiError(payload.message || 'Request failed.', response.status);
  return payload as T;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'include', cache: 'no-store' });
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new AccountApiError(payload.message || 'Request failed.', response.status);
  return payload as T;
}

export const accountApi = {
  login: (username: string, password: string) =>
    post<{ user: AccountUser }>('/api/account/login', { username, password }),
  logout: () => post<{ ok: boolean }>('/api/account/logout'),
  me: () => get<{ user: AccountUser }>('/api/account/me'),
  sessions: () => get<{ sessions: AccountSession[] }>('/api/account/sessions'),
  revokeSession: (sessionId: string) => post('/api/account/sessions/revoke', { sessionId }),
  revokeOthers: () => post('/api/account/sessions/revoke-others'),
  changePassword: (currentPassword: string, newPassword: string) =>
    post('/api/account/password', { currentPassword, newPassword }),
  listDevices: (userId?: string) => get<{ devices: AccountDevice[] }>(
    userId ? `/api/account/devices?userId=${encodeURIComponent(userId)}` : '/api/account/devices',
  ),
  revokeDevice: (deviceId: string) => post<{ ok: boolean }>('/api/account/devices/revoke', { deviceId }),
  pairStart: () => post<{ pairingCode: string; expiresAt: number }>('/api/device/pair-start'),
  users: () => get<{ users: AccountUser[] }>('/api/admin/users'),
  addUser: (username: string, password: string, role: 'admin' | 'user') =>
    post<{ user: AccountUser }>('/api/admin/users', { username, password, role }),
  disableUser: (userId: string) => post('/api/admin/users/disable', { userId }),
  enableUser: (userId: string) => post('/api/admin/users/enable', { userId }),
  resetPassword: (userId: string, password: string) =>
    post('/api/admin/users/reset-password', { userId, password }),
  revokeUserSessions: (userId: string) => post('/api/admin/users/revoke-sessions', { userId }),
};
