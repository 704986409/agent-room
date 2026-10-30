import { describe, expect, it } from 'vitest';
import { clearDetectCache } from './src/detectCache.js';
import {
  clearLiveModels,
  getLiveModels,
  parseAgyModels,
  parseCodexDebugModels,
  parseCursorListModels,
  refreshAdapterModels,
  setLiveModels,
} from './src/modelsList.js';
import type { LauncherAdapter } from './src/adapter.js';

describe('modelsList parsers', () => {
  it('parses cursor-agent --list-models lines', () => {
    const text = `Available models

auto - Auto (default)
grok-4.7-medium - Grok 4.7 Medium
grok-4.7-high - Grok 4.7 High
`;
    expect(parseCursorListModels(text)).toEqual(['auto', 'grok-4.7-medium', 'grok-4.7-high']);
  });

  it('parses agy models TSV', () => {
    const text = [
      'Fetching available models...',
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
      '',
    ].join('\n');
    expect(parseAgyModels(text)).toEqual([
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-low',
    ]);
  });

  it('parses codex debug models JSON and refreshes adapter allowlist', async () => {
    const json = JSON.stringify({
      models: [{ slug: 'gpt-6-sol' }, { slug: 'gpt-6-luna' }, { slug: 'default' }],
    });
    expect(parseCodexDebugModels(json)).toEqual(['gpt-6-sol', 'gpt-6-luna', 'default']);
    clearLiveModels();
    clearDetectCache();
    let models: readonly string[] = ['default', 'gpt-6-sol'];
    const adapter: LauncherAdapter = {
      id: 'codex',
      command: 'codex',
      get models() { return models; },
      setModels(next) { models = next; },
      async detect() { return { installed: true, path: '/bin/codex' }; },
      async launch() { throw new Error('no'); },
      async resume() { throw new Error('no'); },
      parseSessionId() { return undefined; },
      launchArgv() { return []; },
      resumeArgv() { return []; },
    };
    await refreshAdapterModels([adapter], async (id) => {
      expect(id).toBe('codex');
      return ['default', 'gpt-6-sol', 'gpt-6-luna'];
    });
    expect(getLiveModels('codex')).toEqual(['default', 'gpt-6-sol', 'gpt-6-luna']);
    expect(adapter.models).toEqual(['default', 'gpt-6-sol', 'gpt-6-luna']);
    clearLiveModels();
    clearDetectCache();
    expect(getLiveModels('codex')).toBeUndefined();
  });

  it('setLiveModels ignores empty', () => {
    clearLiveModels();
    clearDetectCache();
    setLiveModels('agy', []);
    expect(getLiveModels('agy')).toBeUndefined();
    setLiveModels('agy', ['gemini-3.8-flash-high']);
    expect(getLiveModels('agy')).toEqual(['gemini-3.8-flash-high']);
    clearLiveModels();
    clearDetectCache();
  });
});
