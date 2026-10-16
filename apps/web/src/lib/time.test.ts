import { describe, it, expect } from 'vitest';
import { INVALID_TIME_PLACEHOLDER, safeFormatTime } from './time.js';

const fmt = (date: Date) => date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

describe('safeFormatTime', () => {
  it('formats a real timestamp', () => {
    expect(safeFormatTime(Date.UTC(2026, 0, 2, 3, 4), () => 'formatted')).toBe('formatted');
    expect(safeFormatTime(new Date(), fmt)).not.toBe(INVALID_TIME_PLACEHOLDER);
  });

  // Rooms still hold messages appended before the server stamped `time`.
  // Those used to render as the literal string "Invalid Date" in every bubble.
  it('falls back to the placeholder instead of "Invalid Date"', () => {
    for (const bad of [undefined, null, NaN, Infinity, 'not a time' as unknown as number]) {
      expect(safeFormatTime(bad as number | null | undefined, fmt)).toBe(INVALID_TIME_PLACEHOLDER);
    }
  });

  it('falls back for an unrepresentable Date', () => {
    expect(safeFormatTime(new Date('nope'), fmt)).toBe(INVALID_TIME_PLACEHOLDER);
  });

  it('does not call the formatter for a bad value', () => {
    expect(safeFormatTime(undefined, () => { throw new Error('should not run'); }))
      .toBe(INVALID_TIME_PLACEHOLDER);
  });
});
