import { describe, expect, it } from 'vitest';
import { MAX_FILENAME_BYTES, isFilenameTooLong } from './attachments.js';

describe('isFilenameTooLong', () => {
  it('measures ascii names one byte per character', () => {
    expect(isFilenameTooLong('a'.repeat(MAX_FILENAME_BYTES))).toBe(false);
    expect(isFilenameTooLong('a'.repeat(MAX_FILENAME_BYTES + 1))).toBe(true);
  });

  it('measures Chinese names at three bytes per character', () => {
    // 40 × 3 bytes = exactly the budget; one more character blows it.
    expect(isFilenameTooLong('会'.repeat(40))).toBe(false);
    expect(isFilenameTooLong('会'.repeat(41))).toBe(true);
  });

  it('counts an emoji as its four utf-8 bytes, not its two utf-16 units', () => {
    expect(isFilenameTooLong('🎉'.repeat(30))).toBe(false);
    expect(isFilenameTooLong('🎉'.repeat(31))).toBe(true);
    // 60 utf-16 units, still over the byte budget at 124 bytes.
    expect(isFilenameTooLong(`${'🎉'.repeat(30)}.png`)).toBe(true);
  });

  it('accepts the everyday names the composer actually sees', () => {
    expect(isFilenameTooLong('')).toBe(false);
    expect(isFilenameTooLong('notes.txt')).toBe(false);
    expect(isFilenameTooLong('会议 记录 第 1 版.txt')).toBe(false);
  });
});
