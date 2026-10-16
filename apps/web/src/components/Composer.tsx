import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode, type RefObject } from 'react';
import type { MessageAttachment } from '@agent-room/shared';
import { useLocale } from '../i18n/LocaleProvider.js';
import { useAttachmentUploads } from '../hooks/useAttachmentUploads.js';
import { ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENTS_PER_MESSAGE, UploadError, formatBytes } from '../lib/upload.js';
import { showToast } from './Toast.js';

// Cap auto-grow at ~8 lines so the input never eats the whole feed.
export const TEXTAREA_MAX_HEIGHT = 200;
export const TEXTAREA_MIN_HEIGHT = 42;

interface ComposerProps {
  roomCode: string;
  text: string;
  onTextChange: (next: string) => void;
  /** Drop of plain text / a link: appended to the draft instead of uploaded. */
  onAppendText: (value: string) => void;
  /** Rejects when the message could not be delivered; the draft is restored. */
  onSubmit: (body: string, attachments: MessageAttachment[]) => Promise<void>;
  ended: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement>;
  /** Room-level notice rendered above the attachment row (e.g. muted count). */
  banner?: ReactNode;
  /** Agent chips / prompt shortcuts. */
  deck?: ReactNode;
  /** Extra controls next to the attach button (voice input). */
  tools?: ReactNode;
}

/**
 * The message box: draft text, attachments, and the send gate. Sending is
 * blocked while an upload is in flight, so an attachment can no longer land
 * in the room after the message it belonged to.
 */
