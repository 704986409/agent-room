import { spawn } from 'node:child_process';

const CLIPBOARD_TIMEOUT_MS = 1500;
const CLIPBOARD_MAX_BYTES = 1_000_000;

interface CommandOutput {
  ok: boolean;
  text: string;
}

function runCommand(command: string, args: readonly string[], timeoutMs = CLIPBOARD_TIMEOUT_MS): Promise<CommandOutput> {
  return new Promise(resolve => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (ok: boolean, text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, text });
    };
    const timer = setTimeout(() => {
      try { child?.kill(); } catch { /* ignore */ }
      finish(false, '');
    }, timeoutMs);
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      finish(false, '');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      size += buffer.length;
      if (size > CLIPBOARD_MAX_BYTES) {
        try { child?.kill(); } catch { /* ignore */ }
        finish(true, Buffer.concat(chunks).subarray(0, CLIPBOARD_MAX_BYTES).toString('utf8'));
      }
    });
    child.on('error', () => finish(false, ''));
    child.on('close', code => {
      finish(code === 0, Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/**
 * Read the OS clipboard as text. Missing tools and non-zero exits are skipped.
 * Never throws — callers get '' when nothing can be read.
 */
export async function readOsClipboardText(): Promise<string> {
  try {
    if (process.platform === 'win32') {
      const result = await runCommand('powershell', [
        '-NoProfile',
        '-Command',
        '[Console]::Out.Write((Get-Clipboard -Raw))',
      ]);
      return result.ok ? result.text : '';
    }
    const attempts: Array<[string, string[]]> = [
      ['xclip', ['-selection', 'clipboard', '-o']],
      ['xsel', ['--clipboard', '--output']],
      ['wl-paste', []],
    ];
    for (const [command, args] of attempts) {
      const result = await runCommand(command, args);
      if (result.ok) return result.text;
    }
    return '';
  } catch {
    return '';
  }
}
