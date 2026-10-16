// Vercel Function: receives a multipart upload, validates size + mime,
// stores in Cloudflare R2 (S3-compatible) under
// `rooms/{code}/{uuid}/{filename}`, returns the MessageAttachment shape
// Codex's web composer can drop straight into a Message's `attachments`
// array.
//
// Storage backend: R2 instead of Vercel Blob, because the host's Vercel
// account hit a 2FA recovery wall that locks the Storage tab. R2 has
// no analogous gate and gives us zero egress as a bonus. R2 is S3-
// compatible, so we use @aws-sdk/client-s3 with a custom endpoint.
//
// Authorization: anyone with the room code can upload (matches the read
// model — anyone with the code can join). The roomCode prefix in the
// object key lets us batch-delete by room when the meeting ends.
//
// Body reading / multipart parsing lives in ./_uploadMultipart.js and the
// mime rules in ./_uploadMime.js; both are re-exported below so existing
// importers keep working.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  DRAIN_CEILING_BYTES,
  MAX_FILE_BYTES,
  MAX_REQUEST_BYTES,
  declaredContentLength,
  drainRequest,
  parseMultipart,
  readRequestBody,
} from './_uploadMultipart.js';
import { ALLOWED_MIMES, baseMime, storageContentType } from './_uploadMime.js';
import type { ParsedPart } from './_uploadMultipart.js';

export {
  DRAIN_CEILING_BYTES,
  DRAIN_TIMEOUT_MS,
  MAX_FILE_BYTES,
  MAX_REQUEST_BYTES,
  MULTIPART_OVERHEAD_BYTES,
  declaredContentLength,
  drainRequest,
  parseMultipart,
  readRequestBody,
} from './_uploadMultipart.js';
export type { ParsedPart } from './_uploadMultipart.js';
export { ALLOWED_MIMES, TEXTUAL_MIMES, baseMime, storageContentType } from './_uploadMime.js';

export const config = { api: { bodyParser: false } };

