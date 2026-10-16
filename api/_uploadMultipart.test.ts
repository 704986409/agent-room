import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import {
  MAX_FILE_BYTES,
  MAX_REQUEST_BYTES,
  MULTIPART_OVERHEAD_BYTES,
  declaredContentLength,
  drainRequest,
  parseMultipart,
  readRequestBody,
} from './_uploadMultipart.js';

function request(chunks: (Buffer | string)[], headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from(chunks) as unknown as IncomingMessage;
  Object.assign(stream, { headers, method: 'POST' });
  return stream;
}

// Emits `totalBytes` in fixed-size chunks, so an over-cap read has to deal
// with more data arriving after it stopped buffering. `autoDestroy` is off
// so that a destroyed stream always means someone called destroy().
function chunkedRequest(totalBytes: number, chunkSize = 64 * 1024, headers: Record<string, string> = {}): IncomingMessage {
  let sent = 0;
  const stream = new Readable({
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
  }) as unknown as IncomingMessage;
  Object.assign(stream, { headers, method: 'POST' });
  return stream;
}

describe('size limits', () => {
  it('derives the request cap from the file cap plus the multipart allowance', () => {
    expect(MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_REQUEST_BYTES).toBe(MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES);
  });
});

describe('declaredContentLength', () => {
  it('reads a numeric header and ignores anything unusable', () => {
    expect(declaredContentLength(request([], { 'content-length': '2048' }))).toBe(2048);
    expect(declaredContentLength(request([], { 'content-length': '0' }))).toBe(0);
    expect(declaredContentLength(request([]))).toBeNull();
    expect(declaredContentLength(request([], { 'content-length': 'nope' }))).toBeNull();
    expect(declaredContentLength(request([], { 'content-length': '-1' }))).toBeNull();
  });
});

describe('readRequestBody', () => {
  it('buffers a body that fits', async () => {
    const result = await readRequestBody(request(['hello ', 'world']), 1024);
    expect(result.ok).toBe(true);
    expect(result.ok && result.body.toString('utf8')).toBe('hello world');
  });

  it('resolves not-ok instead of throwing once the cap is passed', async () => {
    const req = chunkedRequest(512 * 1024, 64 * 1024);
    const destroy = vi.spyOn(req, 'destroy');
    const result = await readRequestBody(req, 128 * 1024);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.receivedBytes).toBeGreaterThan(128 * 1024);
    // The socket must survive: the caller still has a 413 to write.
    expect(destroy).not.toHaveBeenCalled();
    expect(req.destroyed).toBe(false);
  });

  it('keeps consuming the request after it stopped buffering', async () => {
    const req = chunkedRequest(512 * 1024, 64 * 1024);
    const result = await readRequestBody(req, 128 * 1024);
    expect(result.ok).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(req.readableEnded).toBe(true);
  });

  it('rejects on a stream error', async () => {
    const req = new Readable({
      read() { this.destroy(new Error('socket blew up')); },
    }) as unknown as IncomingMessage;
    await expect(readRequestBody(req, 1024)).rejects.toThrow('socket blew up');
  });
});

describe('drainRequest', () => {
  it('discards the rest of the request and leaves the socket alone when it ends', async () => {
    const req = chunkedRequest(256 * 1024, 32 * 1024);
    const res = { writableEnded: true };
    drainRequest(req, res, { timeoutMs: 50 });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(req.readableEnded).toBe(true);
    expect(req.destroyed).toBe(false);
  });

  it('waits for the response to finish before arming the teardown', async () => {
    const req = new Readable({ read() { /* client stalls mid-upload */ } }) as unknown as IncomingMessage;
    const listeners: (() => void)[] = [];
    const res = {
      writableEnded: false,
      once(_event: 'finish', listener: () => void) { listeners.push(listener); return this; },
    };
    drainRequest(req, res, { timeoutMs: 20 });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(req.destroyed).toBe(false);

    for (const listener of listeners) listener();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(req.destroyed).toBe(true);
  });

  it('destroys the socket once the drain ceiling is passed', async () => {
    const req = chunkedRequest(1024 * 1024, 64 * 1024);
    const res = { writableEnded: true };
    drainRequest(req, res, { timeoutMs: 5_000, ceilingBytes: 128 * 1024 });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(req.destroyed).toBe(true);
  });

  it('counts bytes the reader already swallowed towards the ceiling', async () => {
    const req = chunkedRequest(1024 * 1024, 64 * 1024);
    const res = { writableEnded: true };
    drainRequest(req, res, { timeoutMs: 5_000, ceilingBytes: 128 * 1024, receivedBytes: 127 * 1024 });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(req.destroyed).toBe(true);
  });
});

const BOUNDARY = 'b-multipart-unit';

function multipart(parts: { name: string; filename?: string; contentType?: string; data: Buffer | string }[]): Buffer {
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

describe('parseMultipart', () => {
  it('splits fields and files, keeping binary bytes intact', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d]);
    const parts = parseMultipart(multipart([
      { name: 'roomCode', data: 'ABC-DEF-GHJ' },
      { name: 'file', filename: '中文.bin', contentType: 'image/png', data: bytes },
    ]), BOUNDARY);

    expect(parts).toHaveLength(2);
    expect(parts[0]!.name).toBe('roomCode');
    expect(parts[0]!.filename).toBeUndefined();
    expect(parts[0]!.data.toString('utf8')).toBe('ABC-DEF-GHJ');
    expect(parts[1]!.filename).toBe('中文.bin');
    expect(parts[1]!.contentType).toBe('image/png');
    expect(Buffer.compare(parts[1]!.data, bytes)).toBe(0);
  });

  it('handles an empty part body', () => {
    const parts = parseMultipart(multipart([{ name: 'file', filename: 'empty.txt', data: '' }]), BOUNDARY);
    expect(parts[0]!.data.length).toBe(0);
  });

  it('throws when the boundary is absent or the body is truncated', () => {
    expect(() => parseMultipart(Buffer.from('nothing to see'), BOUNDARY)).toThrow('Boundary not found');
    const truncated = multipart([{ name: 'file', filename: 'a.txt', data: 'hi' }]).subarray(0, 60);
    expect(() => parseMultipart(truncated, BOUNDARY)).toThrow('Truncated multipart body.');
  });
});