export function Composer({
  roomCode,
  text,
  onTextChange,
  onAppendText,
  onSubmit,
  ended,
  textareaRef,
  banner,
  deck,
  tools,
}: ComposerProps) {
  const { t } = useLocale();
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onLimit = useCallback((count: number) => {
    showToast(t('room.attachLimit', { count }), 'info');
  }, [t]);
  const onFilenameTooLong = useCallback(() => {
    showToast(t('upload.filenameTooLong'), 'error');
  }, [t]);
  const onFailure = useCallback((e: unknown) => {
    // The server's own message for this one is Chinese-only; the user gets
    // the same sentence the preflight shows, in their locale.
    if (e instanceof UploadError && e.code === 'filename_too_long') {
      showToast(t('upload.filenameTooLong'), 'error');
      return;
    }
    showToast(t('room.attachmentFailed', { error: e instanceof Error ? e.message : t('common.unknownError') }), 'error');
  }, [t]);
  const uploads = useAttachmentUploads({ roomCode, onLimit, onFilenameTooLong, onFailure });
  const { attachments, pendingUploads, uploading } = uploads;

  async function addFiles(files: FileList | File[]) {
    await uploads.addFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function send() {
    if (ended) return;
    // An attachment that is still uploading belongs to this message, not to
    // the next one — make the user wait instead of sending the text alone.
    if (uploading) {
      showToast(t('room.uploadPending'), 'info');
      return;
    }
    const body = text.trim();
    if (!body && attachments.length === 0) return;
    const sent = attachments;
    onTextChange('');
    uploads.clear();
    try {
      await onSubmit(body, sent);
    } catch (e) {
      showToast(t('room.sendFailed', { error: e instanceof Error ? e.message : t('common.unknownError') }), 'error');
      onTextChange(body); // restore draft
      uploads.restore(sent);
    }
  }

  async function fileFromUrl(url: string): Promise<File | null> {
    try {
      const parsed = new URL(url);
      const resp = await fetch(parsed.toString());
      if (!resp.ok) return null;
      const blob = await resp.blob();
      if (!ALLOWED_ATTACHMENT_TYPES.has(blob.type)) return null;
      const pathName = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? 'attachment');
      const fallbackName = blob.type.startsWith('image/') ? 'image' : 'attachment';
      const name = pathName.includes('.') ? pathName : `${fallbackName}.${blob.type.split('/')[1] ?? 'bin'}`;
      return new File([blob], name, { type: blob.type });
    } catch {
      return null;
    }
  }

  async function filesFromDrop(dataTransfer: DataTransfer, uri: string): Promise<File[]> {
    const droppedFiles = Array.from(dataTransfer.files);
    if (droppedFiles.length > 0) return droppedFiles;
    if (!uri) return [];
    const file = await fileFromUrl(uri);
    return file ? [file] : [];
  }

  function handleDragEnter(e: DragEvent<HTMLElement>) {
    if (ended) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(e: DragEvent<HTMLElement>) {
    if (ended) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }

  function handleDragLeave(e: DragEvent<HTMLElement>) {
    if (ended) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  async function handleDrop(e: DragEvent<HTMLElement>) {
    if (ended) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);

    const uri = e.dataTransfer.getData('text/uri-list').split('\n').find(line => line && !line.startsWith('#')) ?? '';
    const plainText = e.dataTransfer.getData('text/plain');
    const files = await filesFromDrop(e.dataTransfer, uri);
    if (files.length > 0) {
      await addFiles(files);
      return;
    }

    const textValue = plainText || uri;
    if (textValue.trim()) onAppendText(textValue.trim());
  }

  async function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files).filter(file => file.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    await addFiles(files);
  }

  const slotsFull = attachments.length + pendingUploads.length >= MAX_ATTACHMENTS_PER_MESSAGE;

  return (
    <div
      className={`relative min-w-0 border-t border-border-faint p-2.5 sm:p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-surface flex flex-col gap-2 transition ${dragActive ? 'ring-2 ring-inset ring-accent bg-accent-tint/40' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={e => { void handleDrop(e); }}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-surface/90 text-sm font-semibold text-accent shadow-sm">
          {t('room.releaseToAttach')}
        </div>
      )}
      {banner}
      {(attachments.length > 0 || pendingUploads.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {attachments.map(attachment => (
            <PendingAttachment
              key={attachment.id}
              attachment={attachment}
              onRemove={() => uploads.removeAttachment(attachment.id)}
            />
          ))}
          {pendingUploads.map(pending => (
            <UploadingAttachment key={pending.id} name={pending.name} />
          ))}
        </div>
      )}
      {deck}
      <div className="flex flex-col sm:flex-row sm:items-end gap-2">
        <div className="relative flex-1 min-w-0">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => onTextChange(e.target.value)}
            onPaste={e => { void handlePaste(e); }}
            onKeyDown={e => {
              // Desktop: Enter sends; Shift+Enter for new line.
              // Mobile touch: let Enter insert a newline so user can type freely without accidental send.
              const isTouch = typeof window !== 'undefined'
                && ('ontouchstart' in window || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));
              if (!isTouch && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t('room.messagePlaceholder')}
            rows={1}
            style={{ height: TEXTAREA_MIN_HEIGHT, maxHeight: TEXTAREA_MAX_HEIGHT }}
            className="w-full resize-none overflow-y-auto px-3.5 py-2.5 bg-surface-softer border border-border rounded-xl text-base sm:text-sm leading-relaxed outline-none focus:border-accent focus:ring-2 focus:ring-accent-tint"
          />
        </div>
        <div className="flex items-center justify-between sm:justify-start gap-2 shrink-0">
          <div className="flex items-center gap-1.5">
            {tools}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              accept={Array.from(ALLOWED_ATTACHMENT_TYPES).join(',')}
              onChange={e => { if (e.target.files) void addFiles(e.target.files); }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || slotsFull}
              title={t('room.attachFiles')}
              className="h-10 w-10 sm:h-9 sm:w-auto justify-center rounded-lg bg-surface-softer border border-border sm:px-2 text-xs font-semibold text-ink-muted disabled:opacity-50 flex items-center gap-1.5 active:scale-95 transition"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13 7.5v3a4 4 0 0 1-8 0v-5a2.5 2.5 0 0 1 5 0v5a1 1 0 0 1-2 0v-4.5" />
              </svg>
              <span className="hidden sm:inline sm:text-xs">{uploading ? t('room.uploading') : t('room.attachFiles')}</span>
            </button>
          </div>
          <button
            onClick={() => { void send(); }}
            disabled={uploading || (!text.trim() && attachments.length === 0)}
            aria-label={t('room.send')}
            aria-busy={uploading || undefined}
            className="min-h-[40px] sm:min-h-[36px] min-w-[78px] sm:min-w-[64px] bg-accent text-white px-5 sm:px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 transition shadow-sm flex items-center justify-center gap-1.5"
          >
            {uploading ? (
              <>
                <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />
                <span>{t('room.uploading')}</span>
              </>
            ) : (
              <>
                <span>{t('room.send')}</span>
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
                  <path d="M1.5 1.5l13 6.5-13 6.5 2-6.5-2-6.5zm3.2 6.5h5.8-5.8z" />
                </svg>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function PendingAttachment({ attachment, onRemove }: { attachment: MessageAttachment; onRemove: () => void }) {
  const { t } = useLocale();
  return (
    <div className="flex max-w-[220px] items-center gap-2 rounded-lg border border-border bg-surface-softer px-2 py-1.5">
      {attachment.type === 'image' && (
        <img src={attachment.url} alt="" className="h-8 w-8 rounded object-cover" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold text-ink">{attachment.name}</div>
        <div className="text-[10px] text-ink-soft">{formatBytes(attachment.size)}</div>
      </div>
      <button
        onClick={onRemove}
        className="h-6 w-6 rounded text-xs font-bold text-ink-soft hover:bg-surface"
        title={t('room.removeAttachmentTitle', { name: attachment.name })}
      >
        x
      </button>
    </div>
  );
}

// Placeholder chip: the file holds its slot in the message while the upload
// runs, so the user can see what the send button is waiting for.
function UploadingAttachment({ name }: { name: string }) {
  const { t } = useLocale();
  return (
    <div
      data-uploading="true"
      className="flex max-w-[220px] items-center gap-2 rounded-lg border border-dashed border-border bg-surface-softer px-2 py-1.5"
    >
      <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold text-ink">{name}</div>
        <div className="text-[10px] text-ink-soft">{t('room.uploading')}</div>
      </div>
    </div>
  );
}
