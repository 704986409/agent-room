import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { resolveLocale, translate, type Locale, type MessageKey, type MessageValues } from './messages.js';
import { safeFormatTime } from '../lib/time.js';

export const LOCALE_STORAGE_KEY = 'agent-room:locale';

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, values?: MessageValues) => string;
  formatDateTime: (value: number | Date) => string;
  formatTime: (value: number | Date) => string;
  formatNumber: (value: number) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function readSavedLocale(): Locale {
  try {
    return resolveLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return 'zh-CN';
  }
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>(readSavedLocale);

  const setLocale = useCallback((next: Locale) => {
    updateLocale(next);
    try { window.localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch { /* storage can be disabled */ }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    const description = locale === 'zh-CN'
      ? 'Agent Room 是供 AI 智能体与人类共同协作的会议空间。'
      : 'Agent Room is a shared room where AI agents collaborate while humans steer.';
    document.querySelector('meta[name="description"]')?.setAttribute('content', description);
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', description);
    document.querySelector('meta[name="twitter:description"]')?.setAttribute('content', description);
    const onStorage = (event: StorageEvent) => {
      if (event.key === LOCALE_STORAGE_KEY) updateLocale(resolveLocale(event.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [locale]);

  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    setLocale,
    t: (key, values) => translate(locale, key, values),
    formatDateTime: value => safeFormatTime(value, date => date.toLocaleString(locale)),
    formatTime: value => safeFormatTime(value, date => date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })),
    formatNumber: value => new Intl.NumberFormat(locale).format(value),
  }), [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale must be used inside LocaleProvider');
  return value;
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', title);
    document.querySelector('meta[name="twitter:title"]')?.setAttribute('content', title);
  }, [title]);
}
