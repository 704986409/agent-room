import { describe, expect, it } from 'vitest';
import { resolveTerminalMode, shouldEmbedTerminal } from './src/terminalMode.js';
import {
  createAgyAdapter,
  createCursorAdapter,
  resolveManagedSpawnKind,
  type ProcessSpawner,
  type SpawnedProcess,
} from './src/adapter.js';

describe('resolveTerminalMode', () => {
  it('defaults to embedded when unset', () => {
    expect(resolveTerminalMode({})).toBe('embedded');
    expect(resolveTerminalMode({ AGENT_ROOM_TERMINAL: '' })).toBe('embedded');
    expect(resolveTerminalMode({ AGENT_ROOM_TERMINAL: 'embedded' })).toBe('embedded');
    expect(resolveTerminalMode({ AGENT_ROOM_TERMINAL: 'EMBEDDED' })).toBe('embedded');
    expect(resolveTerminalMode({ AGENT_ROOM_TERMINAL: 'anything-else' })).toBe('embedded');
  });

  it('selects system only for AGENT_ROOM_TERMINAL=system', () => {
    expect(resolveTerminalMode({ AGENT_ROOM_TERMINAL: 'system' })).toBe('system');
    expect(resolveTerminalMode({ AGENT_ROOM_TERMINAL: 'System' })).toBe('system');
    expect(resolveTerminalMode({ AGENT_ROOM_TERMINAL: ' system ' })).toBe('system');
  });
});

describe('shouldEmbedTerminal / resolveManagedSpawnKind', () => {
  it('embeds when mode is embedded and terminalTitle is set', () => {
    expect(shouldEmbedTerminal({ terminalTitle: 'Agent Room · codex' }, {})).toBe(true);
    expect(shouldEmbedTerminal({ terminalTitle: 't' }, { AGENT_ROOM_TERMINAL: 'embedded' })).toBe(true);
    expect(shouldEmbedTerminal({}, {})).toBe(false);
    expect(shouldEmbedTerminal({ terminalTitle: 't' }, { AGENT_ROOM_TERMINAL: 'system' })).toBe(false);
  });

  it('does not choose system wrap argv when embedded', () => {
    expect(resolveManagedSpawnKind({ terminalTitle: 'Agent Room · codex' }, {})).toBe('embedded');
    expect(resolveManagedSpawnKind({ terminalTitle: 't' }, { AGENT_ROOM_TERMINAL: 'system' }, 'win32')).toBe('system-wrap');
    expect(resolveManagedSpawnKind({ terminalTitle: 't' }, { AGENT_ROOM_TERMINAL: 'system', DISPLAY: ':0' }, 'linux')).toBe('system-wrap');
    expect(resolveManagedSpawnKind({}, {})).toBe('direct');
  });

  it('embeds cursor-agent and agy unless AGENT_ROOM_TERMINAL=system', () => {
    expect(resolveManagedSpawnKind({ terminalTitle: 'Agent Room · cursor-agent' }, {})).toBe('embedded');
    expect(resolveManagedSpawnKind({ terminalTitle: 'Agent Room · agy' }, {})).toBe('embedded');
    expect(shouldEmbedTerminal({ terminalTitle: 'Agent Room · cursor-agent' }, {})).toBe(true);
    expect(shouldEmbedTerminal({ terminalTitle: 'Agent Room · agy' }, {})).toBe(true);
    expect(resolveManagedSpawnKind(
      { terminalTitle: 'Agent Room · cursor-agent' },
      { AGENT_ROOM_TERMINAL: 'system' },
      'win32',
    )).toBe('system-wrap');
    expect(resolveManagedSpawnKind(
      { terminalTitle: 'Agent Room · agy' },
      { AGENT_ROOM_TERMINAL: 'system' },
      'win32',
    )).toBe('system-wrap');
    expect(shouldEmbedTerminal(
      { terminalTitle: 'Agent Room · agy' },
      { AGENT_ROOM_TERMINAL: 'system' },
    )).toBe(false);
  });

  it('sets terminalTitle from the adapter id for cursor-agent and agy', async () => {
    const titles: string[] = [];
    const spawner: ProcessSpawner = {
      spawn(_command, _args, opts): SpawnedProcess {
        titles.push(opts.terminalTitle ?? '');
        return {
          pid: 1,
          stdout: (async function* () { /* no session json */ })(),
          exited: Promise.resolve(0),
        };
      },
    };
    const launch = {
      cwd: '/work',
      env: { AGENT_ROOM_MANAGED: '1' },
      prompt: 'hello room',
    };
    const cursor = createCursorAdapter(spawner, {
      createChat: async () => '22222222-2222-4222-8222-222222222222',
    });
    await cursor.launch({ ...launch, model: 'grok-4.7' });
    const agy = createAgyAdapter(spawner, {
      waitAgyConversation: async () => '33333333-3333-4333-8333-333333333333',
    });
    await agy.launch({ ...launch, model: 'gemini-3.8-flash-high' });
    expect(titles).toEqual(['Agent Room · cursor-agent', 'Agent Room · agy']);
  });
});
