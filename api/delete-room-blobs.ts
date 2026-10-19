// Vercel Function: bulk-delete every R2 object under a given room's prefix.
// Called from Room.tsx handleEndMeeting() so attachments don't outlive
// the meeting, per Robin's "结束会议时清掉附件". Idempotent.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

interface R2Env {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function readR2Env(): R2Env | { missing: string[] } {
  const env = {
    accountId: process.env.R2_ACCOUNT_ID,
    bucket: process.env.R2_BUCKET,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  };
  const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { missing };
  return env as R2Env;
}

let cachedClient: S3Client | null = null;
function getR2Client(env: R2Env): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({
    region: 'auto',
    endpoint: `https://${env.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    },
  });
  return cachedClient;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: 'Use POST.' });
    return;
  }

  const env = readR2Env();
  if ('missing' in env) {
    // Best-effort cleanup — no R2 = nothing to clean up. Don't block endRoom.
    res.status(200).json({ ok: true, deleted: 0, note: 'r2_not_configured' });
    return;
  }

  const body = (req.body ?? {}) as { roomCode?: unknown };
  const roomCode = body.roomCode;
  if (typeof roomCode !== 'string' || !/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(roomCode)) {
    res.status(400).json({ error: 'bad_room_code', message: 'Missing or malformed roomCode.' });
    return;
  }

  const client = getR2Client(env);
  let continuationToken: string | undefined;
  let deleted = 0;
  // Page through. R2 caps ListObjectsV2 at 1000 keys per page; under our
  // 10 MB / 5-per-msg / 1000-msg-cap a single room can hold up to 5000
  // objects, well within a few pages.
  const MAX_PAGES = 20;
  for (let page = 0; page < MAX_PAGES; page++) {
    const list = await client.send(new ListObjectsV2Command({
      Bucket: env.bucket,
      Prefix: `rooms/${roomCode}/`,
      ContinuationToken: continuationToken,
    }));
    const contents = list.Contents ?? [];
    if (contents.length === 0) break;
    await client.send(new DeleteObjectsCommand({
      Bucket: env.bucket,
      Delete: {
        Objects: contents.map(o => ({ Key: o.Key! })),
        Quiet: true,
      },
    }));
    deleted += contents.length;
    if (!list.IsTruncated) break;
    continuationToken = list.NextContinuationToken;
  }

  res.status(200).json({ ok: true, deleted });
}
