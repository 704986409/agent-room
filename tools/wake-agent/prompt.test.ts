import { describe, expect, it } from 'vitest';
import { firstRunPrompt, launchPrompt } from './src/prompt.js';

describe('firstRunPrompt', () => {
  const prompt = firstRunPrompt({
    code: 'HK4-TZQ-FWQ',
    name: '开发工程师',
    readFrom: 3,
    seatKey: 'seat-key-secret',
  });

  it('states the seat is already joined and forbids room_join', () => {
    expect(prompt).toContain('已经加入');
    expect(prompt).toContain('禁止调用 room_join');
    expect(prompt).toContain('不要向用户索要邀请码');
    expect(prompt).not.toContain('调用 room_join({');
    expect(launchPrompt('HK4-TZQ-FWQ', '开发工程师')).toContain('room_join({');
  });

  it('still tells the seat to listen with its seatKey and then sleep', () => {
    expect(prompt).toContain('room_listen');
    expect(prompt).toContain('room_sleep');
    expect(prompt).toContain('managed: { seatKey: "seat-key-secret" }');
    expect(prompt).toContain('since: 3');
    expect(prompt).not.toContain('AGENT_ROOM_SEAT_KEY');
  });
});
