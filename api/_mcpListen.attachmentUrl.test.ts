// Attachment URLs reach the MCP side as whatever was stored on the message,
// and both spellings are in circulation: raw utf-8 keys from before
// api/upload.ts percent-encoded the url it returns, and encoded ones after.
// The trust check and the image fetch have to take either, and must not
// re-encode an already-encoded url (that would 404 on a '%25').

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { hydrateListenImages, isTrustedAttachmentImageUrl } from './_mcpListen.js';
import { publicObjectUrl } from './upload.js';

const BASE = 'https://pub.r2.dev';
const KEY = 'rooms/ABC-DEF-GHJ/0e3f/会议 记录 第 1 版.png';
const ENCODED = publicObjectUrl(BASE, KEY);
const RAW = `${BASE}/${KEY}`;

const previousR2 = process.env.R2_PUBLIC_URL;

beforeEach(() => {
  process.env.R2_PUBLIC_URL = BASE;
});

afterEach(() => {
  if (previousR2 === undefined) delete process.env.R2_PUBLIC_URL;
  else process.env.R2_PUBLIC_URL = previousR2;
});

describe('isTrustedAttachmentImageUrl', () => {
  it('trusts an encoded public url — the prefix check still matches', () => {
    expect(ENCODED.startsWith(`${BASE}/`)).toBe(true);
    expect(isTrustedAttachmentImageUrl(ENCODED)).toBe(true);
  });

  it('still trusts the raw urls stored before encoding', () => {
    expect(isTrustedAttachmentImageUrl(RAW)).toBe(true);
  });

  it('trusts an encoded r2.dev url even with R2_PUBLIC_URL unset', () => {
    delete process.env.R2_PUBLIC_URL;
    expect(isTrustedAttachmentImageUrl(ENCODED)).toBe(true);
  });

  it('keeps rejecting a foreign host however it is encoded', () => {
    expect(isTrustedAttachmentImageUrl(`https://evil.test/${encodeURIComponent('会议.png')}`)).toBe(false);
    expect(isTrustedAttachmentImageUrl(`http://pub.r2.dev/${encodeURIComponent('会议.png')}`)).toBe(false);
  });
});

describe('hydrateListenImages', () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  function fetchSpy() {
    return vi.fn(async () => new Response(pngBytes, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })) as unknown as typeof fetch;
  }

  it('fetches an encoded url exactly as stored, without encoding it again', async () => {
    const spy = fetchSpy();
    const parts = await hydrateListenImages(
      [{ attachments: [{ type: 'image', url: ENCODED, mime: 'image/png' }] }],
      spy,
    );

    expect(parts).toEqual([{ type: 'image', data: pngBytes.toString('base64'), mimeType: 'image/png' }]);
    const requested = (spy as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0];
    expect(requested).toBe(ENCODED);
    expect(requested).not.toContain('%25');
  });

  it('still hydrates a raw url from an older message', async () => {
    const spy = fetchSpy();
    const parts = await hydrateListenImages(
      [{ attachments: [{ type: 'image', url: RAW, mime: 'image/png' }] }],
      spy,
    );

    expect(parts).toHaveLength(1);
    expect((spy as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0]).toBe(RAW);
  });
});
