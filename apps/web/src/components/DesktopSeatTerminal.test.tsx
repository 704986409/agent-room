import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopSeatTerminal } from './DesktopSeatTerminal.js';

const state = vi.hoisted(() => ({
  desktop: true,
  list: vi.fn(),
  reveal: vi.fn(),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    write() {}
    clear() {}
    dispose() {}
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() {} },
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('../lib/desktopHost.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/desktopHost.js')>();
  return {
    ...actual,
    isDesktopShell: () => state.desktop,
    revealManagedTerminal: (...args: unknown[]) => state.reveal(...args),
    listenDesktopEvent: async () => null,
  };
});

vi.mock('../lib/desktopTerminal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/desktopTerminal.js')>();
  return {
    ...actual,
    listDesktopTerminals: (...args: unknown[]) => state.list(...args),
  };
});

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

class FakeSocket {
  static OPEN = 1;
  static latest: FakeSocket | null = null;
  url: string;
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.latest = this;
  }
  send() {}
  close() { this.readyState = 3; }
}

const live = {
  terminals: [{ seatId: 'st_1', pid: 3, cols: 80, rows: 24, name: '开发工程师', code: 'ABC-DEF-GHJ' }],
  mode: 'embedded',
};

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType('button').find(item => item.children.join('') === label);
}

let mounted: ReactTestRenderer | null = null;

async function renderPanel(preferredSeatId?: string): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<DesktopSeatTerminal roomCode="ABC-DEF-GHJ" preferredSeatId={preferredSeatId} />);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  mounted = renderer;
  return renderer;
}

describe('DesktopSeatTerminal', () => {
  beforeEach(() => {
    state.desktop = true;
    state.list.mockReset();
    state.reveal.mockReset();
    state.list.mockResolvedValue(live);
    state.reveal.mockResolvedValue(null);
    FakeSocket.latest = null;
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    act(() => { mounted?.unmount(); });
    mounted = null;
    vi.unstubAllGlobals();
  });

  it('renders nothing outside the desktop shell', async () => {
    state.desktop = false;
    const renderer = await renderPanel();
    expect(renderer.toJSON()).toBeNull();
    expect(state.list).not.toHaveBeenCalled();
  });

  it('connects the docked xterm on the desktop-auth socket without a token', async () => {
    const renderer = await renderPanel();
    expect(JSON.stringify(renderer.toJSON())).toContain('本机终端');
    await act(async () => {
      button(renderer, '连接')!.props.onClick();
    });
    expect(FakeSocket.latest?.url).toBe('ws://127.0.0.1:17421/api/desktop/terminals/st_1/ws?desktop=1');
    expect(FakeSocket.latest?.url.includes('t=')).toBe(false);
  });

  it('pops out only when the button is used', async () => {
    const renderer = await renderPanel();
    expect(state.reveal).not.toHaveBeenCalled();
    await act(async () => {
      button(renderer, '弹出')!.props.onClick();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(state.reveal).toHaveBeenCalledTimes(1);
    expect(state.reveal).toHaveBeenCalledWith('st_1');
  });

  it('auto-connects the seat that was just hosted', async () => {
    await renderPanel('st_1');
    expect(FakeSocket.latest?.url).toBe('ws://127.0.0.1:17421/api/desktop/terminals/st_1/ws?desktop=1');
    expect(state.reveal).not.toHaveBeenCalled();
  });
});
