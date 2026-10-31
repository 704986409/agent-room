import { useEffect, useState, type ReactNode } from 'react';
import { useLocale } from '../i18n/LocaleProvider.js';

export type RightRailTab = 'tasks' | 'terminal';

/** Leaving 终端 must collapse expand so 任务 does not keep the wide rail. */
export function shouldCollapseTerminalExpand(next: RightRailTab): boolean {
  return next !== 'terminal';
}

/** Cloud and a normal browser keep the task board alone. The terminal tab exists only in the desktop shell. */
export function showRoomTerminalRail(desktop: boolean): boolean {
  return desktop;
}

/**
 * Right column of the room page.
 * Desktop: 任务 | 终端. Terminal content mounts on first visit to 终端 (avoids a
 * black xterm flash while 任务 is the default tab at room/daemon startup), then
 * stays mounted so the PTY socket and seat list survive later tab switches.
 * Elsewhere: the task board, with no terminal tab.
 */
export function RoomRightColumn({
  desktop,
  tab,
  onTab,
  tasks,
  terminal,
}: {
  desktop: boolean;
  tab: RightRailTab;
  onTab: (tab: RightRailTab) => void;
  tasks: ReactNode;
  terminal: ReactNode;
}) {
  const { t } = useLocale();
  const [terminalMounted, setTerminalMounted] = useState(tab === 'terminal');
  useEffect(() => {
    if (tab === 'terminal') setTerminalMounted(true);
  }, [tab]);
  if (!showRoomTerminalRail(desktop)) {
    return <div className="flex min-h-0 min-w-0 flex-1 flex-col">{tasks}</div>;
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div role="tablist" aria-label={t('room.railTerminal')} className="flex shrink-0 gap-1 border-b border-border-faint bg-surface p-2">
        {(['tasks', 'terminal'] as const).map(key => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onTab(key)}
              className={`min-h-9 flex-1 rounded-lg px-3 text-[13px] font-semibold transition ${
                active ? 'bg-accent text-white shadow-sm' : 'bg-surface-softer text-ink-muted hover:text-ink'
              }`}
            >
              {key === 'tasks' ? t('room.tasks') : t('room.railTerminal')}
            </button>
          );
        })}
      </div>
      <div data-rail-panel="tasks" className={tab === 'tasks' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}>{tasks}</div>
      <div data-rail-panel="terminal" className={tab === 'terminal' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}>
        {terminalMounted ? terminal : null}
      </div>
    </div>
  );
}
