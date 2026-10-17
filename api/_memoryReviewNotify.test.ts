// The room event that a shared-memory proposal posts, as text and as a message.
//
// Everything here is about what a reviewer can act on without a second call:
// the proposalId, the kind of change, who asked, and the exact memory_review
// invocation. And about what must NOT be in it — no seatKey/hostKey, no memory
// body, and no `@` the proposer wrote, which would otherwise let a title pick
// who gets woken.

import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@agent-room/shared';
import {
  buildMemoryReviewOutcomeNoticeMessage,
  buildMemoryReviewNoticeMessage,
  buildMemoryReviewNoticeText,
  deliverMemoryReviewNotice,
  type MemoryReviewNotice,
} from './_memoryReviewNotify.js';

const PROPOSAL_ID = '0f6f1f3e-4b4e-4a0a-9a5a-6e1a0c2d3b4f';

function notice(overrides: Partial<MemoryReviewNotice> = {}): MemoryReviewNotice {
  return {
    proposalId: PROPOSAL_ID,
    kind: 'create',
    recipientNames: ['Project Analyst'],
    proposerName: 'Agent A',
    title: 'Shared decision',
    preview: 'The room keeps the shared index.',
    ...overrides,
  };
}

describe('memory review notice text', () => {
  it('tells the reviewer what was proposed and how to decide it', () => {
    const text = buildMemoryReviewNoticeText(notice());
    expect(text).toContain('@Project Analyst');
    expect(text).toContain(PROPOSAL_ID);
    expect(text).toContain('(create)');
    expect(text).toContain('Agent A proposes a shared room memory');
    expect(text).toContain('title: "Shared decision".');
    expect(text).toContain('preview: "The room keeps the shared index.".');
    expect(text).toContain(`memory_review({ action: "approve", proposalId: "${PROPOSAL_ID}" })`);
    expect(text).toContain('无关记忆" | "重复记忆" | "格式不合规');
  });

  it('addresses every recipient and keeps the update/delete kinds distinct', () => {
    const text = buildMemoryReviewNoticeText(notice({
      kind: 'delete', recipientNames: ['Project Analyst', 'Analyst Two'], title: undefined, preview: undefined,
    }));
    expect(text).toContain('@Project Analyst @Analyst Two');
    expect(text).toContain('(delete)');
    expect(text).not.toContain('title:');
    expect(text).not.toContain('preview:');
    expect(buildMemoryReviewNoticeText(notice({ kind: 'update' }))).toContain('(update)');
  });

  it('says the host is deciding when no reviewer seat is online', () => {
    const text = buildMemoryReviewNoticeText(notice({ recipientNames: ['Host'], ownerFallback: true }));
    expect(text).toContain('@Host');
    expect(text).toContain('No reviewer seat is online');
    expect(buildMemoryReviewNoticeText(notice())).not.toContain('No reviewer seat is online');
  });

  // A title is author-written text going into a room line that routes wakes.
  it('redacts secrets, flattens newlines, and strips proposer-written mentions', () => {
    const text = buildMemoryReviewNoticeText(notice({
      title: 'token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      preview: 'line one\nline two @Host @Analyst Two',
    }));
    expect(text).not.toContain('sk-ant-api03-AAAA');
    expect(text).not.toContain('\n');
    expect(text).not.toContain('@Host');
    expect(text).not.toContain('@Analyst Two');
    expect(text).toContain('@Project Analyst');
  });

  it('caps the title and preview it quotes', () => {
    const text = buildMemoryReviewNoticeText(notice({ title: 'T'.repeat(400), preview: 'P'.repeat(400) }));
    expect(text).toContain(`title: "${'T'.repeat(120)}".`);
    expect(text).toContain(`preview: "${'P'.repeat(180)}".`);
  });
});

describe('review outcome notice', () => {
  it('shows the rejection reason and reviewer name to the proposer', () => {
    const message = buildMemoryReviewOutcomeNoticeMessage({
      status: 'rejected', proposerName: 'Agent A', reviewerName: 'Jev',
      title: '部署规则', reason: '重复记忆',
    }, 1_700_000_000_002);
    expect(message.text).toBe('@Agent A 记忆提议被驳回（重复记忆）：部署规则（审核员：Jev）');
  });
});

describe('memory review notice message', () => {
  it('is a system event, not a participant taking a turn', () => {
    const message = buildMemoryReviewNoticeMessage(notice(), 1_700_000_000_000);
    expect(message).toMatchObject({
      id: 1_700_000_000_000,
      time: 1_700_000_000_000,
      type: 'sys',
      name: 'system',
      client: 'cc',
      role: 'System',
    });
    expect(message.text).toContain(PROPOSAL_ID);
  });
});

describe('deliverMemoryReviewNotice', () => {
  it('appends the notice to the room and reports delivery', async () => {
    const append = vi.fn(async (_code: string, _message: Message) => ({ appended: true }));
    expect(await deliverMemoryReviewNotice(append, 'AAA-BBB-CCC', notice())).toBe(true);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith('AAA-BBB-CCC', expect.objectContaining({ type: 'sys' }));
    expect(append.mock.calls[0]![1].text).toContain('@Project Analyst');
  });

  it('swallows an append failure, logs without secrets, and reports undelivered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const append = vi.fn(async (_code: string, _message: Message): Promise<unknown> => {
        throw new Error('seatKey abc never belongs in a log');
      });
      expect(await deliverMemoryReviewNotice(append, 'AAA-BBB-CCC', notice())).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]![0]);
      expect(logged).toContain(PROPOSAL_ID);
      expect(logged).not.toContain('seatKey abc');
    } finally {
      warn.mockRestore();
    }
  });

  it('posts nothing when no recipient could be named', async () => {
    const append = vi.fn(async (_code: string, _message: Message) => ({ appended: true }));
    expect(await deliverMemoryReviewNotice(append, 'AAA-BBB-CCC', notice({ recipientNames: [] }))).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });
});
