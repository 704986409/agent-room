import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopSeatTerminal } from './DesktopSeatTerminal.js';

const state = vi.hoisted(() => ({
  desktop: true,
  list: vi.fn(),
  reveal: vi.fn(),
}));

const termIo = vi.hoisted(() => ({
  writes: [] as string[],
  clears: 0,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    write(data: string) { termIo.writes.push(String(data)); }
    clear() { termIo.clears += 1; }
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
    termIo.writes = [];
    termIo.clears = 0;
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

  it('switches the live PTY when preferredSeatId and focusToken change', async () => {
    state.list.mockResolvedValue({
      mode: 'embedded',
      terminals: [
        { seatId: 'st_1', pid: 3, cols: 80, rows: 24, name: 'Codex工位', code: 'ABC-DEF-GHJ' },
        { seatId: 'st_2', pid: 4, cols: 80, rows: 24, name: 'Cursor工位', code: 'ABC-DEF-GHJ' },
      ],
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DesktopSeatTerminal roomCode="ABC-DEF-GHJ" preferredSeatId="st_1" focusToken={1} />,
        { createNodeMock: () => ({}) },
      );
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    mounted = renderer;
    expect(FakeSocket.latest?.url).toContain('/st_1/ws');
    const previous = FakeSocket.latest!;
    const staleOpen = previous.onopen!;
    const staleMessage = previous.onmessage!;
    const staleClose = previous.onclose!;
    const staleError = previous.onerror!;
    const clearsBeforeSwitch = termIo.clears;

    await act(async () => {
      renderer.update(
        <DesktopSeatTerminal roomCode="ABC-DEF-GHJ" preferredSeatId="st_2" focusToken={2} />,
      );
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(FakeSocket.latest?.url).toContain('/st_2/ws');
    expect(FakeSocket.latest).not.toBe(previous);
    expect(previous.onopen).toBeNull();
    expect(previous.onmessage).toBeNull();
    expect(previous.onclose).toBeNull();
    expect(previous.onerror).toBeNull();
    expect(termIo.clears).toBeGreaterThan(clearsBeforeSwitch);
    expect(state.reveal).not.toHaveBeenCalled();

    await act(async () => {
      FakeSocket.latest!.onopen?.();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('已连接 st_2');

    termIo.writes = [];
    await act(async () => {
      staleMessage({ data: 'Ask Codex to do anything' });
      staleOpen();
      staleClose();
      staleError();
    });
    expect(termIo.writes).toEqual([]);
    expect(JSON.stringify(renderer.toJSON())).toContain('已连接 st_2');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('终端连接失败');

    await act(async () => {
      FakeSocket.latest!.onmessage?.({ data: 'cursor prompt' });
    });
    expect(termIo.writes).toEqual(['cursor prompt']);
  });

  it('renders a sub-tab per live seat and does not pop out on its own', async () => {
    state.list.mockResolvedValue({
      mode: 'embedded',
      terminals: [
        { seatId: 'st_1', pid: 3, cols: 80, rows: 24, name: '测试333', code: 'ABC-DEF-GHJ' },
        { seatId: 'st_2', pid: 4, cols: 80, rows: 24, name: 'Codex', code: 'ABC-DEF-GHJ' },
      ],
    });
    const onToggleExpand = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DesktopSeatTerminal roomCode="ABC-DEF-GHJ" onToggleExpand={onToggleExpand} />,
      );
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    mounted = renderer;
    expect(button(renderer, '测试333')).toBeTruthy();
    expect(button(renderer, 'Codex')).toBeTruthy();
    expect(state.reveal).not.toHaveBeenCalled();
    await act(async () => { button(renderer, '展开')!.props.onClick(); });
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });
});
