// Request-body reading and multipart/form-data parsing for /api/upload.
// Split out of api/upload.ts so the route file keeps only the handler.
//
// Size limits live here because the body reader is what enforces them: one
// file cap, plus an allowance for the multipart envelope (part headers,
// boundaries, the roomCode/width/height fields) to derive the request cap.

import type { IncomingMessage } from 'node:http';
import { Buffer } from 'node:buffer';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MULTIPART_OVERHEAD_BYTES = 1 * 1024 * 1024;
export const MAX_REQUEST_BYTES = MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES;

// After an over-size response is flushed we still let the client finish its
// upload, but not forever: whichever of these trips first ends the socket.
export const DRAIN_TIMEOUT_MS = 3_000;
export const DRAIN_CEILING_BYTES = 64 * 1024 * 1024;

export type ReadBodyResult =
  | { ok: true; body: Buffer }
  | { ok: false; receivedBytes: number };

// `null` when the header is absent or unparseable — a missing or lying
// Content-Length is the streaming path's problem, not an error by itself.
export function declaredContentLength(req: IncomingMessage): number | null {
  const raw = req.headers['content-length'];
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// Buffer the request up to `maxBytes`. Going over resolves `{ ok: false }`
// instead of throwing, and leaves the socket intact so the caller can write
// a real 413 — tearing the request down here is what reaches the client as
// ECONNRESET. The stream is left flowing (and discarding) on that path.
export function readRequestBody(
  req: IncomingMessage,
  maxBytes: number = MAX_REQUEST_BYTES,
): Promise<ReadBodyResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const detach = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        detach();
        chunks.length = 0;
        req.resume();
        resolve({ ok: false, receivedBytes: total });
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => {
      detach();
      resolve({ ok: true, body: Buffer.concat(chunks) });
    };
    const onError = (error: Error) => {
      detach();
      reject(error);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export interface DrainableResponse {
  writableEnded?: boolean;
  once?(event: 'finish', listener: () => void): unknown;
}

export interface DrainOptions {
  receivedBytes?: number;
  timeoutMs?: number;
  ceilingBytes?: number;
}

// Discard whatever the client is still sending after we answered. The socket
// teardown is armed only once the response has left the building ('finish'),
// so the client always gets to read the status line; it then fires if the
// client keeps streaming past the drain timeout or the hard byte ceiling.
export function drainRequest(
  req: IncomingMessage,
  res: DrainableResponse,
  options: DrainOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? DRAIN_TIMEOUT_MS;
  const ceilingBytes = options.ceilingBytes ?? DRAIN_CEILING_BYTES;
  let drained = options.receivedBytes ?? 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  const stop = () => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    req.off('data', onData);
    req.off('end', stop);
    req.off('error', stop);
  };
  const destroyNow = () => {
    stop();
    req.destroy();
  };
  const onData = (chunk: Buffer | string) => {
    drained += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (drained > ceilingBytes) destroyNow();
  };
  const armTeardown = () => {
    if (finished) return;
    timer = setTimeout(destroyNow, timeoutMs);
    // Never hold the process open just to wait out a stalled client.
    (timer as { unref?: () => void }).unref?.();
  };

  req.on('data', onData);
  req.on('end', stop);
  req.on('error', stop);
  req.resume();

  if (res.writableEnded) armTeardown();
  else if (typeof res.once === 'function') res.once('finish', armTeardown);
  else armTeardown();
}

export interface ParsedPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export function parseMultipart(body: Buffer, boundary: string): ParsedPart[] {
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
