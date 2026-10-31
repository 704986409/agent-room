import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkOfflineOverlay } from './NetworkOfflineOverlay.js';

const state = vi.hoisted(() => ({
  offline: false,
  locale: 'zh-CN' as 'zh-CN' | 'en',
}));

vi.mock('../hooks/useNetworkOffline.js', () => ({
  useNetworkOffline: () => state.offline,
}));

vi.mock('../i18n/LocaleProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../i18n/LocaleProvider.js')>();
  const { translate } = await import('../i18n/messages.js');
  return {
    ...actual,
    useLocale: () => ({
      locale: state.locale,
      setLocale: () => {},
      t: (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate(state.locale, key, values),
      formatDateTime: (value: number | Date) => new Date(value).toLocaleString('en'),
      formatTime: (value: number | Date) => new Date(value).toLocaleTimeString('en'),
      formatNumber: (value: number) => new Intl.NumberFormat('en').format(value),
    }),
  };
});

function render(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<NetworkOfflineOverlay />); });
  return renderer;
}

describe('NetworkOfflineOverlay', () => {
  beforeEach(() => {
    state.offline = false;
    state.locale = 'zh-CN';
  });

  it('renders nothing while the network is up', () => {
    const renderer = render();
    expect(renderer.toJSON()).toBeNull();
    act(() => renderer.unmount());
  });

  it('covers the page in Chinese and swallows clicks while offline', () => {
    state.offline = true;
    const renderer = render();
    const node = renderer.root.findByProps({ 'data-testid': 'network-offline-overlay' });
    const props = node.props as {
      className: string;
      role: string;
      'aria-modal': boolean | string;
      onClickCapture: (event: Event) => void;
      onPointerDownCapture: (event: Event) => void;
      style: Record<string, unknown>;
    };
    expect(props.role).toBe('alertdialog');
    expect(props['aria-modal']).toBe('true');
    expect(props.className).toContain('fixed');
    expect(props.className).toContain('inset-0');
    expect(props.style.zIndex).toBe(2147483647);
    expect(props.style.backdropFilter).toContain('blur');
    expect(props.className).toContain('pointer-events-auto');

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('网络已断开');
    expect(rendered).toContain('网络超时，恢复后可继续操作');

    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as Event;
    props.onClickCapture(event);
    props.onPointerDownCapture(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(event.stopPropagation).toHaveBeenCalledTimes(2);

    act(() => renderer.unmount());
  });

  it('uses the English copy when the locale is English', () => {
    state.offline = true;
    state.locale = 'en';
    const renderer = render();
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('Network disconnected');
    expect(rendered).toContain('Network timed out. You can continue once it recovers.');
    act(() => renderer.unmount());
  });
});
