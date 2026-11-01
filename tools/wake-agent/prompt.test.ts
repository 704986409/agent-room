import { describe, expect, it } from 'vitest';
import { firstRunPrompt, launchPrompt, reuseWakePrompt, wakePrompt } from './src/prompt.js';

describe('firstRunPrompt', () => {
  it('with rules/state paths: short human wake, no seatKey, no absolute install-disk reads', () => {
    const prompt = firstRunPrompt({
      code: 'HK4-TZQ-FWQ',
      name: '开发工程师',
      readFrom: 3,
      seatKey: 'seat-key-secret',
      rulesPath: 'D:/Agent Room/rooms/rules.md',
      statePath: 'D:/Agent Room/rooms/HK4-TZQ-FWQ/codex-dev/state.md',
    });
    expect(prompt).toContain('已经加入');
    expect(prompt).toContain('禁止调用 room_join');
    expect(prompt).toContain('执行唤醒监听，动作游标=3');
    expect(prompt).toContain('AGENTS.md');
    expect(prompt).toContain('state.md');
    expect(prompt).toContain('AGENT_ROOM_SEAT_KEY');
    expect(prompt).toContain('追历史只用一次 timeoutMs:0');
    expect(prompt).toContain('默认 hold');
    expect(prompt).not.toContain('D:/Agent Room');
    expect(prompt).not.toContain('请阅读通用规则');
    expect(prompt).not.toContain('seat-key-secret');
    expect(prompt).not.toContain('since: 3');
    expect(launchPrompt('HK4-TZQ-FWQ', '开发工程师')).toContain('room_join({');
  });

  it('legacy without paths still embeds seatKey for older installs/tests', () => {
    const prompt = firstRunPrompt({
      code: 'HK4-TZQ-FWQ',
      name: '开发工程师',
      readFrom: 3,
      seatKey: 'seat-key-secret',
    });
    expect(prompt).toContain('room_listen');
    expect(prompt).toContain('room_sleep');
    expect(prompt).toContain('managed: { seatKey: "seat-key-secret" }');
    expect(prompt).toContain('since: 3');
    expect(prompt).toContain('AGENT_ROOM_SEAT_KEY');
  });
});

describe('reuseWakePrompt', () => {
  it('is a short human wake line with 动作游标 only (no seatKey)', () => {
    const short = reuseWakePrompt({
      code: 'HK4-TZQ-FWQ',
      name: '开发工程师',
      readFrom: 12,
      seatKey: 'seat-key-secret',
    });
    const full = wakePrompt({
      code: 'HK4-TZQ-FWQ',
      name: '开发工程师',
      readFrom: 12,
      seatKey: 'seat-key-secret',
    });
    expect(short).toBe('执行唤醒监听，动作游标=12');
    expect(short.length).toBeLessThan(full.length);
    expect(short).not.toContain('seatKey');
    expect(short).not.toContain('since:');
    expect(short).not.toContain('seat-key-secret');
  });
});

describe('wakePrompt with paths', () => {
  it('uses cwd-relative guidance and 动作游标 without absolute path reads', () => {
    const prompt = wakePrompt({
      code: 'ABC',
      name: 'codex-a',
      readFrom: 4,
      seatKey: 'seat-key-secret',
      rulesPath: '/rooms/rules.md',
      statePath: '/rooms/ABC/seat/state.md',
      gap: [1, 3],
    });
    expect(prompt).toContain('执行唤醒监听，动作游标=4');
    expect(prompt).toContain('AGENTS.md');
    expect(prompt).toContain('state.md');
    expect(prompt).toContain('追历史只用一次 timeoutMs:0');
    expect(prompt).toContain('第 1–2 条');
    expect(prompt).not.toContain('/rooms/rules.md');
    expect(prompt).not.toContain('seat-key-secret');
  });
});
