import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopSeatTerminal } from './DesktopSeatTerminal.js';

const state = vi.hoisted(() => ({
  desktop: true,
  list: vi.fn(),
  reveal: vi.fn(),
  readClipboard: vi.fn(),
}));

const termIo = vi.hoisted(() => ({
  writes: [] as string[],
  resets: 0,
  onDataHandler: null as ((data: string) => void) | null,
  keyHandler: null as ((event: KeyboardEvent) => boolean) | null,
  pasteListeners: [] as Array<(event: Event) => void>,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    onData(handler: (data: string) => void) { termIo.onDataHandler = handler; return { dispose() {} }; }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { termIo.keyHandler = handler; }
    write(data: string) { termIo.writes.push(String(data)); }
    clear() {}
    reset() { termIo.resets += 1; }
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
    readDesktopClipboardText: (...args: unknown[]) => state.readClipboard(...args),
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
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    FakeSocket.latest = this;
  }
  send(data: string) { this.sent.push(String(data)); }
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

function mockHost() {
  return {
    addEventListener(type: string, listener: (event: Event) => void, options?: boolean | AddEventListenerOptions) {
      if (type === 'paste' && options === true) termIo.pasteListeners.push(listener);
    },
  };
}

async function renderPanel(preferredSeatId?: string): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <DesktopSeatTerminal roomCode="ABC-DEF-GHJ" preferredSeatId={preferredSeatId} />,
      { createNodeMock: () => mockHost() },
    );
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
    state.readClipboard.mockReset();
    state.list.mockResolvedValue(live);
    state.reveal.mockResolvedValue(null);
    state.readClipboard.mockResolvedValue('');
    FakeSocket.latest = null;
    termIo.writes = [];
    termIo.resets = 0;
    termIo.onDataHandler = null;
    termIo.keyHandler = null;
    termIo.pasteListeners = [];
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
        { createNodeMock: () => mockHost() },
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
    const resetsBeforeSwitch = termIo.resets;

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
    expect(termIo.resets).toBeGreaterThan(resetsBeforeSwitch);
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

  it('pastes clipboardData text from the paste event and drops the image-paste control character', async () => {
    const readText = vi.fn(async () => 'SHOULD-NOT-USE');
    vi.stubGlobal('navigator', { clipboard: { readText } });
    await renderPanel('st_1');
    const socket = FakeSocket.latest!;
    socket.readyState = FakeSocket.OPEN;
    expect(termIo.pasteListeners.length).toBeGreaterThan(0);

    const prevented = { current: false };
    const stopped = { current: false };
    await act(async () => {
      termIo.pasteListeners[0]!({
        preventDefault() { prevented.current = true; },
        stopPropagation() { stopped.current = true; },
        clipboardData: {
          getData(type: string) { return type === 'text/plain' ? 'INVITE-TEXT' : ''; },
        },
      } as unknown as ClipboardEvent);
    });
    expect(prevented.current).toBe(true);
    expect(stopped.current).toBe(true);
    expect(readText).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([JSON.stringify({ type: 'stdin', data: 'INVITE-TEXT' })]);

    termIo.onDataHandler?.('\x16');
    expect(socket.sent).toEqual([JSON.stringify({ type: 'stdin', data: 'INVITE-TEXT' })]);
  });

  it('falls back to navigator.clipboard.readText when paste has no text/plain', async () => {
    const readText = vi.fn(async () => 'FALLBACK-TEXT');
    vi.stubGlobal('navigator', { clipboard: { readText } });
    await renderPanel('st_1');
    const socket = FakeSocket.latest!;
    socket.readyState = FakeSocket.OPEN;
    await act(async () => {
      termIo.pasteListeners[0]!({
        preventDefault() {},
        stopPropagation() {},
        clipboardData: {
          getData() { return ''; },
        },
      } as unknown as ClipboardEvent);
      await Promise.resolve();
    });
    expect(readText).toHaveBeenCalledTimes(1);
    expect(socket.sent).toEqual([JSON.stringify({ type: 'stdin', data: 'FALLBACK-TEXT' })]);
  });

  it('sends paste text via the host onPaste prop', async () => {
    await renderPanel('st_1');
    const socket = FakeSocket.latest!;
    socket.readyState = FakeSocket.OPEN;
    const renderer = mounted!;
    const host = renderer.root.findAllByType('div').find(node =>
      String(node.props.className || '').includes('bg-[#1e1e1e]'),
    );
    expect(host?.props.onPaste).toBeTypeOf('function');
    await act(async () => {
      host!.props.onPaste({
        nativeEvent: {
          preventDefault() {},
          stopPropagation() {},
          clipboardData: {
            getData(type: string) { return type === 'text/plain' ? 'FROM-REACT' : ''; },
          },
        },
      });
    });
    expect(socket.sent).toEqual([JSON.stringify({ type: 'stdin', data: 'FROM-REACT' })]);
  });

  function pasteKey(partial: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
    return {
      type: 'keydown',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      preventDefault() {},
      ...partial,
    } as KeyboardEvent;
  }

  it('fetches the daemon clipboard on Ctrl+V, Cmd+V, and Shift+Insert', async () => {
    state.readClipboard.mockResolvedValue('DAEMON-CLIP');
    const renderer = await renderPanel('st_1');
    const socket = FakeSocket.latest!;
    socket.readyState = FakeSocket.OPEN;
    expect(termIo.keyHandler).toBeTypeOf('function');

    const prevented = { current: 0 };
    await act(async () => {
      const allow = termIo.keyHandler!(pasteKey({
        key: 'v',
        ctrlKey: true,
        preventDefault() { prevented.current += 1; },
      }));
      expect(allow).toBe(false);
      await Promise.resolve();
    });
    expect(prevented.current).toBe(1);
    expect(state.readClipboard).toHaveBeenCalledTimes(1);
    expect(socket.sent).toEqual([JSON.stringify({ type: 'stdin', data: 'DAEMON-CLIP' })]);

    state.readClipboard.mockResolvedValue('CMD-CLIP');
    await act(async () => {
      expect(termIo.keyHandler!(pasteKey({ key: 'v', metaKey: true }))).toBe(false);
      await Promise.resolve();
    });
    expect(socket.sent[1]).toBe(JSON.stringify({ type: 'stdin', data: 'CMD-CLIP' }));

    state.readClipboard.mockResolvedValue('SHIFT-INSERT');
    await act(async () => {
      expect(termIo.keyHandler!(pasteKey({ key: 'Insert', shiftKey: true }))).toBe(false);
      await Promise.resolve();
    });
    expect(socket.sent[2]).toBe(JSON.stringify({ type: 'stdin', data: 'SHIFT-INSERT' }));

    const calls = state.readClipboard.mock.calls.length;
    await act(async () => {
      expect(termIo.keyHandler!(pasteKey({ type: 'keyup', key: 'v', ctrlKey: true }))).toBe(false);
      expect(termIo.keyHandler!(pasteKey({ key: 'a' }))).toBe(true);
    });
    expect(state.readClipboard).toHaveBeenCalledTimes(calls);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('剪贴板里没有可粘贴的文本');
  });

  it('shows pasteFailed when the daemon clipboard is empty or unreadable', async () => {
    state.readClipboard.mockResolvedValue('');
    const renderer = await renderPanel('st_1');
    const socket = FakeSocket.latest!;
    socket.readyState = FakeSocket.OPEN;
    await act(async () => {
      termIo.keyHandler!(pasteKey({ key: 'v', ctrlKey: true }));
      await Promise.resolve();
    });
    expect(socket.sent).toEqual([]);
    expect(JSON.stringify(renderer.toJSON())).toContain('剪贴板里没有可粘贴的文本');

    state.readClipboard.mockRejectedValue(new Error('down'));
    await act(async () => {
      termIo.keyHandler!(pasteKey({ key: 'V', ctrlKey: true }));
      await Promise.resolve();
    });
    expect(socket.sent).toEqual([]);
    expect(JSON.stringify(renderer.toJSON())).toContain('剪贴板里没有可粘贴的文本');
  });

});
