// The one send path, from both surfaces that use it.
//
// The voice button used to build its own message and catch its own errors, so
// a spoken reply from someone whose seat had gone missing got a generic "send
// failed" toast instead of the rejoin notice the composer would have shown for
// the very same refusal. Both now go through submitMessage, and these tests
// pin the three outcomes that differ: delivered, refused for want of a seat,
// and failed for a reason the user can retry past.

import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webSpeakGate, type Message, type Room } from '@agent-room/shared';
import { sendVoiceTranscript, useRoomSend, type UseRoomSend } from './useRoomSend.js';

vi.mock('../../env.js', () => ({
  ENV: { upstash: { url: 'http://redis-rest-web', token: 'voice-test-token' } },
}));

const self = { name: 'Alex', role: 'host' };

const room: Room = {
  code: 'ABC-DEF-GHJ',
  topic: 'Voice send',
  createdAt: 1,
  createdBy: 'Alex',
  status: 'active',
  version: 1,
  replyMode: 'open',
  participants: [
    { name: 'Alex', role: 'host', color: '#000', initials: 'AL', client: 'web', joinedAt: 0, lastSeenAt: 0, canSpeak: true },
  ],
};

const notParticipant = () => {
  const error = new Error('You are not in this room.');
  error.name = 'NotParticipantError';
  return error;
};

const sendMessage = vi.fn<[Message], Promise<void>>();
const forceRefresh = vi.fn(async () => {});
const reloadTaskBoard = vi.fn(async () => {});

/**
 * Renders the hook and keeps the latest value of what it returns, so a test
 * can call submitMessage and then read rejectedBySend after the re-render.
 */
function mountHook(): () => UseRoomSend {
  let latest!: UseRoomSend;
  function Probe() {
    latest = useRoomSend({ code: room.code, room, self, sendMessage, forceRefresh, reloadTaskBoard });
    return null;
  }
  act(() => { create(<Probe />); });
  return () => latest;
}

beforeEach(() => {
  sendMessage.mockReset();
  forceRefresh.mockReset();
  reloadTaskBoard.mockReset();
  sendMessage.mockResolvedValue(undefined);
});

describe('submitMessage', () => {
  it('hands the message to the room', async () => {
    const hook = mountHook();
    await act(async () => { await hook().submitMessage('Shipping now.', []); });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ name: 'Alex', client: 'web', text: 'Shipping now.' }));
    expect(hook().rejectedBySend).toBe(false);
  });

  it('rejects on a generic failure so the caller can put the draft back', async () => {
    const hook = mountHook();
    sendMessage.mockRejectedValue(new Error('Upstash HTTP 500'));

    await expect(act(async () => { await hook().submitMessage('Shipping now.', []); }))
      .rejects.toThrow('Upstash HTTP 500');
    expect(hook().rejectedBySend).toBe(false);
  });

  it('answers a seatless sender with the rejoin notice instead of an error', async () => {
    const hook = mountHook();
    sendMessage.mockRejectedValue(notParticipant());

    await act(async () => { await hook().submitMessage('Shipping now.', []); });

    expect(hook().rejectedBySend).toBe(true);
    expect(forceRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('the voice button', () => {
  const voice = async (over: Partial<Parameters<typeof sendVoiceTranscript>[0]> = {}) => {
    const hook = mountHook();
    const draft = { value: over.draft ?? '' };
    const onSendFailed = vi.fn();
    await act(async () => {
      await sendVoiceTranscript({
        spoken: 'Shipping now.',
        submitMessage: hook().submitMessage,
        onSendFailed,
        ...over,
        draft: draft.value,
        setDraft: (next) => { draft.value = next; },
      });
    });
    return { hook, draft, onSendFailed };
  };

  it('sends a spoken turn through the shared path, text only', async () => {
    const { draft, onSendFailed } = await voice();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Shipping now.',
      client: 'web',
      attachments: undefined,
    }));
    expect(draft.value).toBe('');
    expect(onSendFailed).not.toHaveBeenCalled();
  });

  it('merges a typed draft in front of the transcript', async () => {
    await voice({ draft: '  Status: ' });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'Status: Shipping now.' }));
  });

  it('sends nothing for an empty transcript', async () => {
    const { draft } = await voice({ spoken: '   ', draft: 'kept' });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(draft.value).toBe('kept');
  });

  // The whole point of the shared path: no generic toast, and the composer is
  // replaced by the not-member notice — the same reason the gate would give.
  it('shows the not-member notice for a seatless speaker, with no send-failed toast', async () => {
    sendMessage.mockRejectedValue(notParticipant());

    const { hook, draft, onSendFailed } = await voice();

    expect(onSendFailed).not.toHaveBeenCalled();
    expect(hook().rejectedBySend).toBe(true);
    // Room.tsx's blockedReason line, which is what renders SpeakBlockedNotice.
    const blockedReason = webSpeakGate(room, self.name).blockedReason
      ?? (hook().rejectedBySend ? 'not_member' : null);
    expect(blockedReason).toBe('not_member');
    expect(draft.value).toBe('');
  });

  it('restores the draft and reports a generic failure', async () => {
    sendMessage.mockRejectedValue(new Error('Upstash HTTP 500'));

    const { draft, onSendFailed } = await voice({ draft: 'Status:' });

    expect(onSendFailed).toHaveBeenCalledTimes(1);
    expect((onSendFailed.mock.calls[0][0] as Error).message).toBe('Upstash HTTP 500');
    expect(draft.value).toBe('Status: Shipping now.');
  });
});
