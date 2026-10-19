import { useCallback, useState } from 'react';
import { webSpeakGate, type Message, type MessageAttachment, type Room } from '@agent-room/shared';
import { colorForName, initialsFor } from '../../lib/colors.js';

/**
 * How a web participant puts a message in the room: build the message, hand it
 * to the room, and answer the two refusals that are not "try again" — a sender
 * with no seat, and a host message that deliver mode has to act on.
 *
 * Extracted from Room.tsx so every surface that sends (composer, voice) can
 * share one path instead of each carrying its own copy of these rules.
 *
 * `rejectedBySend` lives here because it is part of the same answer: it is set
 * when the server refuses a send for want of a seat, and only the rejoin it
 * points at clears it — the roster snapshot that let us try is the one thing
 * we now know to be wrong.
 */
export interface UseRoomSendOptions {
  code: string;
  room: Room | null;
  self: { name: string; role: string } | null;
  /** useRoom's optimistic send; rejects when the server refused the message. */
  sendMessage: (message: Message) => Promise<void>;
  forceRefresh: () => Promise<void>;
  reloadTaskBoard: () => Promise<void>;
}

export interface UseRoomSend {
  /**
   * Hands one message to the room. Rejects on failure so the caller can put
   * the draft (text + attachments) back where the user left it.
   */
  submitMessage: (body: string, attachments: MessageAttachment[]) => Promise<void>;
  /** The server refused a send because this viewer holds no seat. */
  rejectedBySend: boolean;
}

export function useRoomSend({
  room,
  self,
  sendMessage,
  forceRefresh,
  reloadTaskBoard,
}: UseRoomSendOptions): UseRoomSend {
  const [rejectedBySend, setRejectedBySend] = useState(false);

  const submitMessage = useCallback(async (body: string, attachments: MessageAttachment[]) => {
    // The surfaces that call this render only once the room and the stored
    // identity have resolved, so this narrows the types rather than guarding
    // a path a user can reach.
    if (!room || !self) return;
    const msg: Message = {
      id: Date.now(),
      type: 'msg',
      name: self.name,
      role: self.role,
      initials: initialsFor(self.name),
      color: colorForName(self.name),
      client: 'web',
      text: body,
      time: Date.now(),
      attachments: attachments.length ? attachments : undefined,
    };
    try {
      await sendMessage(msg);
    } catch (e) {
      // "You are not in this room" is not a failed send to retry — the
      // composer should not have been there at all. Resync the roster and
      // show the rejoin notice instead of a toast the user can only dismiss.
      if (e instanceof Error && e.name === 'NotParticipantError') {
        setRejectedBySend(true);
        await forceRefresh();
        return;
      }
      throw e;
    }
    // Deliver side effects run inside chat-send. Refresh the board once they land.
    if (webSpeakGate(room, self.name).isHost && (room.replyMode ?? 'open') === 'deliver') {
      await reloadTaskBoard().catch(() => { /* best-effort */ });
    }
  }, [room, self, sendMessage, forceRefresh, reloadTaskBoard]);

  return { submitMessage, rejectedBySend };
}

export interface VoiceTranscriptOptions {
  /** The transcript the mic just committed. */
  spoken: string;
  /** The composer draft as it stands. */
  draft: string;
  setDraft: (next: string) => void;
  submitMessage: UseRoomSend['submitMessage'];
  /**
   * A send that failed for a reason the user can retry past. Not called for
   * the refusals submitMessage answers itself (no seat), which resolve.
   */
  onSendFailed: (error: unknown) => void;
}

/**
 * The voice button's send: one spoken turn, through the composer's own path.
 *
 * A typed draft is merged in front of the transcript, because the user who
 * typed half a sentence and then said the rest meant one message. Attachments
 * are not: voice sends text only and never waits on the composer's uploads, so
 * a file still being staged stays staged and rides along with whatever the
 * user types next. The composer keeps its own upload gate for that reason —
 * there it IS the message the attachment belongs to.
 */
export async function sendVoiceTranscript({
  spoken,
  draft,
  setDraft,
  submitMessage,
  onSendFailed,
}: VoiceTranscriptOptions): Promise<void> {
  const said = spoken.trim();
  if (!said) return;
  const typed = draft.trim();
  const merged = typed ? `${typed} ${said}` : said;
  setDraft('');
  try {
    await submitMessage(merged, []);
  } catch (e) {
    setDraft(merged); // restore the draft so the user can retry
    onSendFailed(e);
  }
}
