import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserById } from './_accounts.js';
import { completePairing, readDevice, revokeOwnedDevice, startPairing } from './_devices.js';
import { jsonBody, requireUser, sendAccountError, sendJson } from './_httpAuth.js';
import { serverRedis } from './_redisEnv.js';
import { RedisDeviceAuthenticator } from './_wakeDevice.js';

function authorizationHeader(req: VercelRequest): string | undefined {
  const value = req.headers.authorization;
  return Array.isArray(value) ? value[0] : value;
}

export async function pairStartHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const auth = await requireUser(req);
    sendJson(res, 201, await startPairing(auth.redis, auth.user.id));
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function pairCompleteHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const body = jsonBody(req);
    const issued = await completePairing(serverRedis(), {
      pairingCode: body.pairingCode,
      deviceName: body.deviceName,
      platform: body.platform,
      hostname: body.hostname,
    });
    sendJson(res, 201, issued);
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function revokeDeviceHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const auth = await requireUser(req);
    const deviceId = jsonBody(req).deviceId;
    await revokeOwnedDevice(auth.redis, typeof deviceId === 'string' ? deviceId.trim() : '', { id: auth.user.id, role: auth.user.role });
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendAccountError(res, error);
  }
}

export async function deviceSelfHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const redis = serverRedis();
    const principal = await new RedisDeviceAuthenticator(redis).authenticate(authorizationHeader(req));
    if (!principal) {
      sendJson(res, 401, { error: 'unauthorized', message: 'Device credential required.' });
      return;
    }
    const device = await readDevice(redis, principal.deviceId);
    const user = device ? await getUserById(redis, device.userId) : null;
    if (!device || !user) {
      sendJson(res, 401, { error: 'unauthorized', message: 'Device credential required.' });
      return;
    }
    sendJson(res, 200, {
      deviceId: device.deviceId,
      name: device.name,
      platform: device.platform,
      userId: user.id,
      username: user.username,
    });
  } catch (error) {
    sendAccountError(res, error);
  }
}
