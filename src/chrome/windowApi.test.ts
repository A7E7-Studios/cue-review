import { afterEach, describe, expect, it, vi } from 'vitest';
import { platform, shortcut, windowApi } from './windowApi';

const getCurrentWindow = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow }));

describe('windowApi', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads the platform from the user agent', () => {
    const cases: [string, string][] = [
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0', 'windows'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'macos'],
      ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15', 'linux'],
    ];
    for (const [userAgent, expected] of cases) {
      vi.stubGlobal('navigator', { userAgent });
      expect(platform()).toBe(expected);
    }
  });

  it('labels shortcuts with Ctrl, or ⌘ on macOS', () => {
    expect(shortcut('k', 'windows')).toEqual({ label: 'Ctrl+K', aria: 'Control+K' });
    expect(shortcut('n', 'linux')).toEqual({ label: 'Ctrl+N', aria: 'Control+N' });
    expect(shortcut('r', 'macos')).toEqual({ label: '⌘R', aria: 'Meta+R' });
  });

  it('does nothing outside the desktop app', async () => {
    await windowApi.minimize();
    await windowApi.toggleMaximize();
    await windowApi.close();
    await windowApi.setSize({ width: 520, height: 320 });
    expect(await windowApi.isMaximized()).toBe(false);
    expect(await windowApi.scaleFactor()).toBe(window.devicePixelRatio);
    (await windowApi.onResized(() => {}))();
    expect(getCurrentWindow).not.toHaveBeenCalled();
  });
});
