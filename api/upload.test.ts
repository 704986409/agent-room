import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';

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

import handler, { storageContentType } from './upload.js';

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

  it('still rejects a type outside the allow-list', async () => {
    const res = await upload([
      { name: 'roomCode', data: 'ABC-DEF-GHJ' },
      { name: 'file', filename: 'app.exe', contentType: 'application/x-msdownload', data: 'MZ' },
    ]);

    expect(res.statusCode).toBe(415);
    expect(mocks.putInputs).toHaveLength(0);
  });
});
