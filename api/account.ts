import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  changePassword,
  listSessions,
  listUserDevices,
  login,
  revokeAllSessions,
  revokeSession,
} from './_accounts.js';
import {
  clearSessionCookie,
  clientIp,
  clientUa,
  jsonBody,
  requireUser,
  sendAccountError,
  sendJson,
  sessionCookie,
  userPayload,
} from './_httpAuth.js';
import { serverRedis } from './_redisEnv.js';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function loginHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const body = jsonBody(req);
    const redis = serverRedis();
    const result = await login(redis, {
      username: str(body.username),
      password: str(body.password),
      ip: clientIp(req),
      ua: clientUa(req),
    });
    res.setHeader('Set-Cookie', sessionCookie(result.token));
    sendJson(res, 200, { user: result.user });
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function logoutHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const redis = serverRedis();
    const auth = await requireUser(req, redis).catch(() => null);
    if (auth) await revokeSession(redis, auth.hash);
    res.setHeader('Set-Cookie', clearSessionCookie());
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function meHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const auth = await requireUser(req);
    sendJson(res, 200, userPayload(auth.user));
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function sessionsHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const auth = await requireUser(req);
    const sessions = await listSessions(auth.redis, auth.user.id, auth.hash);
    sendJson(res, 200, { sessions });
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function revokeSessionHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const auth = await requireUser(req);
    const sessionId = str(jsonBody(req).sessionId);
    const known = (await listSessions(auth.redis, auth.user.id)).some(session => session.id === sessionId);
    if (!known) {
      sendJson(res, 404, { error: 'not_found', message: 'Session not found.' });
      return;
    }
    await revokeSession(auth.redis, sessionId);
    if (sessionId === auth.hash) res.setHeader('Set-Cookie', clearSessionCookie());
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function revokeOtherSessionsHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const auth = await requireUser(req);
    const revoked = await revokeAllSessions(auth.redis, auth.user.id, auth.hash);
    sendJson(res, 200, { ok: true, revoked });
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function passwordHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const auth = await requireUser(req);
    const body = jsonBody(req);
    await changePassword(auth.redis, auth.user, str(body.currentPassword), str(body.newPassword), auth.hash);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function devicesHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    await requireUser(req);
    sendJson(res, 200, {
      devices: await listUserDevices(),
      available: false,
      message: 'Device list is not available yet.',
    });
  } catch (error) {
    sendAccountError(res, error);
  }
}
