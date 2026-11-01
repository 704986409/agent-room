import { describe, expect, it } from 'vitest';
import {
  injectSeatKeyArgs,
  managedMissingSeatKey,
  mcpHttpUrl,
} from './src/mcpSeatShim.ts';
import {
  codexMcpShimOverrides,
  managedApprovalArgs,
  CODEX_MANAGED_MCP_NAMES,
  CODEX_SUPPRESS_UNSTABLE_FEATURES_WARNING,
  codexMcpApprovalArg,
} from './src/adapter.ts';
import { isDaemonShimEntry } from './src/daemon.ts';

describe('mcpSeatShim injectSeatKeyArgs', () => {
  const env = {
    AGENT_ROOM_MANAGED: '1',
    AGENT_ROOM_SEAT_KEY: 'sk_live_test_abc',
  };

  it('fills managed.seatKey when room_listen sends managed:{}', () => {
    expect(injectSeatKeyArgs('room_listen', { code: 'X', managed: {} }, env)).toEqual({
      code: 'X',
      managed: { seatKey: 'sk_live_test_abc' },
    });
  });

  it('fills managed when room_listen omits managed entirely', () => {
    expect(injectSeatKeyArgs('room_listen', { code: 'X', name: 'dev' }, env)).toEqual({
      code: 'X',
      name: 'dev',
      managed: { seatKey: 'sk_live_test_abc' },
    });
  });

  it('preserves other managed fields and only fills blank seatKey', () => {
    expect(injectSeatKeyArgs('room_listen', {
      managed: { wakeRunId: 'w1', seatKey: '  ' },
    }, env)).toEqual({
      managed: { wakeRunId: 'w1', seatKey: 'sk_live_test_abc' },
    });
  });

  it('does not overwrite a non-empty seatKey', () => {
    expect(injectSeatKeyArgs('room_listen', {
      managed: { seatKey: 'already' },
    }, env)).toEqual({
      managed: { seatKey: 'already' },
    });
  });

  it('skips room_listen inject when not managed', () => {
    expect(injectSeatKeyArgs('room_listen', { managed: {} }, {
      AGENT_ROOM_SEAT_KEY: 'sk_live_test_abc',
    })).toEqual({ managed: {} });
  });

  it('fills room_sleep.seatKey when blank', () => {
    expect(injectSeatKeyArgs('room_sleep', { code: 'X', cursor: 3 }, env)).toEqual({
      code: 'X',
      cursor: 3,
      seatKey: 'sk_live_test_abc',
    });
    expect(injectSeatKeyArgs('room_sleep', { seatKey: '' }, env).seatKey).toBe('sk_live_test_abc');
  });

  it('leaves unrelated tools alone', () => {
    expect(injectSeatKeyArgs('room_join', { code: 'X' }, env)).toEqual({ code: 'X' });
  });

  it('mcpHttpUrl strips trailing slash', () => {
    expect(mcpHttpUrl('https://ai-room.pupgo.top/')).toBe('https://ai-room.pupgo.top/mcp');
  });

  it('managedMissingSeatKey detects {} and blanks', () => {
    expect(managedMissingSeatKey(undefined)).toBe(true);
    expect(managedMissingSeatKey({})).toBe(true);
    expect(managedMissingSeatKey({ seatKey: '' })).toBe(true);
    expect(managedMissingSeatKey({ seatKey: 'x' })).toBe(false);
  });
});

describe('codexMcpShimOverrides / managedApprovalArgs', () => {
  it('emits command/args and clears url', () => {
    const overrides = codexMcpShimOverrides(
      'C:\\Program Files\\nodejs\\node.exe',
      'D:\\Agent Room\\daemon\\agent-room-daemon.mjs',
      'agent-room',
    );
    expect(overrides).toEqual([
      'mcp_servers.agent-room.url=""',
      'mcp_servers.agent-room.command="C:\\\\Program Files\\\\nodejs\\\\node.exe"',
      'mcp_servers.agent-room.args=["D:\\\\Agent Room\\\\daemon\\\\agent-room-daemon.mjs", "mcp-shim"]',
    ]);
  });

  it('prefers shim over HTTP url when NODE+SHIM set', () => {
    const approvals = [
      '-c', CODEX_SUPPRESS_UNSTABLE_FEATURES_WARNING,
      ...CODEX_MANAGED_MCP_NAMES.flatMap(name => ['-c', codexMcpApprovalArg(name)]),
    ];
    const args = managedApprovalArgs('codex', {
      AGENT_ROOM_SERVER: 'https://ai-room.pupgo.top',
      AGENT_ROOM_NODE: '/usr/bin/node',
      AGENT_ROOM_MCP_SHIM: '/opt/agent-room-daemon.mjs',
    });
    expect(args.slice(0, approvals.length)).toEqual(approvals);
    expect(args.join('\n')).toContain('mcp_servers.agent-room.command="/usr/bin/node"');
    expect(args.join('\n')).toContain('mcp-shim');
    expect(args.join('\n')).not.toContain('url="https://ai-room.pupgo.top/mcp"');
    expect(args.join('\n')).toContain('mcp_servers.agent-room.url=""');
  });
});


describe('isDaemonShimEntry', () => {
  it('accepts packaged daemon and wake-agent index only', () => {
    expect(isDaemonShimEntry(String.raw`D:\Agent Room\daemon\agent-room-daemon.mjs`)).toBe(true);
    expect(isDaemonShimEntry('/home/box/MERYANG/agent-room-dev-grok/tools/wake-agent/src/index.ts')).toBe(true);
    expect(isDaemonShimEntry('/home/box/MERYANG/agent-room-dev-grok/node_modules/tinypool/dist/esm/entry/worker.js')).toBe(false);
    expect(isDaemonShimEntry('')).toBe(false);
  });
});
