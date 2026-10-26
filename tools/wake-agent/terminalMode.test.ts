import { describe, expect, it } from 'vitest';
import { resolveTerminalMode, shouldEmbedTerminal } from './src/terminalMode.js';
import { resolveManagedSpawnKind } from './src/adapter.js';

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
});
