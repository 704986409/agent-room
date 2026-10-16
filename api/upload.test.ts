import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => ({})),
  putInputs: [] as Record<string, unknown>[],
}));

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = mocks.send;
  }
  class PutObjectCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
      mocks.putInputs.push(input);
    }
  }
  return { S3Client, PutObjectCommand };
});

import { MAX_FILENAME_BYTES } from '@agent-room/shared';
import handler, {
  DRAIN_CEILING_BYTES,
  MAX_FILE_BYTES,
  MAX_REQUEST_BYTES,
  keyFilename,
  publicObjectUrl,
  storageContentType,
} from './upload.js';

// deploy/vps/server.ts already exports createVpsApp (used by
// api/vps-routes.test.ts), so the real request pipeline is testable as-is.
// Imported dynamically so its module-level env reads see these defaults.
process.env.UPSTASH_REDIS_REST_URL ??= 'https://upload.upstash.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'upload-token';
const { createVpsApp } = await import('../deploy/vps/server.js');
type VpsApp = ReturnType<typeof createVpsApp>;

describe('storageContentType', () => {
  it('appends utf-8 to textual types that carry no charset', () => {
    expect(storageContentType('text/plain')).toBe('text/plain; charset=utf-8');
    expect(storageContentType('text/markdown')).toBe('text/markdown; charset=utf-8');
    expect(storageContentType('text/csv')).toBe('text/csv; charset=utf-8');
    expect(storageContentType('text/html')).toBe('text/html; charset=utf-8');
    expect(storageContentType('application/json')).toBe('application/json; charset=utf-8');
    expect(storageContentType('application/xml')).toBe('application/xml; charset=utf-8');
    expect(storageContentType('application/javascript')).toBe('application/javascript; charset=utf-8');
    expect(storageContentType('image/svg+xml')).toBe('image/svg+xml; charset=utf-8');
    expect(storageContentType('application/ld+json')).toBe('application/ld+json; charset=utf-8');
  });

  it('leaves an existing charset untouched, however it is spelled', () => {
    expect(storageContentType('text/plain; charset=ISO-8859-1')).toBe('text/plain; charset=ISO-8859-1');
    expect(storageContentType('text/plain;Charset=utf-8')).toBe('text/plain;Charset=utf-8');
    expect(storageContentType('text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
  });

  it('leaves binary types unchanged', () => {
    expect(storageContentType('image/png')).toBe('image/png');
    expect(storageContentType('image/jpeg')).toBe('image/jpeg');
    expect(storageContentType('application/pdf')).toBe('application/pdf');
    expect(storageContentType('application/zip')).toBe('application/zip');
    expect(storageContentType('application/octet-stream')).toBe('application/octet-stream');
    expect(storageContentType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
      .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
});

describe('publicObjectUrl', () => {
  const key = (filename: string) => `rooms/ABC-DEF-GHJ/0e3f/${filename}`;

  it('percent-encodes Chinese and spaces', () => {
    expect(publicObjectUrl('https://pub.r2.dev', key('会议 记录 第 1 版.txt')))
      .toBe('https://pub.r2.dev/rooms/ABC-DEF-GHJ/0e3f/%E4%BC%9A%E8%AE%AE%20%E8%AE%B0%E5%BD%95%20%E7%AC%AC%201%20%E7%89%88.txt');
  });

  it('encodes the characters that end a URL early or change its meaning', () => {
    expect(publicObjectUrl('https://pub.r2.dev', key('report #3 draft?.pdf')))
      .toBe('https://pub.r2.dev/rooms/ABC-DEF-GHJ/0e3f/report%20%233%20draft%3F.pdf');
    // A literal '%' has to become '%25' or the URL reads as a bad escape, and
    // a '+' has to become '%2B' or a decoder turns it into a space.
    expect(publicObjectUrl('https://pub.r2.dev', key('100%讨论+notes.md')))
      .toBe('https://pub.r2.dev/rooms/ABC-DEF-GHJ/0e3f/100%25%E8%AE%A8%E8%AE%BA%2Bnotes.md');
  });

  it('encodes astral-plane characters as utf-8', () => {
    expect(publicObjectUrl('https://pub.r2.dev', key('🎉 launch.png')))
      .toBe('https://pub.r2.dev/rooms/ABC-DEF-GHJ/0e3f/%F0%9F%8E%89%20launch.png');
  });

  it('leaves a plain ascii key byte-for-byte alone', () => {
    expect(publicObjectUrl('https://pub.r2.dev', key('notes-v2.txt')))
      .toBe('https://pub.r2.dev/rooms/ABC-DEF-GHJ/0e3f/notes-v2.txt');
  });

  it('keeps the separators as separators', () => {
    const url = publicObjectUrl('https://pub.r2.dev', key('中文.txt'));
    expect(url.split('/')).toHaveLength(7);
    expect(url).not.toContain('%2F');
    expect(new URL(url).pathname.split('/').slice(1)).toHaveLength(4);
  });

  it('touches the base only to drop one trailing slash', () => {
    expect(publicObjectUrl('https://pub.r2.dev/', key('a.txt')))
      .toBe('https://pub.r2.dev/rooms/ABC-DEF-GHJ/0e3f/a.txt');
    // A base that already carries a path (custom domain subdirectory) is
    // passed through verbatim — it is ours, not user input.
    expect(publicObjectUrl('https://cdn.example.com/att%20files', key('a.txt')))
      .toBe('https://cdn.example.com/att%20files/rooms/ABC-DEF-GHJ/0e3f/a.txt');
  });

  it('round-trips back to the stored key, which is what r2.dev looks up', () => {
    const stored = key('会议 记录 第 1 版.txt');
    const path = new URL(publicObjectUrl('https://pub.r2.dev', stored)).pathname;
    expect(decodeURIComponent(path.slice(1))).toBe(stored);
  });
});

describe('keyFilename', () => {
  it('keeps Chinese and spaces', () => {
    expect(keyFilename('会议 记录 第 1 版.txt')).toBe('会议 记录 第 1 版.txt');
  });

  it('neutralises separators and control characters', () => {
    expect(keyFilename('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(keyFilename('C:\\notes\\plan.txt')).toBe('C:_notes_plan.txt');
    expect(keyFilename('two\r\nlines.txt')).toBe('two__lines.txt');
    expect(keyFilename('nul\u0000byte.txt')).toBe('nul_byte.txt');
  });

  it('falls back to a name when there is nothing usable left', () => {
    expect(keyFilename(undefined)).toBe('file');
    expect(keyFilename('')).toBe('file');
  });

  // It used to cut at 200 utf-16 units, which both mangled names and still
  // let 600 utf-8 bytes of Chinese through. Length is the handler's business
  // now (MAX_FILENAME_BYTES), so this only ever substitutes characters.
  it('never shortens a name', () => {
    const name = `${'a'.repeat(300)}.txt`;
    expect(keyFilename(name)).toBe(name);
  });
});

const BOUNDARY = 'boundary-upload-test';

interface PartSpec {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer | string;
}

function buildMultipart(parts: PartSpec[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) head += `; filename="${part.filename}"`;
    head += '\r\n';
    if (part.contentType !== undefined) head += `Content-Type: ${part.contentType}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function makeResponse() {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      return this;
    },
    end() {
      return this;
    },
  };
  return response;
}

async function upload(parts: PartSpec[]) {
  const body = buildMultipart(parts);
  const req = Readable.from([body]) as unknown as VercelRequest;
  Object.assign(req, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  });
  const res = makeResponse();
  await handler(req, res as unknown as VercelResponse);
  return res;
}

const MULTIPART_HEADER = `multipart/form-data; boundary=${BOUNDARY}`;

// A request that announces a size but never emits a byte: if the handler
// answers at all, it answered without reading the body.
function silentRequest(contentLength: number): VercelRequest {
  const req = new Readable({ autoDestroy: false, read() { /* client sends nothing yet */ } }) as unknown as VercelRequest;
  Object.assign(req, {
    method: 'POST',
    headers: { 'content-type': MULTIPART_HEADER, 'content-length': String(contentLength) },
  });
  return req;
}

// A chunked request with no Content-Length, i.e. the handler only finds out
// how big it is by reading it.
function chunkedRequest(totalBytes: number, chunkSize = 256 * 1024): VercelRequest {
  let sent = 0;
  const req = new Readable({
    autoDestroy: false,
    read() {
      if (sent >= totalBytes) {
        this.push(null);
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      sent += size;
      this.push(Buffer.alloc(size, 0x61));
    },
  }) as unknown as VercelRequest;
  Object.assign(req, { method: 'POST', headers: { 'content-type': MULTIPART_HEADER } });
  return req;
}

const TOO_LARGE_BODY = {
  error: 'file_too_large',
  message: `File exceeds ${MAX_FILE_BYTES} bytes (10 MB).`,
  maxBytes: MAX_FILE_BYTES,
};

const R2_ENV = {
  R2_ACCOUNT_ID: 'acct',
  R2_BUCKET: 'bucket',
  R2_PUBLIC_URL: 'https://pub.r2.dev',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
};

describe('POST /api/upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.putInputs.length = 0;
    mocks.send.mockResolvedValue({});
    Object.assign(process.env, R2_ENV);
  });

  afterEach(() => {
    for (const key of Object.keys(R2_ENV)) delete process.env[key];
  });

  it('stores a Chinese .txt as utf-8 while reporting the bare mime', async () => {
    const fileBytes = Buffer.from('你好，世界——附件内容。\n第二行', 'utf8');
    const res = await upload([
      { name: 'roomCode', data: 'ABC-DEF-GHJ' },
      { name: 'file', filename: '中文.txt', contentType: 'text/plain', data: fileBytes },
    ]);

    expect(res.statusCode).toBe(201);
    expect(mocks.putInputs).toHaveLength(1);
    const put = mocks.putInputs[0]!;
    expect(put.ContentType).toBe('text/plain; charset=utf-8');
    expect(Buffer.isBuffer(put.Body)).toBe(true);
    expect(Buffer.compare(put.Body as Buffer, fileBytes)).toBe(0);

    const attachment = res.body as { mime: string; type: string; size: number; url: string };
    expect(attachment.mime).toBe('text/plain');
    expect(attachment.type).toBe('file');
    expect(attachment.size).toBe(fileBytes.length);
    expect(attachment.url.startsWith('https://pub.r2.dev/rooms/ABC-DEF-GHJ/')).toBe(true);
  });

  it('stores the raw filename in the key but hands back an encoded url', async () => {
    const res = await upload([
      { name: 'roomCode', data: 'ABC-DEF-GHJ' },
      { name: 'file', filename: '会议 记录 第 1 版.txt', contentType: 'text/plain', data: '内容' },
    ]);

    expect(res.statusCode).toBe(201);
    const attachment = res.body as { url: string; storageKey: string; name: string };
    // The key is what R2 holds and what delete-room-blobs.ts lists by prefix:
    // raw utf-8, untouched.
    expect(mocks.putInputs[0]!.Key).toBe(attachment.storageKey);
    expect(attachment.storageKey).toBe(`rooms/ABC-DEF-GHJ/${attachment.storageKey.split('/')[2]}/会议 记录 第 1 版.txt`);
    expect(attachment.url).toBe(publicObjectUrl('https://pub.r2.dev', attachment.storageKey));
    expect(attachment.url).not.toContain(' ');
    expect(attachment.url).toContain('%E4%BC%9A%E8%AE%AE%20');
    // The filename the user sees is still theirs.
    expect(attachment.name).toBe('会议 记录 第 1 版.txt');
  });

  it('refuses to let a hostile filename grow the key', async () => {
    for (const filename of ['../../other-room/pwn.txt', 'C:\\plan\\q3.txt', 'two\nlines.txt']) {
      mocks.putInputs.length = 0;
      const res = await upload([
        { name: 'roomCode', data: 'ABC-DEF-GHJ' },
        { name: 'file', filename, contentType: 'text/plain', data: 'x' },
      ]);

      expect(res.statusCode).toBe(201);
      const attachment = res.body as { url: string; storageKey: string; name: string };
      expect(attachment.storageKey.split('/')).toHaveLength(4);
      expect(attachment.storageKey.startsWith('rooms/ABC-DEF-GHJ/')).toBe(true);
      expect(attachment.storageKey).not.toMatch(/[\\\r\n]/);
      expect(new URL(attachment.url).pathname.split('/')).toHaveLength(5);
      expect(attachment.name).toBe(filename);
    }
  });

  it('accepts a part whose content-type already carries a charset', async () => {
    const res = await upload([
      { name: 'roomCode', data: 'ABC-DEF-GHJ' },
      { name: 'file', filename: 'notes.txt', contentType: 'text/plain; charset=utf-8', data: '内容' },
    ]);

    expect(res.statusCode).toBe(201);
    expect(mocks.putInputs[0]!.ContentType).toBe('text/plain; charset=utf-8');
    expect((res.body as { mime: string }).mime).toBe('text/plain');
  });

  it('leaves a png content-type alone', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const res = await upload([
      { name: 'roomCode', data: 'ABC-DEF-GHJ' },
      { name: 'file', filename: 'shot.png', contentType: 'image/png', data: png },
    ]);

    expect(res.statusCode).toBe(201);
    expect(mocks.putInputs[0]!.ContentType).toBe('image/png');
    expect(Buffer.compare(mocks.putInputs[0]!.Body as Buffer, png)).toBe(0);
    const attachment = res.body as { mime: string; type: string };
    expect(attachment.mime).toBe('image/png');
    expect(attachment.type).toBe('image');
  });

  it('rejects a filename over the byte budget before touching R2', async () => {
    // 41 Chinese characters = 123 utf-8 bytes, three over the budget, yet
    // only 41 utf-16 units: the old 200-unit cut would have stored it whole.
    const res = await upload([
      { name: 'roomCode', data: 'ABC-DEF-GHJ' },
      { name: 'file', filename: `${'会'.repeat(41)}.txt`, contentType: 'text/plain', data: '内容' },
    ]);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'filename_too_long',
      message: '文件名称太长，不支持上传',
      maxBytes: MAX_FILENAME_BYTES,
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.putInputs).toHaveLength(0);
  });

  it('stores a name that sits exactly on the budget in full', async () => {
    const filename = '会'.repeat(40); // 120 bytes, the last accepted size
    expect(new TextEncoder().encode(filename).length).toBe(MAX_FILENAME_BYTES);

    const res = await upload([
      { name: 'roomCode', data: 'ABC-DEF-GHJ' },
      { name: 'file', filename, contentType: 'text/plain', data: '内容' },
    ]);

    expect(res.statusCode).toBe(201);
    const attachment = res.body as { storageKey: string; name: string };
    expect(attachment.storageKey.endsWith(`/${filename}`)).toBe(true);
    expect(mocks.putInputs[0]!.Key).toBe(attachment.storageKey);
    expect(attachment.name).toBe(filename);
  });

  it('answers 413 for an over-size file whatever its name costs', async () => {
    const res = await upload([
      { name: 'roomCode', data: 'ABC-DEF-GHJ' },
      {
        name: 'file',
        filename: `${'会'.repeat(41)}.txt`,
        contentType: 'text/plain',
        data: Buffer.alloc(MAX_FILE_BYTES + 1, 0x61),
      },
    ]);

    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual(TOO_LARGE_BODY);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('still rejects a type outside the allow-list', async () => {
    const res = await upload([
      { name: 'roomCode', data: 'ABC-DEF-GHJ' },
      { name: 'file', filename: 'app.exe', contentType: 'application/x-msdownload', data: 'MZ' },
    ]);

    expect(res.statusCode).toBe(415);
    expect(mocks.putInputs).toHaveLength(0);
  });
});

describe('POST /api/upload over-size handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.putInputs.length = 0;
    mocks.send.mockResolvedValue({});
    Object.assign(process.env, R2_ENV);
  });

  afterEach(() => {
    for (const key of Object.keys(R2_ENV)) delete process.env[key];
  });

  it('answers a Content-Length over the read cap without reading the body', async () => {
    const req = silentRequest(12 * 1024 * 1024);
    const res = makeResponse();

    await handler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual(TOO_LARGE_BODY);
    // Keep-alive: `Connection: close` would have node destroy the socket as
    // soon as this response flushes, i.e. while the client is still writing.
    expect(res.headers.Connection).toBeUndefined();
    expect(mocks.send).not.toHaveBeenCalled();
    // Nothing was ever emitted, so the 413 cannot have come from the body.
    expect(req.destroyed).toBe(false);
    req.destroy();
  });

  it('closes the connection for a body it is never going to drain', async () => {
    const req = silentRequest(DRAIN_CEILING_BYTES + 1);
    const res = makeResponse();

    await handler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual(TOO_LARGE_BODY);
    expect(res.headers.Connection).toBe('close');
    req.destroy();
  });

  it('answers a chunked body that outgrows the read cap with no Content-Length', async () => {
    const req = chunkedRequest(12 * 1024 * 1024);
    const res = makeResponse();

    await handler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual(TOO_LARGE_BODY);
    expect(res.headers.Connection).toBeUndefined();
    expect(mocks.send).not.toHaveBeenCalled();

    // The rest of the upload is drained rather than cut off.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(req.readableEnded).toBe(true);
    expect(req.destroyed).toBe(false);
  });

  it('rejects a 10 MB + 10 byte file that still fits the read cap', async () => {
    const fileBytes = Buffer.alloc(MAX_FILE_BYTES + 10, 0x61);
    const body = buildMultipart([
      { name: 'roomCode', data: 'ABC-DEF-GHJ' },
      { name: 'file', filename: 'big.txt', contentType: 'text/plain', data: fileBytes },
    ]);
    expect(body.length).toBeLessThan(MAX_REQUEST_BYTES);

    const req = Readable.from([body]) as unknown as VercelRequest;
    Object.assign(req, {
      method: 'POST',
      headers: { 'content-type': MULTIPART_HEADER, 'content-length': String(body.length) },
    });
    const res = makeResponse();
    await handler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual(TOO_LARGE_BODY);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('still accepts a small valid upload', async () => {
    const res = await upload([
      { name: 'roomCode', data: 'ABC-DEF-GHJ' },
      { name: 'file', filename: 'ok.txt', contentType: 'text/plain', data: 'small enough' },
    ]);

    expect(res.statusCode).toBe(201);
    expect(mocks.putInputs).toHaveLength(1);
  });
});

// Regression guard for the ECONNRESET bug: the handler used to destroy the
// request socket the moment the read cap was passed, so an over-size upload
// reached the client as a transport error instead of a 413. Only a real
// socket can show that, hence a real http server.
// The slice of VercelResponse the upload handler uses, over a real
// ServerResponse — same shape deploy/vps/server.ts builds.
function vercelResponse(response: ServerResponse): VercelResponse {
  const result = response as unknown as VercelResponse;
  result.status = (statusCode: number) => {
    response.statusCode = statusCode;
    return result;
  };
  result.json = (body: unknown) => {
    if (!response.headersSent && !response.hasHeader('Content-Type')) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    response.end(JSON.stringify(body));
    return result;
  };
  return result;
}

describe('POST /api/upload over node http', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    Object.assign(process.env, R2_ENV);
    server = createServer((request, response) => {
      void handler(request as VercelRequest, vercelResponse(response));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/upload`;
  });

  afterAll(async () => {
    for (const key of Object.keys(R2_ENV)) delete process.env[key];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.putInputs.length = 0;
    mocks.send.mockResolvedValue({});
  });

  it('returns a parsable 413 for a 12 MB upload sent with Content-Length', async () => {
    const body = buildMultipart([
      { name: 'roomCode', data: 'ABC-DEF-GHJ' },
      { name: 'file', filename: 'huge.bin', contentType: 'application/pdf', data: Buffer.alloc(12 * 1024 * 1024, 0x61) },
    ]);

    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': MULTIPART_HEADER },
      body,
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual(TOO_LARGE_BODY);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('returns a parsable 413 for a 12 MB chunked upload with no Content-Length', async () => {
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    let remaining = 12 * 1024 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining <= 0) {
          controller.close();
          return;
        }
        remaining -= chunk.length;
        controller.enqueue(new Uint8Array(chunk));
      },
    });

    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': MULTIPART_HEADER },
      body: stream,
      // Required by undici when streaming a request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual(TOO_LARGE_BODY);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('still returns 201 for a small upload over a real socket', async () => {
    const body = buildMultipart([
      { name: 'roomCode', data: 'ABC-DEF-GHJ' },
      { name: 'file', filename: 'ok.txt', contentType: 'text/plain', data: '真的很小' },
    ]);

    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': MULTIPART_HEADER },
      body,
    });

    expect(res.status).toBe(201);
    expect((await res.json() as { mime: string }).mime).toBe('text/plain');
  });
});

