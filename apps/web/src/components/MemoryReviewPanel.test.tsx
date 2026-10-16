import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryReviewPanel } from './MemoryReviewPanel.js';

vi.mock('../i18n/LocaleProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../i18n/LocaleProvider.js')>();
  const { translate } = await import('../i18n/messages.js');
  return {
    ...actual,
    useLocale: () => ({
      locale: 'zh-CN' as const,
      setLocale: () => {},
      t: (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate('zh-CN', key, values),
      formatDateTime: (value: number | Date) => new Date(value).toLocaleString('zh-CN'),
      formatTime: (value: number | Date) => new Date(value).toLocaleTimeString('zh-CN'),
      formatNumber: (value: number) => new Intl.NumberFormat('zh-CN').format(value),
    }),
  };
});

const proposal = {
  id: 'P-01',
  action: 'create',
  targetMemoryId: null,
  payload: { title: '部署流程', preview: '先跑 CI 再发布', content: '先跑 CI 再发布', searchText: 'deploy ci' },
  createdAt: '2026-01-02T03:04:05.000Z',
};

const fetchMock = vi.fn();

function text(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

async function openPanel(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(MemoryReviewPanel, { roomCode: 'ABC-DEF-GHJ', isHost: true, ended: false }));
  });
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': '打开共享记忆审核' }).props.onClick();
  });
  return renderer;
}

describe('MemoryReviewPanel localization', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('localStorage', { getItem: () => 'host-key-1' });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders Chinese labels while keeping the raw action value in the request', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [proposal] }) });
    const renderer = await openPanel();

    const rendered = text(renderer);
    expect(rendered).toContain('共享记忆提议');
    expect(rendered).toContain('新增 · 部署流程');
    expect(rendered).toContain('检索关键词：deploy ci');
    expect(rendered).toContain('记忆审核 · 1');
    expect(rendered).not.toContain('Shared memory proposals');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).action).toBe('list');

    await act(async () => renderer.unmount());
  });

  it('shows a localized explanation next to the untouched error code', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ code: 'REVIEWER_UNAVAILABLE' }) });
    const renderer = await openPanel();

    const rendered = text(renderer);
    expect(rendered).toContain('审核员当前不在线');
    expect(rendered).toContain('REVIEWER_UNAVAILABLE');

    await act(async () => renderer.unmount());
  });

  it('falls back to the generic message for an unmapped error code', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ code: 'TEAPOT' }) });
    const renderer = await openPanel();

    const rendered = text(renderer);
    expect(rendered).toContain('审核服务返回了未知错误');
    expect(rendered).toContain('TEAPOT');

    await act(async () => renderer.unmount());
  });

  it('explains a missing host key without calling the review API', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    const renderer = await openPanel();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(text(renderer)).toContain('当前浏览器中没有房主密钥');

    await act(async () => renderer.unmount());
  });
});
