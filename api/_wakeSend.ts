import type { UpstashClient } from '@agent-room/upstash-client';
import { setMessageCommittedHook } from '@agent-room/upstash-client';
import { generateForCommittedMessage } from './_wakeService.js';

type CommandClient = Pick<UpstashClient, 'command'>;

/**
 * Installs the send-path wake hook on this process. Event generation uses the
 * same SET NX key as the scan fallback; a hook failure leaves the scan cursor
 * unmoved so the next poll or patrol can replay the message.
 */
export function installWakeSendHook(client: CommandClient): void {
  setMessageCommittedHook(async event => {
    try {
      await generateForCommittedMessage(client, event.code, event.index, event.message);
    } catch {
      // Scan fallback covers a crash between the message write and the event write.
    }
  });
}
