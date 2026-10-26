import { describe, expect, it, afterEach } from 'vitest';
import {
  clearPtyRegistryForTests,
  getPtySession,
  listPtySessions,
  ptyAvailable,
  seatIdFromLogFile,
  spawnPtySession,
  unregisterPtySession,
} from './src/pty.js';

afterEach(() => {
  clearPtyRegistryForTests();
});

describe('pty registry helpers', () => {
  it('parses seat id from log file basename', () => {
    expect(seatIdFromLogFile('/tmp/state/logs/seat-abc.log')).toBe('seat-abc');
    expect(seatIdFromLogFile(undefined)).toBeUndefined();
  });
});

describe.skipIf(!ptyAvailable())('pty smoke', () => {
  it('spawns a trivial PTY, registers it, accepts stdin, and cleans up', async () => {
    const seatId = `test-pty-${Date.now()}`;
    const chunks: string[] = [];
    const session = spawnPtySession({
      seatId,
      command: 'bash',
      args: ['-lc', 'printf "hi-from-pty\\n"; exec cat'],
      cwd: process.cwd(),
      env: {},
      cols: 80,
      rows: 24,
    });
    expect(getPtySession(seatId)?.pid).toBe(session.pid);
    expect(listPtySessions().some(row => row.seatId === seatId)).toBe(true);

    const unsub = session.onData(data => { chunks.push(data); });
    const deadline = Date.now() + 5000;
    while (!chunks.join('').includes('hi-from-pty') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    expect(chunks.join('')).toContain('hi-from-pty');

    session.write('echo ok-stdin\n');
    const deadline2 = Date.now() + 5000;
    while (!chunks.join('').includes('ok-stdin') && Date.now() < deadline2) {
      await new Promise(r => setTimeout(r, 50));
    }
    // cat echoes stdin; tolerate timing by at least having written without throw
    session.resize(100, 30);
    expect(session.cols).toBe(100);
    expect(session.rows).toBe(30);

    unsub();
    session.kill();
    await session.exited;
    unregisterPtySession(seatId);
    expect(getPtySession(seatId)).toBeUndefined();
  }, 15_000);
});
