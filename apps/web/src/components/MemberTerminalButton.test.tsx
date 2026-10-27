import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { MemberTerminalButton } from './MemberTerminalButton.js';
import { RoomRightColumn, type RightRailTab } from './RightRail.js';

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

function Harness() {
  const [tab, setTab] = useState<RightRailTab>('tasks');
  const [seat, setSeat] = useState('');
  const [focus, setFocus] = useState(0);
  const [parentClicks, setParentClicks] = useState(0);
  return (
    <div onClick={() => setParentClicks(n => n + 1)}>
      <MemberTerminalButton
        label="打开Codex工位的终端"
        onOpen={() => {
          setSeat('st_codex');
          setFocus(n => n + 1);
          setTab('terminal');
        }}
      />
      <div data-parent-clicks={parentClicks} />
      <RoomRightColumn
        desktop
        tab={tab}
        onTab={setTab}
        tasks={<div>任务板</div>}
        terminal={<div>{`seat:${seat} focus:${focus}`}</div>}
      />
    </div>
  );
}

describe('MemberTerminalButton', () => {
  it('opens that seat on the terminal rail and does not let the click bubble', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<Harness />); });
    const button = renderer.root.findAllByType('button').find(item => item.props['aria-label'] === '打开Codex工位的终端');
    expect(button).toBeTruthy();
    expect(button!.props.className).toContain('h-10');
    expect(button!.props.className).toContain('w-10');
    expect(button!.props.className).toContain('shrink-0');
    expect(button!.props.className).toContain('z-10');
    expect(button!.props.className).not.toContain('sm:h-8');
    expect(renderer.root.findByProps({ 'data-rail-panel': 'terminal' }).props.className).toContain('hidden');

    const stop = vi.fn();
    act(() => { button!.props.onClick({ stopPropagation: stop }); });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ 'data-parent-clicks': 0 })).toBeTruthy();
    expect(renderer.root.findByProps({ role: 'tab', 'aria-selected': true }).children).toContain('终端');
    expect(renderer.root.findByProps({ 'data-rail-panel': 'terminal' }).props.className).not.toContain('hidden');
    expect(JSON.stringify(renderer.toJSON())).toContain('seat:st_codex focus:1');
  });
});
