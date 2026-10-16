import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '@agent-room/shared';
import { Composer } from './Composer.js';
import { UploadError } from '../lib/upload.js';

const uploadAttachment = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());

vi.mock('../lib/upload.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/upload.js')>();
  return { ...actual, uploadAttachment };
});

vi.mock('./Toast.js', () => ({ showToast }));

vi.mock('../i18n/LocaleProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../i18n/LocaleProvider.js')>();
  const { translate } = await import('../i18n/messages.js');
  return {
    ...actual,
    useLocale: () => ({
      locale: 'en' as const,
      setLocale: () => {},
      t: (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate('en', key, values),
      formatDateTime: (value: number | Date) => new Date(value).toLocaleString('en'),
      formatTime: (value: number | Date) => new Date(value).toLocaleTimeString('en'),
      formatNumber: (value: number) => new Intl.NumberFormat('en').format(value),
    }),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fileLike(name: string, type = 'application/pdf'): File {
  return { name, type, size: 2048 } as unknown as File;
}

function attachmentFor(name: string): MessageAttachment {
  return {
    id: `att-${name}`,
    type: 'file',
    url: `https://blob.example/${name}`,
    name,
    size: 2048,
    mime: 'application/pdf',
    uploadedAt: 1,
  };
}

function Harness({ onSubmit }: { onSubmit: (body: string, attachments: MessageAttachment[]) => Promise<void> }) {
  const [text, setText] = React.useState('');
  return (
    <Composer
      roomCode="ABC-DEF-GHJ"
      text={text}
      onTextChange={setText}
      onAppendText={value => setText(prev => (prev ? `${prev}\n${value}` : value))}
      onSubmit={onSubmit}
      ended={false}
    />
  );
}

function rendered(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function textarea(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.findByType('textarea');
}

function sendButton(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.findByProps({ 'aria-label': 'Send' });
}

async function type(renderer: ReactTestRenderer, value: string) {
  await act(async () => { textarea(renderer).props.onChange({ target: { value } }); });
}

async function pickFiles(renderer: ReactTestRenderer, files: File[]) {
  const input = renderer.root.findByProps({ type: 'file' });
  await act(async () => { input.props.onChange({ target: { files } }); });
}

async function pressEnter(renderer: ReactTestRenderer) {
  const preventDefault = vi.fn();
  await act(async () => {
    textarea(renderer).props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault,
    });
  });
  return preventDefault;
}

describe('Composer upload gating', () => {
  beforeEach(() => {
    uploadAttachment.mockReset();
    showToast.mockReset();
  });

  it('blocks sending until the attachment finishes uploading, then sends both', async () => {
    const upload = deferred<MessageAttachment>();
    uploadAttachment.mockReturnValue(upload.promise);
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness onSubmit={onSubmit} />); });

    await type(renderer, 'here is the spec');
    await pickFiles(renderer, [fileLike('spec.pdf')]);

    // Placeholder chip holds the file's slot while the upload runs.
    expect(renderer.root.findByProps({ 'data-uploading': 'true' })).toBeTruthy();
    expect(rendered(renderer)).toContain('spec.pdf');
    expect(rendered(renderer)).toContain('Uploading…');
    expect(sendButton(renderer).props.disabled).toBe(true);

    await pressEnter(renderer);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Attachment is still uploading, please wait', 'info');
    expect(textarea(renderer).props.value).toBe('here is the spec');

    await act(async () => { upload.resolve(attachmentFor('spec.pdf')); });

    expect(renderer.root.findAllByProps({ 'data-uploading': 'true' })).toHaveLength(0);
    expect(rendered(renderer)).toContain('spec.pdf');
    expect(rendered(renderer)).toContain('2.0 KB');
    expect(sendButton(renderer).props.disabled).toBe(false);

    await act(async () => { sendButton(renderer).props.onClick(); });

    expect(onSubmit).toHaveBeenCalledWith('here is the spec', [attachmentFor('spec.pdf')]);
    expect(textarea(renderer).props.value).toBe('');
    expect(rendered(renderer)).not.toContain('spec.pdf');

    await act(async () => renderer.unmount());
  });

  it('drops the placeholder and reports an error toast when an upload fails', async () => {
    const upload = deferred<MessageAttachment>();
    uploadAttachment.mockReturnValue(upload.promise);
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness onSubmit={onSubmit} />); });

    await type(renderer, 'take a look');
    await pickFiles(renderer, [fileLike('broken.pdf')]);
    expect(sendButton(renderer).props.disabled).toBe(true);

    await act(async () => {
      upload.reject(new Error('Upload failed (500).'));
      await Promise.resolve();
    });

    expect(renderer.root.findAllByProps({ 'data-uploading': 'true' })).toHaveLength(0);
    expect(rendered(renderer)).not.toContain('broken.pdf');
    expect(showToast).toHaveBeenCalledWith('Attachment failed: Upload failed (500).', 'error');
    // Text survives a failed upload and can still be sent on its own.
    expect(sendButton(renderer).props.disabled).toBe(false);
    expect(textarea(renderer).props.value).toBe('take a look');

    await act(async () => renderer.unmount());
  });

  it('tracks concurrent uploads and keeps the gate closed until the last one lands', async () => {
    const first = deferred<MessageAttachment>();
    const second = deferred<MessageAttachment>();
    uploadAttachment
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness onSubmit={onSubmit} />); });

    await pickFiles(renderer, [fileLike('one.pdf'), fileLike('two.pdf')]);
    expect(renderer.root.findAllByProps({ 'data-uploading': 'true' })).toHaveLength(2);

    await act(async () => { first.resolve(attachmentFor('one.pdf')); });
    expect(renderer.root.findAllByProps({ 'data-uploading': 'true' })).toHaveLength(1);
    expect(sendButton(renderer).props.disabled).toBe(true);

    await act(async () => { second.resolve(attachmentFor('two.pdf')); });
    expect(renderer.root.findAllByProps({ 'data-uploading': 'true' })).toHaveLength(0);
    expect(sendButton(renderer).props.disabled).toBe(false);

    await act(async () => { sendButton(renderer).props.onClick(); });
    expect(onSubmit).toHaveBeenCalledWith('', [attachmentFor('one.pdf'), attachmentFor('two.pdf')]);

    await act(async () => renderer.unmount());
  });

  it('restores the draft and the attachments when sending fails', async () => {
    uploadAttachment.mockResolvedValue(attachmentFor('notes.pdf'));
    const onSubmit = vi.fn().mockRejectedValue(new Error('Upstash HTTP 502'));

    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness onSubmit={onSubmit} />); });

    await type(renderer, 'minutes attached');
    await pickFiles(renderer, [fileLike('notes.pdf')]);
    await act(async () => { sendButton(renderer).props.onClick(); });

    expect(showToast).toHaveBeenCalledWith('Send failed: Upstash HTTP 502', 'error');
    expect(textarea(renderer).props.value).toBe('minutes attached');
    expect(rendered(renderer)).toContain('notes.pdf');

    await act(async () => renderer.unmount());
  });

  it('refuses a name over the byte budget without uploading it or holding a slot', async () => {
    uploadAttachment.mockResolvedValue(attachmentFor('ok.pdf'));
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    // 41 Chinese characters = 123 utf-8 bytes, past MAX_FILENAME_BYTES.
    const tooLong = `${'会'.repeat(41)}.pdf`;

    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness onSubmit={onSubmit} />); });

    await pickFiles(renderer, [fileLike(tooLong)]);

    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('File name is too long and can’t be uploaded.', 'error');
    expect(renderer.root.findAllByProps({ 'data-uploading': 'true' })).toHaveLength(0);
    expect(rendered(renderer)).not.toContain(tooLong);
    expect(sendButton(renderer).props.disabled).toBe(true); // nothing to send

    await act(async () => renderer.unmount());
  });

  it('keeps uploading the rest of a batch when one name is too long', async () => {
    uploadAttachment.mockResolvedValue(attachmentFor('spec.pdf'));
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness onSubmit={onSubmit} />); });

    await pickFiles(renderer, [fileLike(`${'会'.repeat(41)}.pdf`), fileLike('spec.pdf')]);

    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(uploadAttachment.mock.calls[0]![0]).toMatchObject({ name: 'spec.pdf' });
    expect(showToast).toHaveBeenCalledWith('File name is too long and can’t be uploaded.', 'error');
    expect(rendered(renderer)).toContain('spec.pdf');

    await act(async () => renderer.unmount());
  });

  it('localizes the server’s filename_too_long answer instead of echoing it', async () => {
    const upload = deferred<MessageAttachment>();
    uploadAttachment.mockReturnValue(upload.promise);
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness onSubmit={onSubmit} />); });

    await pickFiles(renderer, [fileLike('plan.pdf')]);
    await act(async () => {
      upload.reject(new UploadError('filename_too_long', 400, '文件名称太长，不支持上传'));
      await Promise.resolve();
    });

    expect(showToast).toHaveBeenCalledWith('File name is too long and can’t be uploaded.', 'error');
    expect(rendered(renderer)).not.toContain('plan.pdf');

    await act(async () => renderer.unmount());
  });

  it('sends on Enter once nothing is uploading', async () => {
    uploadAttachment.mockResolvedValue(attachmentFor('notes.pdf'));
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness onSubmit={onSubmit} />); });

    await type(renderer, 'ready');
    const preventDefault = await pressEnter(renderer);

    expect(preventDefault).toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith('ready', []);
    expect(textarea(renderer).props.value).toBe('');

    await act(async () => renderer.unmount());
  });
});
