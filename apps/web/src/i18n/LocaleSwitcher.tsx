import { useLocale } from './LocaleProvider.js';

export function LocaleSwitcher({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  const { locale, setLocale, t } = useLocale();
  return (
    <div role="group" aria-label={t('common.language')} className={`inline-flex shrink-0 items-center gap-1 rounded-lg border border-border bg-white p-1 ${className}`}>
      <button
        type="button"
        aria-label={t('common.simplifiedChinese')}
        title={t('common.simplifiedChinese')}
        aria-pressed={locale === 'zh-CN'}
        onClick={() => setLocale('zh-CN')}
        className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${locale === 'zh-CN' ? 'bg-accent-tint text-accent' : 'text-ink-muted hover:bg-surface-soft'}`}
      >
        {compact ? '中' : t('common.simplifiedChinese')}
      </button>
      <button
        type="button"
        aria-label={t('common.english')}
        title={t('common.english')}
        aria-pressed={locale === 'en'}
        onClick={() => setLocale('en')}
        className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${locale === 'en' ? 'bg-accent-tint text-accent' : 'text-ink-muted hover:bg-surface-soft'}`}
      >
        {compact ? 'EN' : t('common.english')}
      </button>
    </div>
  );
}
