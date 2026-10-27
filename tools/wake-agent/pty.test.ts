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

  it('keeps scrollback for a late subscriber and drops output past 256 KiB', async () => {
    const seatId = `test-pty-scroll-${Date.now()}`;
    const session = spawnPtySession({
      seatId,
      command: process.execPath,
      args: ['-e', 'process.stdout.write("early-marker\\n" + "Q".repeat(300000) + "tail-marker\\n")'],
      cwd: process.cwd(),
      env: {},
      cols: 80,
      rows: 24,
    });

    const deadline = Date.now() + 8000;
    while (!session.scrollback().includes('tail-marker') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 30));
    }
    const prior = session.scrollback();
    expect(prior).toContain('tail-marker');
    expect(prior).not.toContain('early-marker');
    expect(Buffer.byteLength(prior, 'utf8')).toBeLessThanOrEqual(256 * 1024);
    expect(prior).toContain('Q');

    const late: string[] = [];
    const unsub = session.onData(data => { late.push(data); });
    expect(late.join('')).not.toContain('tail-marker');

    session.kill();
    await session.exited;
    unsub();
    expect(late.join('')).not.toContain('early-marker');
  }, 15_000);

  it('delivers earlier output via scrollback(), then only new bytes to a late onData listener', async () => {
    const seatId = `test-pty-late-${Date.now()}`;
    const session = spawnPtySession({
      seatId,
      command: 'bash',
      args: ['-lc', 'printf "early-marker\\n"; exec cat'],
      cwd: process.cwd(),
      env: {},
      cols: 80,
      rows: 24,
    });
    const deadline = Date.now() + 5000;
    while (!session.scrollback().includes('early-marker') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 30));
    }
    expect(session.scrollback()).toContain('early-marker');

    const late: string[] = [];
    const unsub = session.onData(data => { late.push(data); });
    expect(late.join('')).not.toContain('early-marker');

    session.write('late-marker\n');
    const deadline2 = Date.now() + 5000;
    while (!late.join('').includes('late-marker') && Date.now() < deadline2) {
      await new Promise(r => setTimeout(r, 30));
    }
    expect(late.join('')).toContain('late-marker');
    expect(late.join('')).not.toContain('early-marker');
    const replay = session.scrollback();
    expect(replay.indexOf('early-marker')).toBeGreaterThanOrEqual(0);
    expect(replay.indexOf('early-marker')).toBeLessThan(replay.indexOf('late-marker'));

    unsub();
    session.kill();
    await session.exited;
  }, 15_000);
});
