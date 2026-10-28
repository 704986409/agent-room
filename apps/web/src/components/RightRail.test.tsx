import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { RoomRightColumn, shouldCollapseTerminalExpand, type RightRailTab } from './RightRail.js';

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

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType('button').find(item => item.children.join('') === label);
}

function RailHarness({ desktop, initial = 'tasks' as RightRailTab }: { desktop: boolean; initial?: RightRailTab }) {
  const [tab, setTab] = useState<RightRailTab>(initial);
  const [seat, setSeat] = useState('');
  return (
    <>
      <button type="button" onClick={() => { setTab('terminal'); setSeat('st_9'); }}>打开测试333</button>
      <RoomRightColumn
        desktop={desktop}
        tab={tab}
        onTab={setTab}
        tasks={<div>任务板</div>}
        terminal={<div>{`终端面板 ${seat}`}</div>}
      />
    </>
  );
}

describe('RoomRightColumn', () => {
  it('keeps a non-desktop column on the task board with no terminal tab or panel', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<RailHarness desktop={false} />);
    });
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('任务板');
    expect(json).not.toContain('终端');
    expect(json).not.toContain('终端面板');
    expect(renderer.root.findAllByType('button').some(item => item.children.join('') === '终端')).toBe(false);
  });

  it('shows 任务 and 终端, and selecting 终端 reveals the panel', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<RailHarness desktop />);
    });
    expect(button(renderer, '任务')).toBeTruthy();
    expect(button(renderer, '终端')).toBeTruthy();
    expect(renderer.root.findByProps({ 'data-rail-panel': 'terminal' }).props.className).toContain('hidden');
    act(() => { button(renderer, '终端')!.props.onClick(); });
    expect(renderer.root.findByProps({ 'data-rail-panel': 'terminal' }).props.className).not.toContain('hidden');
    expect(JSON.stringify(renderer.toJSON())).toContain('终端面板');
  });

  it('switches the rail to 终端 and the member seat when the member control is used', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<RailHarness desktop />);
    });
    act(() => { button(renderer, '打开测试333')!.props.onClick(); });
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('终端面板 st_9');
    expect(button(renderer, '终端')!.props['aria-selected']).toBe(true);
  });
});

describe('shouldCollapseTerminalExpand', () => {
  it('collapses when leaving 终端 for 任务, and keeps expand on 终端', () => {
    expect(shouldCollapseTerminalExpand('tasks')).toBe(true);
    expect(shouldCollapseTerminalExpand('terminal')).toBe(false);
  });
});
