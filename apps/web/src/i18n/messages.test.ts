import { describe, expect, it } from 'vitest';
import { getMessageKeys, messages, resolveLocale, translate } from './messages.js';
import { ROOM_TEMPLATES, localizedRoleLabel, localizedTemplate } from '../lib/templates.js';
import { ROLE_PRESETS } from '@agent-room/shared';

describe('web locale catalog', () => {
  it('keeps English and Chinese message keys and placeholders in parity', () => {
    const keys = getMessageKeys().slice().sort();
    expect(Object.keys(messages.en).sort()).toEqual(keys);
    expect(Object.keys(messages['zh-CN']).sort()).toEqual(keys);
    const placeholders = (value: string) => [...value.matchAll(/\{([a-zA-Z][\w]*)\}/g)].map(match => match[1]).sort();
    for (const key of keys) {
      expect(placeholders(messages['zh-CN'][key as keyof typeof messages['zh-CN']]), key)
        .toEqual(placeholders(messages.en[key as keyof typeof messages.en]));
    }
  });

  it('falls back to Chinese for missing or invalid stored locales', () => {
    expect(resolveLocale(null)).toBe('zh-CN');
    expect(resolveLocale('xx')).toBe('zh-CN');
    expect(resolveLocale('en')).toBe('en');
  });

  it('interpolates dynamic values without changing protocol text', () => {
    expect(translate('zh-CN', 'join.hostedBy', { name: 'QA-Host', count: 3 }))
      .toBe('主持人：QA-Host · 当前 3 人');
    expect(translate('en', 'join.hostedBy', { name: 'QA-Host', count: 3 }))
      .toBe('Hosted by QA-Host · 3 here');
  });

  it('localizes the human-facing agent notice while preserving MCP instructions', () => {
    expect(translate('zh-CN', 'mcp.agentNotice.humans')).toContain('请勿填写表单');
    expect(translate('zh-CN', 'mcp.agentNotice.join', {
      server: 'https://www.agent-room.com/mcp',
      args: '{ code, name: "QA-Worker" }',
    })).toContain('room_join');
    expect(translate('zh-CN', 'mcp.agentNotice.listen')).toContain('room_listen');
    expect(translate('zh-CN', 'mcp.agentNotice.english')).toContain('English:');
  });

  it('localizes all seven templates without changing their ids or role payloads', () => {
    expect(ROOM_TEMPLATES.map(template => template.id)).toEqual([
      'blank', 'code-review', 'feature-build', 'bug-fix', 'incident', 'strategy', 'delivery',
    ]);
    for (const template of ROOM_TEMPLATES) {
      const localized = localizedTemplate(template, 'zh-CN');
      const english = localizedTemplate(template, 'en');
      const prefix = `template.${template.id}`;
      expect(localized.id).toBe(template.id);
      expect(localized.label).toBe(translate('zh-CN', `${prefix}.label` as keyof typeof messages['zh-CN']));
      expect(localized.description).toBe(translate('zh-CN', `${prefix}.description` as keyof typeof messages['zh-CN']));
      expect(localized.topicSeed).toBe(translate('zh-CN', `${prefix}.topic` as keyof typeof messages['zh-CN']));
      expect(localized.openingMessage).toBe(translate('zh-CN', `${prefix}.opening` as keyof typeof messages['zh-CN']));
      expect(english.openingMessage).toBe(translate('en', `${prefix}.opening` as keyof typeof messages.en));
      expect(localized.suggestedRoleIds).toEqual(template.suggestedRoleIds);
      if (template.id !== 'blank') {
        for (const marker of ['[DECISION]', '[TODO]', '[STATUS]', '[RESULT]']) {
          expect(localized.openingMessage).toContain(marker);
          expect(english.openingMessage).toContain(marker);
        }
      }
    }
  });

  it('translates role labels while leaving role values unchanged', () => {
    for (const preset of ROLE_PRESETS) {
      expect(localizedRoleLabel(preset.id, 'zh-CN')).not.toBe(preset.role);
      expect(localizedRoleLabel(preset.id, 'en')).toBe(preset.label);
    }
  });
});
