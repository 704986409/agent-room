import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostLocalButton } from './HostLocalButton.js';

const hostOnThisMachine = vi.hoisted(() => vi.fn());
const revealManagedTerminal = vi.hoisted(() => vi.fn());
const listInstalledDesktopAdapters = vi.hoisted(() => vi.fn());
const requestAgentInvite = vi.hoisted(() => vi.fn());

vi.mock('../lib/desktopHost.js', () => ({
  isDesktopShell: () => true,
  hostOnThisMachine: (...args: unknown[]) => hostOnThisMachine(...args),
  revealManagedTerminal: (...args: unknown[]) => revealManagedTerminal(...args),
  listInstalledDesktopAdapters: (...args: unknown[]) => listInstalledDesktopAdapters(...args),
}));

vi.mock('../lib/agentInvite.js', () => ({
  requestAgentInvite: (...args: unknown[]) => requestAgentInvite(...args),
  storedRoomHostKey: () => 'host-key',
  SUGGESTED_INVITE_ROLES: ['记忆审核员', '开发工程师', '测试工程师', '产品经理', '架构师', '代码审查员', '研究员'],
  INVITE_ROLE_PROFILE_MAX_CHARS: 4000,
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

const installed = [
  { id: 'codex', models: ['default', 'gpt-6-sol'] },
  { id: 'cursor-agent', models: ['grok-4.7-high', 'grok-4.7'] },
];

function render(onHosted?: (seat: { seatId?: string; name?: string }) => void): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<HostLocalButton roomCode="ABC-DEF-GHJ" isHost ended={false} onHosted={onHosted} />);
  });
  return renderer;
}

function buttonByText(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType('button').find(item => item.children.join('') === label);
}

async function openDialog(renderer: ReactTestRenderer) {
  await act(async () => {
    buttonByText(renderer, '在本机托管')!.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('HostLocalButton', () => {
  beforeEach(() => {
    hostOnThisMachine.mockReset();
    revealManagedTerminal.mockReset();
    listInstalledDesktopAdapters.mockReset();
    requestAgentInvite.mockClear();
    requestAgentInvite.mockResolvedValue({ inviteCode: 'AI-ONE' });
    listInstalledDesktopAdapters.mockResolvedValue(installed);
  });

  it('opens the host dialog and does not start a seat until 托管', async () => {
    const renderer = render();
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
    await openDialog(renderer);
    expect(hostOnThisMachine).not.toHaveBeenCalled();
    expect(requestAgentInvite).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).toContain('选择角色、本机已安装的 CLI 和模型');
    expect(buttonByText(renderer, '托管')!.props.disabled).toBe(true);
  });

  it('creates an invite then hosts the chosen role, profile, CLI, and model', async () => {
    hostOnThisMachine.mockResolvedValue({ ok: true, seat: { seatId: 'st_06eb2797', name: '测试工程师' } });
    const onHosted = vi.fn();
    const renderer = render(onHosted);
    await openDialog(renderer);
    const [roleSelect, cliSelect] = renderer.root.findAllByType('select');
    await act(async () => {
      roleSelect!.props.onChange({ target: { value: '测试工程师' } });
      renderer.root.findByType('textarea').props.onChange({ target: { value: '负责接口测试' } });
      cliSelect!.props.onChange({ target: { value: 'cursor-agent' } });
    });
    const modelSelect = renderer.root.findAllByType('select')[2]!;
    await act(async () => {
      modelSelect.props.onChange({ target: { value: 'grok-4.7' } });
    });
    await act(async () => {
      buttonByText(renderer, '托管')!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestAgentInvite).toHaveBeenCalledWith('ABC-DEF-GHJ', 'host-key', '测试工程师', '负责接口测试');
    expect(hostOnThisMachine).toHaveBeenCalledWith({
      code: 'ABC-DEF-GHJ',
      inviteCode: 'AI-ONE',
      name: '测试工程师',
      adapterId: 'cursor-agent',
      model: 'grok-4.7',
    });
    expect(revealManagedTerminal).not.toHaveBeenCalled();
    expect(onHosted).toHaveBeenCalledWith({ seatId: 'st_06eb2797', name: '测试工程师' });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('已在本机启动托管 Agent：测试工程师');
    expect(text).not.toContain('终端窗口未能自动弹出');
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it('keeps the hosted-success state when hosting returns a seat', async () => {
    hostOnThisMachine.mockResolvedValue({ ok: true, seat: { seatId: 'st_1', name: '开发工程师' } });
    const renderer = render();
    await openDialog(renderer);
    const [roleSelect, cliSelect] = renderer.root.findAllByType('select');
    await act(async () => {
      roleSelect!.props.onChange({ target: { value: '开发工程师' } });
      cliSelect!.props.onChange({ target: { value: 'codex' } });
    });
    await act(async () => {
      buttonByText(renderer, '托管')!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(revealManagedTerminal).not.toHaveBeenCalled();
    expect(text).toContain('已在本机启动托管 Agent：开发工程师');
    expect(text).not.toContain('text-red-700');
  });

  it('disables hosting and explains when no CLI is installed', async () => {
    listInstalledDesktopAdapters.mockResolvedValue([]);
    const renderer = render();
    await openDialog(renderer);
    expect(JSON.stringify(renderer.toJSON())).toContain('launcher_unavailable');
    expect(buttonByText(renderer, '托管')!.props.disabled).toBe(true);
    await act(async () => {
      buttonByText(renderer, '托管')!.props.onClick();
      await Promise.resolve();
    });
    expect(requestAgentInvite).not.toHaveBeenCalled();
    expect(hostOnThisMachine).not.toHaveBeenCalled();
  });
});
