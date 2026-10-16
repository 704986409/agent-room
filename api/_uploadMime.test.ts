import { describe, expect, it } from 'vitest';
import { ALLOWED_MIMES, TEXTUAL_MIMES, baseMime, storageContentType } from './_uploadMime.js';

describe('baseMime', () => {
  it('strips parameters and normalises case', () => {
    expect(baseMime('text/plain; charset=utf-8')).toBe('text/plain');
    expect(baseMime('  IMAGE/PNG  ')).toBe('image/png');
    expect(baseMime('application/json;charset=UTF-8')).toBe('application/json');
  });
});

describe('storageContentType', () => {
  it('appends utf-8 to textual types only', () => {
    expect(storageContentType('text/csv')).toBe('text/csv; charset=utf-8');
    expect(storageContentType('application/ld+json')).toBe('application/ld+json; charset=utf-8');
    expect(storageContentType('application/zip')).toBe('application/zip');
  });

  it('respects a charset the client already sent', () => {
    expect(storageContentType('text/plain; charset=ISO-8859-1')).toBe('text/plain; charset=ISO-8859-1');
  });
});

describe('mime sets', () => {
  it('keeps the allow-list and the textual set as plain sets of base types', () => {
    expect(ALLOWED_MIMES.has('image/png')).toBe(true);
    expect(ALLOWED_MIMES.has('application/x-msdownload')).toBe(false);
    expect(TEXTUAL_MIMES.has('image/svg+xml')).toBe(true);
    for (const mime of [...ALLOWED_MIMES, ...TEXTUAL_MIMES]) {
      expect(baseMime(mime)).toBe(mime);
    }
  });
});
