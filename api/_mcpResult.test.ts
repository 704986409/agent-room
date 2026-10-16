// ok() and structuredContentFor(): the two halves of a tool result must say
// the same thing, and the text half is the one that may never change.

import { describe, expect, it } from 'vitest';
import { ok, structuredContentFor } from './_mcpResult.js';

describe('structuredContentFor', () => {
  // Not a copy: a client reading structuredContent and a client reading the
  // text are looking at the same value, so they cannot drift apart.
  it('hands a plain object back as the same value', () => {
    const value = { code: 'AAA-BBB-CCC', cursor: 3 };
    expect(structuredContentFor(value)).toBe(value);
  });

  it('wraps a string result under "message"', () => {
    expect(structuredContentFor('The room has ended.')).toEqual({ message: 'The room has ended.' });
  });

  it('wraps an empty string too, rather than dropping the result', () => {
    expect(structuredContentFor('')).toEqual({ message: '' });
  });

  // An object schema cannot describe these, and a wrapper key would be
  // inventing payload the text never had.
  it.each([
    ['an array', [1, 2, 3]],
    ['null', null],
    ['a number', 7],
    ['a boolean', true],
    ['undefined', undefined],
  ])('returns undefined for %s', (_label, value) => {
    expect(structuredContentFor(value)).toBeUndefined();
  });
});

describe('ok', () => {
  it('serializes an object payload as pretty JSON and omits structuredContent by default', () => {
    const result = ok({ left: true, code: 'AAA-BBB-CCC' });
    expect(result.content).toEqual([
      { type: 'text', text: '{\n  "left": true,\n  "code": "AAA-BBB-CCC"\n}' },
    ]);
    expect(result.structuredContent).toBeUndefined();
  });

  it('mirrors the payload into structuredContent when asked', () => {
    const value = { code: 'AAA-BBB-CCC', cursor: 0 };
    const result = ok(value, [], true);
    expect(result.structuredContent).toBe(value);
    expect((result.content[0] as { text: string }).text).toBe(JSON.stringify(value, null, 2));
  });

  it('leaves a string payload as bare text and reports it as { message }', () => {
    const result = ok('Nothing to do.', [], true);
    expect(result.content).toEqual([{ type: 'text', text: 'Nothing to do.' }]);
    expect(result.structuredContent).toEqual({ message: 'Nothing to do.' });
  });

  it('keeps extra content items after the text and out of structuredContent', () => {
    const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' };
    const result = ok({ messages: [] }, [image], true);
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toBe(image);
    expect(result.structuredContent).toEqual({ messages: [] });
  });

  it('declares no structuredContent for a payload an object schema cannot hold', () => {
    expect(ok([1, 2], [], true).structuredContent).toBeUndefined();
    expect((ok([1, 2], [], true).content[0] as { text: string }).text).toBe('[\n  1,\n  2\n]');
  });
});
