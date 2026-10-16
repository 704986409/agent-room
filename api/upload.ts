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

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
  'application/json',
  'application/zip',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export const config = { api: { bodyParser: false } };

// Types that are byte-for-byte text but whose MIME name doesn't start with
// `text/`. Anything with a `+json`/`+xml` suffix counts too.
const TEXTUAL_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'image/svg+xml',
]);

// Drop the parameters a client may append ('text/plain; charset=utf-8') so
// the allow-list is matched on the base type alone.
function baseMime(raw: string): string {
  return raw.split(';')[0]!.trim().toLowerCase();
}

// R2 serves objects with the stored ContentType verbatim, and a `text/*`
// response without a charset makes browsers fall back to a locale default —
// UTF-8 Chinese then renders as mojibake straight from the r2.dev URL.
export function storageContentType(mime: string): string {
  if (/;\s*charset\s*=/i.test(mime)) return mime;
  const base = baseMime(mime);
  const textual = base.startsWith('text/') || TEXTUAL_MIMES.has(base) || /\+(json|xml)$/.test(base);
  return textual ? `${mime}; charset=utf-8` : mime;
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

  const contentType = String(req.headers['content-type'] ?? '');
  const boundaryMatch = /boundary=("?)([^";]+)\1/.exec(contentType);
  if (!boundaryMatch) {
    res.status(400).json({ error: 'invalid_multipart', message: 'Body must be multipart/form-data with a boundary.' });
    return;
  }
  const boundary = boundaryMatch[2]!;

  let body: Buffer;
  try {
    body = await readRequestBody(req, MAX_BYTES + 1 * 1024 * 1024);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'read failed';
    res.status(413).json({ error: 'body_too_large', message: msg });
    return;
  }

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
  if (filePart.data.length > MAX_BYTES) {
    res.status(413).json({ error: 'file_too_large', message: `File exceeds ${MAX_BYTES} bytes (10 MB).` });
    return;
  }
  const mime = baseMime(filePart.contentType ?? 'application/octet-stream');
  if (!ALLOWED_MIMES.has(mime)) {
    res.status(415).json({ error: 'mime_not_allowed', message: `Unsupported MIME type: ${mime}` });
    return;
  }

  const id = randomUUID();
  const safeName = (filePart.filename ?? 'file').replace(/[/\\]/g, '_').slice(0, 200) || 'file';
  const key = `rooms/${roomCode}/${id}/${safeName}`;

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
  const publicUrl = `${env.publicUrl.replace(/\/$/, '')}/${key}`;

  const isImage = mime.startsWith('image/');
  const widthNum = widthPart ? Number(widthPart.data.toString('utf8')) : NaN;
  const heightNum = heightPart ? Number(heightPart.data.toString('utf8')) : NaN;

  const attachment = {
    id,
    type: isImage ? 'image' : 'file',
    url: publicUrl,
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

// --- Multipart helpers ---

function readRequestBody(req: VercelRequest, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        reject(new Error(`Request body too large (${total} bytes > ${maxBytes}).`));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface ParsedPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

function parseMultipart(body: Buffer, boundary: string): ParsedPart[] {
  const dashBoundary = Buffer.from(`--${boundary}`);
  const parts: ParsedPart[] = [];

  let i = body.indexOf(dashBoundary);
  if (i < 0) throw new Error('Boundary not found in body.');
  i += dashBoundary.length;
  if (body[i] === 0x0d && body[i + 1] === 0x0a) i += 2;

  while (i < body.length) {
    const next = body.indexOf(dashBoundary, i);
    if (next < 0) throw new Error('Truncated multipart body.');

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), i);
    if (headerEnd < 0 || headerEnd > next) throw new Error('Malformed part headers.');
    const headersRaw = body.slice(i, headerEnd).toString('utf8');
    let dataEnd = next - 2;
    if (dataEnd < headerEnd + 4) dataEnd = headerEnd + 4;
    const data = body.slice(headerEnd + 4, dataEnd);

    const part: ParsedPart = { name: '', data };
    for (const line of headersRaw.split('\r\n')) {
      const lower = line.toLowerCase();
      if (lower.startsWith('content-disposition:')) {
        const nameMatch = /name="([^"]*)"/.exec(line);
        const fileMatch = /filename="([^"]*)"/.exec(line);
        if (nameMatch) part.name = nameMatch[1]!;
        if (fileMatch) part.filename = fileMatch[1]!;
      } else if (lower.startsWith('content-type:')) {
        part.contentType = line.slice(line.indexOf(':') + 1).trim();
      }
    }
    parts.push(part);

    i = next + dashBoundary.length;
    if (body[i] === 0x2d && body[i + 1] === 0x2d) break;
    if (body[i] === 0x0d && body[i + 1] === 0x0a) i += 2;
  }

  return parts;
}
