import { describe, expect, it } from 'vitest';
import { linuxClipboardAttempts } from './src/clipboard.js';

describe('linuxClipboardAttempts', () => {
  it('prefers uppercase CLIPBOARD for the first xclip attempt', () => {
    const [command, args] = linuxClipboardAttempts[0];
    expect(command).toBe('xclip');
    expect(args).toEqual(['-selection', 'CLIPBOARD', '-o']);
  });

  it('keeps lowercase clipboard as an xclip fallback', () => {
    const xclipAttempts = linuxClipboardAttempts.filter(([cmd]) => cmd === 'xclip');
    expect(xclipAttempts).toEqual([
      ['xclip', ['-selection', 'CLIPBOARD', '-o']],
      ['xclip', ['-selection', 'clipboard', '-o']],
    ]);
  });
});
