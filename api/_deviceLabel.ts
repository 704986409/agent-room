// Short, human-readable device label for a login session, derived from the
// User-Agent at login (design §4.1 personal center). Format: '浏览器 · 系统'.
// Non-browser clients (curl, node, scripts, SDKs) are labelled '脚本/API'.

export const SCRIPT_LABEL = '脚本/API';

function detectBrowser(ua: string): string | null {
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/\bOPR\/|\bOpera\b/.test(ua)) return 'Opera';
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return 'Firefox';
  if (/\bChrome\/|\bCriOS\/|\bChromium\//.test(ua)) return 'Chrome';
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return 'Safari';
  if (/^Mozilla\/5\.0/.test(ua) && /AppleWebKit|Gecko/.test(ua)) return '其他浏览器';
  return null;
}

function detectOs(ua: string): string {
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return 'iOS';
  if (/\bAndroid\b/.test(ua)) return 'Android';
  if (/\bWindows\b/.test(ua)) return 'Windows';
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'macOS';
  if (/\bLinux\b|\bX11\b|\bCrOS\b/.test(ua)) return 'Linux';
  return '其他系统';
}

export function deviceLabel(userAgent: string | undefined | null): string {
  const ua = (userAgent ?? '').trim();
  if (!ua) return SCRIPT_LABEL;
  const browser = detectBrowser(ua);
  if (!browser) return SCRIPT_LABEL;
  return `${browser} · ${detectOs(ua)}`;
}
