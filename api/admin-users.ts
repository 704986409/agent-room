import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createUser,
  listSessions,
  listUsers,
  publicUser,
  resetUserPassword,
  revokeAllSessions,
  setUserDisabled,
  writeAudit,
  type UserRole,
} from './_accounts.js';
import { jsonBody, requireAdmin, sendAccountError, sendJson } from './_httpAuth.js';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function adminUsersHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const auth = await requireAdmin(req);
    if (req.method === 'GET') {
      const users = await listUsers(auth.redis);
      sendJson(res, 200, { users: users.map(publicUser) });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    const body = jsonBody(req);
    const role: UserRole = body.role === 'admin' ? 'admin' : 'user';
    const user = await createUser(auth.redis, {
      username: str(body.username),
      password: str(body.password),
      role,
      ...(str(body.email) ? { email: str(body.email) } : {}),
    });
    await writeAudit(auth.redis, { actorId: auth.user.id, action: 'admin.add_user', targetUserId: user.id });
    sendJson(res, 201, { user: publicUser(user) });
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function adminDisableHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const auth = await requireAdmin(req);
    const userId = str(jsonBody(req).userId);
    const user = await setUserDisabled(auth.redis, userId, true);
    await writeAudit(auth.redis, { actorId: auth.user.id, action: 'admin.disable_user', targetUserId: user.id });
    sendJson(res, 200, { user: publicUser(user) });
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function adminEnableHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const auth = await requireAdmin(req);
    const user = await setUserDisabled(auth.redis, str(jsonBody(req).userId), false);
    await writeAudit(auth.redis, { actorId: auth.user.id, action: 'admin.enable_user', targetUserId: user.id });
    sendJson(res, 200, { user: publicUser(user) });
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function adminResetPasswordHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const auth = await requireAdmin(req);
    const body = jsonBody(req);
    const user = await resetUserPassword(auth.redis, str(body.userId), str(body.password));
    await writeAudit(auth.redis, { actorId: auth.user.id, action: 'admin.reset_password', targetUserId: user.id });
    sendJson(res, 200, { user: publicUser(user) });
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function adminSessionsHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const auth = await requireAdmin(req);
    const userId = str(req.query.userId);
    const sessions = await listSessions(auth.redis, userId);
    sendJson(res, 200, { sessions });
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function adminRevokeSessionsHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const auth = await requireAdmin(req);
    const userId = str(jsonBody(req).userId);
    const revoked = await revokeAllSessions(auth.redis, userId);
    await writeAudit(auth.redis, { actorId: auth.user.id, action: 'admin.revoke_sessions', targetUserId: userId });
    sendJson(res, 200, { ok: true, revoked });
  } catch (error) {
    sendAccountError(res, error);
  }
}
