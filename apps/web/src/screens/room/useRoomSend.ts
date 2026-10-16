import { useCallback, useState } from 'react';
import { webSpeakGate, type Message, type MessageAttachment, type Room } from '@agent-room/shared';
import { createClient, onDeliverHostMessage } from '@agent-room/upstash-client';
import { ENV } from '../../env.js';
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
  code,
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
    // Deliver: the host's message is either the go for a waiting plan
    // ("Start" / 开工) or a goal the lead should plan for.
    if (webSpeakGate(room, self.name).isHost && (room.replyMode ?? 'open') === 'deliver') {
      void onDeliverHostMessage(createClient(ENV.upstash), code, room, body)
        .then(() => reloadTaskBoard())
        .catch(() => { /* best-effort */ });
    }
  }, [code, room, self, sendMessage, forceRefresh, reloadTaskBoard]);

  return { submitMessage, rejectedBySend };
}
