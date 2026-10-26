import { describe, expect, it } from 'vitest';
import {
  TERMINAL_GEOM_PREFIX,
  buildPopoutControlPath,
  buildPopoutControlUrl,
  clampTerminalGeometry,
  loadTerminalGeometry,
  parseTerminalGeometry,
  saveTerminalGeometry,
  serializeTerminalGeometry,
  terminalGeometryKey,
  terminalWindowLabel,
  undockDragExceeded,
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

  it('clamps and serializes pop-out geometry per seat', () => {
    expect(clampTerminalGeometry(null)).toBeNull();
    expect(clampTerminalGeometry({ x: 10, y: 20, width: 100, height: 100 })).toEqual({
      x: 10,
      y: 20,
      width: 480,
      height: 320,
    });
    expect(clampTerminalGeometry({ x: -9000, y: 20000, width: 9000, height: 5000 })).toEqual({
      x: -8000,
      y: 16000,
      width: 3840,
      height: 2160,
    });
    expect(clampTerminalGeometry({ x: 1, y: 2, width: Number.NaN, height: 400 })).toBeNull();
    expect(parseTerminalGeometry('not-json')).toBeNull();
    expect(parseTerminalGeometry('')).toBeNull();

    const geom = { x: 12.4, y: 40.6, width: 800, height: 500 };
    expect(JSON.parse(serializeTerminalGeometry(geom))).toEqual({
      x: 12,
      y: 41,
      width: 800,
      height: 500,
    });

    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    expect(terminalGeometryKey('seat-1')).toBe(`${TERMINAL_GEOM_PREFIX}seat-1`);
    expect(saveTerminalGeometry(storage, 'seat-1', geom)).toEqual({ x: 12, y: 41, width: 800, height: 500 });
    expect(loadTerminalGeometry(storage, 'seat-1')).toEqual({ x: 12, y: 41, width: 800, height: 500 });
    expect(loadTerminalGeometry(storage, 'other')).toBeNull();
    expect(saveTerminalGeometry(storage, '  ', geom)).toBeNull();
  });

  it('ignores tiny undock drags', () => {
    expect(undockDragExceeded(3, 4)).toBe(false);
    expect(undockDragExceeded(40, 0)).toBe(false);
    expect(undockDragExceeded(48, 0)).toBe(true);
    expect(undockDragExceeded(30, 40)).toBe(true);
    expect(undockDragExceeded(Number.NaN, 80)).toBe(false);
  });
});