// Regression guard for the EPIPE bug. The 413 used to carry
// `Connection: close`, which makes node's http server destroySoon() the
// socket as soon as the response flushes — an RST lands on a client that is
// still writing its upload, and undici reports `TypeError: fetch failed`
// (cause EPIPE) instead of handing back the 413.
//
// The client has to live in its own process. When it shares this process's
// event loop it reliably wins the race against the teardown and the bug
// hides, which is exactly why the in-process cases above passed against a
// server that failed every time in production.
const UPLOAD_CLIENT_SCRIPT = `
const [url, ...sizes] = process.argv.slice(1);
void (async () => {
  const results = [];
  for (const size of sizes) {
    const fd = new FormData();
    fd.append('roomCode', 'ABC-DEF-GHJ');
    fd.append('file', new Blob([Buffer.alloc(Number(size), 97)], { type: 'text/plain' }), 'big.txt');
    try {
      const res = await fetch(url, { method: 'POST', body: fd });
      results.push({ status: res.status, body: await res.text() });
    } catch (error) {
      results.push({
        failed: String(error),
        cause: error && error.cause ? (error.cause.code ?? String(error.cause)) : undefined,
      });
    }
  }
  process.stdout.write(JSON.stringify(results));
})();
`;

interface ClientResult {
  status?: number;
  body?: string;
  failed?: string;
  cause?: string;
}