// The object key keeps the filename's raw UTF-8 bytes — that is what R2
// stores and what delete-room-blobs.ts lists by prefix — so only the URL we
// hand out is percent-encoded. Encoding runs per segment so the '/'
// separators survive, and the base prefix is left exactly as configured
// (it may already be a percent-encoded path). r2.dev decodes back to the
// stored key, so the encoded URL downloads the same object.
export function publicObjectUrl(base: string, key: string): string {
  const prefix = base.replace(/\/$/, '');
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${prefix}/${encoded}`;
}

// Filename as it goes into the object key. Path separators would split one
// name into extra key segments (escaping the rooms/{code}/{uuid}/ prefix we
// batch-delete by) and control characters have no business in a key at all;
// both become '_'. Chinese, spaces and the rest stay — the key is raw UTF-8
// and `name` on the attachment keeps the original filename regardless.
export function keyFilename(filename: string | undefined): string {
  const name = (filename ?? 'file').replace(/[/\\\u0000-\u001f\u007f]/g, '_').slice(0, 200);
  return name || 'file';
}

// One body for every over-size path — a declared Content-Length over the
// read cap, a stream that runs past it, and a file that parses out too big
// all read identically on the client.
const TOO_LARGE_BODY = {
  error: 'file_too_large',
  message: `File exceeds ${MAX_FILE_BYTES} bytes (10 MB).`,
  maxBytes: MAX_FILE_BYTES,
};

// Deliberately keep-alive. `Connection: close` makes node's http server
// destroySoon() the socket the moment this response flushes, and the client
// is still writing its upload: the RST reaches it as EPIPE before it reads
// the 413. Staying keep-alive lets drainRequest swallow the rest of the body
// (so it is never mistaken for a pipelined request) while the client reads
// the answer. `close` is only for bodies we will not drain to the end.
function sendTooLarge(res: VercelResponse, closeConnection = false): void {
  if (closeConnection) res.setHeader('Connection', 'close');
  res.status(413).json(TOO_LARGE_BODY);
}

interface R2Env {
  accountId: string;
  bucket: string;
  publicUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
}

// Read every R2 var up front so we can return one clean 503 listing what's
// missing instead of crashing inside the SDK with a cryptic message.
function readR2Env(): R2Env | { missing: string[] } {
  const env = {
    accountId: process.env.R2_ACCOUNT_ID,
    bucket: process.env.R2_BUCKET,
    publicUrl: process.env.R2_PUBLIC_URL,
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
    res.status(503).json({
      error: 'r2_not_configured',
      message: `R2 credentials not set. Vercel project Settings → Environment Variables: missing ${env.missing.join(', ')}.`,
    });
    return;
  }

  // Answer before touching the body when the client already told us it is
  // too big, then discard the bytes it is still pushing.
  const declared = declaredContentLength(req);
  if (declared !== null && declared > MAX_REQUEST_BYTES) {
    // Over the drain ceiling we are never going to read this body out, so
    // there is nothing to keep the connection alive for.
    sendTooLarge(res, declared > DRAIN_CEILING_BYTES);
    drainRequest(req, res);
    return;
  }

  const contentType = String(req.headers['content-type'] ?? '');
  const boundaryMatch = /boundary=("?)([^";]+)\1/.exec(contentType);
  if (!boundaryMatch) {
    res.status(400).json({ error: 'invalid_multipart', message: 'Body must be multipart/form-data with a boundary.' });
    return;
  }
  const boundary = boundaryMatch[2]!;

  const read = await readRequestBody(req, MAX_REQUEST_BYTES);
  if (!read.ok) {
    // No (or a lying) Content-Length: we only learn the size by reading.
    // The reader stopped buffering and left the socket alive for this 413.
    sendTooLarge(res);
    drainRequest(req, res, { receivedBytes: read.receivedBytes });
    return;
  }
  const body: Buffer = read.body;

  let parts: ParsedPart[];
  try {
    parts = parseMultipart(body, boundary);
  } catch (e) {
    res.status(400).json({ error: 'invalid_multipart', message: e instanceof Error ? e.message : 'parse failed' });
    return;
  }

  const filePart = parts.find(p => p.name === 'file' && p.filename !== undefined);
  const roomCodePart = parts.find(p => p.name === 'roomCode');
  const widthPart = parts.find(p => p.name === 'width');
  const heightPart = parts.find(p => p.name === 'height');

  if (!filePart) {
    res.status(400).json({ error: 'missing_file', message: 'No file field in form data.' });
    return;
  }
  const roomCode = roomCodePart ? roomCodePart.data.toString('utf8') : '';
  if (!/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(roomCode)) {
    res.status(400).json({ error: 'bad_room_code', message: 'Missing or malformed roomCode.' });
    return;
  }

  if (filePart.data.length === 0) {
    res.status(400).json({ error: 'empty_file', message: 'File is empty.' });
    return;
  }
  if (filePart.data.length > MAX_FILE_BYTES) {
    res.status(413).json(TOO_LARGE_BODY);
    return;
  }
  const mime = baseMime(filePart.contentType ?? 'application/octet-stream');
  if (!ALLOWED_MIMES.has(mime)) {
    res.status(415).json({ error: 'mime_not_allowed', message: `Unsupported MIME type: ${mime}` });
    return;
  }

  const id = randomUUID();
  const key = `rooms/${roomCode}/${id}/${keyFilename(filePart.filename)}`;

  try {
    await getR2Client(env).send(new PutObjectCommand({
      Bucket: env.bucket,
      Key: key,
      Body: filePart.data,
      ContentType: storageContentType(mime),
      // Cache aggressively: object keys are content-addressable
      // (uuid in path) so an attachment's bytes never change.
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    res.status(500).json({ error: 'r2_put_failed', message: `R2 upload failed: ${msg}` });
    return;
  }

  // Public URL via the R2.dev subdomain (or custom domain if you swap it
  // later — we just env-var the prefix so the swap is one variable change).
  const url = publicObjectUrl(env.publicUrl, key);

  const isImage = mime.startsWith('image/');
  const widthNum = widthPart ? Number(widthPart.data.toString('utf8')) : NaN;
  const heightNum = heightPart ? Number(heightPart.data.toString('utf8')) : NaN;

  const attachment = {
    id,
    type: isImage ? 'image' : 'file',
    url,
    storageKey: key,
    name: filePart.filename ?? 'file',
    size: filePart.data.length,
    mime,
    uploadedAt: Date.now(),
    ...(isImage && Number.isFinite(widthNum) && widthNum > 0 ? { width: widthNum } : {}),
    ...(isImage && Number.isFinite(heightNum) && heightNum > 0 ? { height: heightNum } : {}),
  };

  res.status(201).json(attachment);
}
