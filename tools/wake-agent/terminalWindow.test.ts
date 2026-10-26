import { describe, expect, it } from 'vitest';
import {
  buildPopoutControlPath,
  buildPopoutControlUrl,
  terminalWindowLabel,
} from './src/terminalWindow.js';

describe('terminalWindow helpers', () => {
  it('builds safe Tauri labels', () => {
    expect(terminalWindowLabel('seat-1')).toBe('terminal-seat-1');
    expect(terminalWindowLabel('a/b c')).toBe('terminal-a_b_c');
    expect(terminalWindowLabel('  ')).toBe('terminal-seat');
    expect(terminalWindowLabel('x'.repeat(200)).length).toBeLessThanOrEqual('terminal-'.length + 96);
  });

  it('builds pop-out control URLs', () => {
    const path = buildPopoutControlPath('seat-9', 'tok');
    expect(path).toContain('popout=1');
    expect(path).toContain('terminal=seat-9');
    expect(path).toContain('t=tok');
    expect(buildPopoutControlUrl('http://127.0.0.1:17421', 's1', 'abc')).toBe(
      'http://127.0.0.1:17421/?t=abc&terminal=s1&popout=1',
    );
  });
});
