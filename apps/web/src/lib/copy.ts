import { showToast } from '../components/Toast.js';
import { resolveLocale, translate } from '../i18n/messages.js';

export async function copyText(text: string, successMsg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMsg);
  } catch {
    let locale: string | null = null;
    try { locale = window.localStorage.getItem('agent-room:locale'); } catch { /* storage can be disabled */ }
    showToast(translate(resolveLocale(locale), 'common.copyFailed'), 'error');
  }
}
