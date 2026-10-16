import { useCallback, useRef, useState } from 'react';
import type { MessageAttachment } from '@agent-room/shared';
import { MAX_ATTACHMENTS_PER_MESSAGE, uploadAttachment } from '../lib/upload.js';

export interface PendingUpload { id: string; name: string }

interface UseAttachmentUploadsOptions {
  roomCode: string;
  /** More files were picked than the message has room for. */
  onLimit: (max: number) => void;
  /** One file failed to upload; its placeholder has already been dropped. */
  onFailure: (error: unknown) => void;
}

export interface AttachmentUploads {
  attachments: MessageAttachment[];
  pendingUploads: PendingUpload[];
  /** True from the moment files are picked until every upload settles. */
  uploading: boolean;
  addFiles: (files: FileList | File[]) => Promise<void>;
  removeAttachment: (id: string) => void;
  clear: () => void;
  restore: (items: MessageAttachment[]) => void;
}

let uploadSeq = 0;

/**
 * Owns the composer's attachment list plus the uploads still in flight.
 * A file occupies a slot (and a placeholder chip) from the instant it is
 * picked, so the composer can refuse to send until the upload finishes —
 * before this, a text-only message went out mid-upload and the finished
 * attachment leaked into whatever the user typed next.
 */
export function useAttachmentUploads({ roomCode, onLimit, onFailure }: UseAttachmentUploadsOptions): AttachmentUploads {
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  // Concurrent uploads each resolve on their own tick, so slot accounting
  // reads from refs instead of the render-time snapshot.
  const attachmentsRef = useRef<MessageAttachment[]>([]);
  const pendingRef = useRef<PendingUpload[]>([]);

  const writeAttachments = useCallback((next: (prev: MessageAttachment[]) => MessageAttachment[]) => {
    attachmentsRef.current = next(attachmentsRef.current);
    setAttachments(attachmentsRef.current);
  }, []);
  const writePending = useCallback((next: (prev: PendingUpload[]) => PendingUpload[]) => {
    pendingRef.current = next(pendingRef.current);
    setPendingUploads(pendingRef.current);
  }, []);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (!incoming.length) return;
    const used = attachmentsRef.current.length + pendingRef.current.length;
    const slots = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - used);
    const selected = incoming.slice(0, slots);
    if (incoming.length > slots) onLimit(MAX_ATTACHMENTS_PER_MESSAGE);
    if (!selected.length) return;

    const queued = selected.map(file => ({ id: `upload-${++uploadSeq}`, name: file.name, file }));
    writePending(prev => [...prev, ...queued.map(({ id, name }) => ({ id, name }))]);

    await Promise.all(queued.map(async ({ id, file }) => {
      try {
        const uploaded = await uploadAttachment(file, roomCode);
        writeAttachments(prev => [...prev, uploaded].slice(0, MAX_ATTACHMENTS_PER_MESSAGE));
      } catch (e) {
        onFailure(e);
      } finally {
        writePending(prev => prev.filter(item => item.id !== id));
      }
    }));
  }, [roomCode, onLimit, onFailure, writeAttachments, writePending]);

  const removeAttachment = useCallback((id: string) => {
    writeAttachments(prev => prev.filter(item => item.id !== id));
  }, [writeAttachments]);

  const clear = useCallback(() => {
    writeAttachments(() => []);
  }, [writeAttachments]);

  const restore = useCallback((items: MessageAttachment[]) => {
    writeAttachments(prev => [...items, ...prev].slice(0, MAX_ATTACHMENTS_PER_MESSAGE));
  }, [writeAttachments]);

  return {
    attachments,
    pendingUploads,
    uploading: pendingUploads.length > 0,
    addFiles,
    removeAttachment,
    clear,
    restore,
  };
}