// One child process per call; several sizes reuse the same connection pool,
// so passing more than one also covers keep-alive reuse after a 413.
function uploadFromOwnProcess(url: string, ...byteSizes: number[]): Promise<ClientResult[]> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['-e', UPLOAD_CLIENT_SCRIPT, '--', url, ...byteSizes.map(String)],
      { timeout: 60_000 },
      (error, stdout, stderr) => {
        if (!stdout) {
          reject(new Error(`upload client printed nothing: ${error?.message ?? ''} ${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout) as ClientResult[]);
      },
    );
  });
}

describe('POST /api/upload from a client in its own process', () => {
  let bareServer: Server;
  let bareUrl: string;
  let vpsApp: VpsApp;
  let vpsUrl: string;

  beforeAll(async () => {
    Object.assign(process.env, R2_ENV);

    bareServer = createServer((request, response) => {
      void handler(request as VercelRequest, vercelResponse(response));
    });
    await new Promise<void>((resolve) => bareServer.listen(0, '127.0.0.1', resolve));
    bareUrl = `http://127.0.0.1:${(bareServer.address() as AddressInfo).port}/api/upload`;

    // The real pipeline: same routing, body handling and response adapter the
    // VPS runs, just on an ephemeral port.
    vpsApp = createVpsApp({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => vpsApp.server.listen(0, '127.0.0.1', resolve));
    vpsUrl = `http://127.0.0.1:${(vpsApp.server.address() as AddressInfo).port}/api/upload`;
  });

  afterAll(async () => {
    for (const key of Object.keys(R2_ENV)) delete process.env[key];
    await vpsApp?.close();
    await new Promise<void>((resolve) => bareServer.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.putInputs.length = 0;
    mocks.send.mockResolvedValue({});
  });

  for (const megabytes of [12, 40]) {
    it(`resolves a ${megabytes} MB fetch+FormData upload with 413 on a bare http server`, async () => {
      const [result] = await uploadFromOwnProcess(bareUrl, megabytes * 1024 * 1024);

      expect(result).toEqual(expect.objectContaining({ status: 413 }));
      expect(JSON.parse(result!.body!)).toEqual(TOO_LARGE_BODY);
      expect(mocks.send).not.toHaveBeenCalled();
    }, 60_000);

    it(`resolves a ${megabytes} MB fetch+FormData upload with 413 through the VPS pipeline`, async () => {
      const [result] = await uploadFromOwnProcess(vpsUrl, megabytes * 1024 * 1024);

      expect(result).toEqual(expect.objectContaining({ status: 413 }));
      expect(JSON.parse(result!.body!)).toEqual(TOO_LARGE_BODY);
      expect(mocks.send).not.toHaveBeenCalled();
    }, 60_000);
  }

  it('leaves the connection usable for the next upload after a 413', async () => {
    const [tooLarge, accepted] = await uploadFromOwnProcess(vpsUrl, 12 * 1024 * 1024, 64);

    expect(tooLarge).toEqual(expect.objectContaining({ status: 413 }));
    expect(accepted).toEqual(expect.objectContaining({ status: 201 }));
    expect(mocks.putInputs).toHaveLength(1);
  }, 60_000);
});
