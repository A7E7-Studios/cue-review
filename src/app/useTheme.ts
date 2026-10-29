import { useEffect, useState } from 'react';
import { storedTheme, THEME_KEY } from '../chrome/storedTheme';
import { windowApi } from '../chrome/windowApi';
import type { Platform, WindowTheme } from '../chrome/windowApi';

/**
 * The token the page's root paints (src/styles.css), read from the stylesheet so it follows
 * tokens.css: the sheet on macOS, where the sheet is the window, and the ground elsewhere.
 * Empty when the tokens are not loaded.
 */
export function rootBackground(platform: Platform, root: HTMLElement = document.documentElement): string {
  return getComputedStyle(root).getPropertyValue(platform === 'macos' ? '--color-sheet' : '--color-ground').trim();
}

/**
 * Settings → Appearance (decision 14): kept in localStorage and applied to the page and the native window,
 * whose own background takes the root's color so a dark window shows no light edge while it resizes.
 * src/chrome/platformAttribute.ts applies the saved theme before the first paint.
 */
export function useTheme(report: (problem: unknown) => void, platform: Platform) {
  const [theme, setTheme] = useState<WindowTheme>(storedTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* the theme still applies for this run */ }
    windowApi.setTheme(theme).catch(report);
    const background = rootBackground(platform);
    if (background) windowApi.setBackgroundColor(background).catch(report);
  }, [theme, platform, report]);
  return [theme, setTheme] as const;
}
