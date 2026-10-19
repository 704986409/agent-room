import { showToast } from '../components/Toast.js';
import { resolveLocale, translate } from '../i18n/messages.js';

/** Legacy fallback for when the async Clipboard API is missing or rejects
 *  (e.g. user activation lost after awaiting a network call, insecure origin). */
function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  const prev = document.activeElement as HTMLElement | null;
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
    prev?.focus?.();
  }
}

/** Write text to the clipboard. Returns true on success. Never throws. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  return execCommandCopy(text);
}

/** Copy and toast. When `quietFailure` is set the caller shows its own
 *  failure UI (e.g. a manual-copy box) and no error toast is raised. */
export async function copyText(text: string, successMsg: string, opts?: { quietFailure?: boolean }): Promise<boolean> {
  const ok = await writeClipboard(text);
  if (ok) {
    showToast(successMsg);
  } else if (!opts?.quietFailure) {
    let locale: string | null = null;
    try { locale = window.localStorage.getItem('agent-room:locale'); } catch { /* storage can be disabled */ }
    showToast(translate(resolveLocale(locale), 'common.copyFailed'), 'error');
  }
  return ok;
}
