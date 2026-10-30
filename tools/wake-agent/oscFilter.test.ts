import { describe, expect, it } from 'vitest';
import { isOscColorReport, shouldDropPtyStdin, stripOscColorSequences } from './src/oscFilter.js';

describe('isOscColorReport', () => {
  it('detects ESC-prefixed OSC 10/11/12 reports', () => {
    expect(isOscColorReport('\x1b]10;rgb:ffff/ffff/ffff\x07')).toBe(true);
    expect(isOscColorReport('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\')).toBe(true);
    expect(isOscColorReport('\x1b]12;rgb:0000/0000/0000\x07')).toBe(true);
  });

  it('detects stripped-bracket and glued reports seen in popout prompts', () => {
    expect(isOscColorReport(']10;rgb:ffff/ffff/ffff')).toBe(true);
    expect(isOscColorReport(']11;rgb:1e1e/1e1e/1e1e')).toBe(true);
    expect(isOscColorReport(']10;rgb:ffff/ffff/ffff\\]11;rgb:1e1e/1e1e/1e1e\\')).toBe(true);
    expect(isOscColorReport('10;rgb:aaaa/bbbb/cccc')).toBe(true);
  });

  it('allows normal keystrokes', () => {
    expect(isOscColorReport('hello')).toBe(false);
    expect(isOscColorReport('\x16')).toBe(false);
    expect(isOscColorReport('a')).toBe(false);
  });
});

describe('shouldDropPtyStdin', () => {
  it('drops OSC reports and Ctrl+V image-paste byte', () => {
    expect(shouldDropPtyStdin('\x16')).toBe(true);
    expect(shouldDropPtyStdin(']10;rgb:ffff/ffff/ffff')).toBe(true);
    expect(shouldDropPtyStdin('')).toBe(true);
    expect(shouldDropPtyStdin('x')).toBe(false);
  });
});

describe('stripOscColorSequences', () => {
  it('removes historical OSC color queries so late xterm attach does not re-answer them', () => {
    const raw = 'prompt\x1b]10;?\x07more\x1b]11;?\x07end';
    const stripped = stripOscColorSequences(raw);
    expect(stripped).toBe('promptmoreend');
    expect(stripped).not.toMatch(/\]10;/);
  });

  it('removes orphan rgb reports from scrollback', () => {
    const raw = 'hi]10;rgb:ffff/ffff/ffff\x07there';
    expect(stripOscColorSequences(raw)).toBe('hithere');
  });
});
