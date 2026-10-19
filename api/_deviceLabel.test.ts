import { describe, expect, it } from 'vitest';
import { deviceLabel, SCRIPT_LABEL } from './_deviceLabel.js';

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  operaMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/125.0.0.0',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
};

describe('deviceLabel', () => {
  it.each([
    [UA.chromeWin, 'Chrome · Windows'],
    [UA.edgeWin, 'Edge · Windows'],
    [UA.firefoxLinux, 'Firefox · Linux'],
    [UA.safariMac, 'Safari · macOS'],
    [UA.operaMac, 'Opera · macOS'],
    [UA.chromeAndroid, 'Chrome · Android'],
    [UA.safariIos, 'Safari · iOS'],
    [UA.chromeIos, 'Chrome · iOS'],
  ])('labels %s', (ua, label) => {
    expect(deviceLabel(ua)).toBe(label);
  });

  it.each(['node', 'curl/8.5.0', 'undici', 'python-requests/2.32', 'Go-http-client/1.1', '', undefined])('labels non-browser %s as script', ua => {
    expect(deviceLabel(ua)).toBe(SCRIPT_LABEL);
  });

  it('labels an unknown browser on an unknown OS', () => {
    expect(deviceLabel('Mozilla/5.0 (Unknown) AppleWebKit/537.36 (KHTML, like Gecko)')).toBe('其他浏览器 · 其他系统');
  });
});
