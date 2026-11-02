import { describe, expect, it } from 'vitest';
import {
  injectSeatKeyArgs,
  isPlaceholderSeatKey,
  managedMissingSeatKey,
  mcpHttpUrl,
  seatKeyFromAuthHeader,
  rewriteMcpPostBodyForSeatKey,
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


  it('replaces placeholder seatKey and fills code/name from env', () => {
    const rich = {
      AGENT_ROOM_MANAGED: '1',
      AGENT_ROOM_SEAT_KEY: 'sk_live_test_abc',
      AGENT_ROOM_CODE: 'ABC-DEF-GHJ',
      AGENT_ROOM_NAME: '开发工程师',
    };
    expect(isPlaceholderSeatKey('AGENT_ROOM_SEAT_KEY')).toBe(true);
    expect(injectSeatKeyArgs('room_listen', {
      since: 0,
      managed: { seatKey: 'AGENT_ROOM_SEAT_KEY' },
    }, rich)).toEqual({
      since: 0,
      code: 'ABC-DEF-GHJ',
      name: '开发工程师',
      managed: { seatKey: 'sk_live_test_abc' },
    });
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
  it('emits loopback url + bearer env (not stdio command)', () => {
    const overrides = codexMcpShimOverrides('http://127.0.0.1:17421/mcp-shim', 'agent-room');
    expect(overrides).toEqual([
      'mcp_servers.agent-room.url="http://127.0.0.1:17421/mcp-shim"',
      'mcp_servers.agent-room.bearer_token_env_var="AGENT_ROOM_SEAT_KEY"',
    ]);
  });

  it('rejects non-loopback shim urls', () => {
    expect(codexMcpShimOverrides('https://ai-room.pupgo.top/mcp-shim', 'agent-room')).toEqual([]);
  });

  it('prefers local HTTP shim over remote url when SHIM_URL set', () => {
    const approvals = [
      '-c', CODEX_SUPPRESS_UNSTABLE_FEATURES_WARNING,
      ...CODEX_MANAGED_MCP_NAMES.flatMap(name => ['-c', codexMcpApprovalArg(name)]),
    ];
    const args = managedApprovalArgs('codex', {
      AGENT_ROOM_SERVER: 'https://ai-room.pupgo.top',
      AGENT_ROOM_MCP_SHIM_URL: 'http://127.0.0.1:17421/mcp-shim',
    });
    expect(args.slice(0, approvals.length)).toEqual(approvals);
    expect(args.join('\n')).toContain('mcp_servers.agent-room.url="http://127.0.0.1:17421/mcp-shim"');
    expect(args.join('\n')).toContain('bearer_token_env_var="AGENT_ROOM_SEAT_KEY"');
    expect(args.join('\n')).not.toContain('url="https://ai-room.pupgo.top/mcp"');
    expect(args.join('\n')).not.toContain('mcp_servers.agent-room.command=');
  });
});

describe('HTTP mcp-shim body rewrite', () => {
  it('parses bearer and injects seatKey into tools/call', () => {
    expect(seatKeyFromAuthHeader('Bearer sk_abc')).toBe('sk_abc');
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'room_listen', arguments: { managed: {} } },
    });
    const out = rewriteMcpPostBodyForSeatKey(raw, 'sk_live');
    expect(out.injected).toBe(true);
    expect(out.timeoutMs).toBe(300_000);
    expect(JSON.parse(out.body).params.arguments.managed.seatKey).toBe('sk_live');
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
