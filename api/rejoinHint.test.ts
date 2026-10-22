import { describe, expect, it } from 'vitest';
import { REJOIN_RECENT_HINT, rejoinRecentFields } from './_mcpListen.js';

describe('rejoin recentMessages hint', () => {
  it('marks recent messages as context and tells the agent not to redo completed mentions', () => {
    expect(rejoinRecentFields(false)).toEqual({});
    expect(rejoinRecentFields(true)).toEqual({ recentMessagesHint: REJOIN_RECENT_HINT });
    expect(REJOIN_RECENT_HINT).toContain('上下文');
    expect(REJOIN_RECENT_HINT).toContain('已经完成的 @');
    expect(REJOIN_RECENT_HINT).toContain('不要');
  });
});
