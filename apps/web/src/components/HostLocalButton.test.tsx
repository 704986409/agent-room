import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostLocalButton } from './HostLocalButton.js';

const hostOnThisMachine = vi.fn();
const revealManagedTerminal = vi.fn();

vi.mock('../lib/desktopHost.js', () => ({
  isDesktopShell: () => true,
  hostOnThisMachine: (...args: unknown[]) => hostOnThisMachine(...args),
  revealManagedTerminal: (...args: unknown[]) => revealManagedTerminal(...args),
}));

vi.mock('../lib/agentInvite.js', () => ({
  requestAgentInvite: vi.fn(async () => ({ inviteCode: 'AI-ONE' })),
  storedRoomHostKey: () => 'host-key',
}));

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

function render(onHosted?: (seat: { seatId?: string; name?: string }) => void): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<HostLocalButton roomCode="ABC-DEF-GHJ" isHost ended={false} onHosted={onHosted} />);
  });
  return renderer;
}

async function clickHost(renderer: ReactTestRenderer) {
  await act(async () => {
    renderer.root.findByType('button').props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('HostLocalButton', () => {
  beforeEach(() => {
    hostOnThisMachine.mockReset();
    revealManagedTerminal.mockReset();
  });

  it('reports the new seat and does not pop out a terminal window', async () => {
    hostOnThisMachine.mockResolvedValue({ ok: true, seat: { seatId: 'st_06eb2797', name: '开发工程师' } });
    const onHosted = vi.fn();
    const renderer = render(onHosted);
    await clickHost(renderer);
    expect(revealManagedTerminal).not.toHaveBeenCalled();
    expect(onHosted).toHaveBeenCalledWith({ seatId: 'st_06eb2797', name: '开发工程师' });
    expect(JSON.stringify(renderer.toJSON())).toContain('已在本机启动托管 Agent：开发工程师');
  });

  it('keeps the hosted-success state when hosting returns a seat', async () => {
    hostOnThisMachine.mockResolvedValue({ ok: true, seat: { seatId: 'st_1', name: '开发工程师' } });
    const renderer = render();
    await clickHost(renderer);
    const text = JSON.stringify(renderer.toJSON());
    expect(revealManagedTerminal).not.toHaveBeenCalled();
    expect(text).toContain('已在本机启动托管 Agent：开发工程师');
    expect(text).not.toContain('终端窗口未能自动弹出');
    expect(text).not.toContain('text-red-700');
  });
});
