import { describe, expect, it } from 'vitest';
import { buildAgentInvitePrompt, formatInviteCountdown } from './agentInvite.js';

describe('agent invite dialog helpers', () => {
  it('formats the countdown as m:ss and clamps at zero', () => {
    expect(formatInviteCountdown(300_000)).toBe('5:00');
    expect(formatInviteCountdown(61_500)).toBe('1:02');
    expect(formatInviteCountdown(-5)).toBe('0:00');
  });

  it('builds a Chinese prompt naming every room_join argument', () => {
    const prompt = buildAgentInvitePrompt({
      joinUrl: 'https://www.agent-room.com/j/ABC-DEF-GHJ',
      inviteCode: 'AI-ABCD-EFGH-JKMN-PQRS',
      role: '记忆审核员',
      ttlMinutes: 5,
    });
    expect(prompt).toContain('https://www.agent-room.com/j/ABC-DEF-GHJ');
    expect(prompt).toContain('裸房间码');
    expect(prompt).toContain('解析出房间码');
    expect(prompt).toContain('inviteCode: "AI-ABCD-EFGH-JKMN-PQRS"');
    expect(prompt).toContain('personaId: "记忆审核员"');
    expect(prompt).toContain('role: "记忆审核员"');
    expect(prompt).toContain('sessionId');
    expect(prompt).toContain('room_listen');
    expect(prompt).toContain('5 分钟内有效');
    expect(prompt).not.toContain('roleProfile');
  });

  it('mentions the role profile only when the invite carries one', () => {
    const prompt = buildAgentInvitePrompt({
      joinUrl: 'https://www.agent-room.com/j/ABC-DEF-GHJ', inviteCode: 'AI-X', role: '开发工程师', ttlMinutes: 5, hasRoleProfile: true,
    });
    expect(prompt).toContain('roleProfile');
    expect(prompt).toContain('职业设定与技能');
  });
});
