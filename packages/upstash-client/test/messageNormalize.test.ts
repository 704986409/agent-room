import { describe, it, expect } from 'vitest';
import type { Message } from '@agent-room/shared';
import {
  MAX_MESSAGE_TIME_SKEW_MS,
  healStoredMessage,
  normalizeMessageForWrite,
  normalizeMessageTime,
} from '../src/index.js';

const NOW = 1_700_000_000_000;

const MSG: Message = {
  id: 1, type: 'msg', name: 'A', initials: 'AA', color: '#111',
  role: 'r', text: 'hi', client: 'web', time: NOW,
};

/** Build a message whose `time` is whatever junk a client sent us. */
function withTime(time: unknown): Message {
  return { ...MSG, time } as unknown as Message;
}

describe('normalizeMessageTime', () => {
  it('keeps a client time inside the trust window', () => {
    for (const time of [NOW, NOW - MAX_MESSAGE_TIME_SKEW_MS, NOW + MAX_MESSAGE_TIME_SKEW_MS]) {
      expect(normalizeMessageTime(withTime(time), NOW).time).toBe(time);
    }
  });

  it('stamps now when `time` is missing entirely (the "Invalid Date" bug)', () => {
    const { time: _dropped, ...timeless } = MSG;
    expect(normalizeMessageTime(timeless as Message, NOW).time).toBe(NOW);
  });

  it('stamps now for null, a string, NaN and Infinity', () => {
    for (const bad of [null, undefined, '1700000000000', 'yesterday', NaN, Infinity, -Infinity, {}]) {
      expect(normalizeMessageTime(withTime(bad), NOW).time).toBe(NOW);
    }
  });

  it('stamps now for a time too far in the future or the past', () => {
    expect(normalizeMessageTime(withTime(NOW + MAX_MESSAGE_TIME_SKEW_MS + 1), NOW).time).toBe(NOW);
    expect(normalizeMessageTime(withTime(NOW - MAX_MESSAGE_TIME_SKEW_MS - 1), NOW).time).toBe(NOW);
    // The legacy shapes: epoch 0/1, and a clock set years ahead.
    expect(normalizeMessageTime(withTime(1), NOW).time).toBe(NOW);
    expect(normalizeMessageTime(withTime(9_999_999_999_999), NOW).time).toBe(NOW);
  });

  it('never rejects, and leaves every other field (including id) alone', () => {
    const normalized = normalizeMessageTime(withTime('nope'), NOW);
    expect(normalized).toEqual({ ...MSG, time: NOW });
    expect(normalized.id).toBe(MSG.id);
  });

  it('defaults `now` to the server clock', () => {
    const before = Date.now();
    const time = normalizeMessageTime(withTime(undefined)).time;
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(Date.now());
  });
});

describe('normalizeMessageForWrite', () => {
  it('repairs text and time together', () => {
    const { text: _noText, time: _noTime, ...broken } = MSG;
    expect(normalizeMessageForWrite(broken as Message, NOW)).toEqual({
      ...MSG, text: '', time: NOW,
    });
  });

  it('returns a valid message untouched', () => {
    expect(normalizeMessageForWrite(MSG, NOW)).toEqual(MSG);
  });
});

describe('healStoredMessage', () => {
  it('fills in a missing text on the read path', () => {
    const { text: _dropped, ...textless } = MSG;
    expect(healStoredMessage(textless as Message).text).toBe('');
  });

  it('leaves a stored time as-is — history is not rewritten on read', () => {
    expect(healStoredMessage(withTime(1)).time).toBe(1);
  });
});
