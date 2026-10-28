import { useEffect, useState } from 'react';
import { storedTheme, THEME_KEY } from '../chrome/storedTheme';
import { windowApi } from '../chrome/windowApi';
import type { WindowTheme } from '../chrome/windowApi';

/**
 * Settings → Appearance (decision 14): kept in localStorage and applied to the page and the native window.
 * src/chrome/platformAttribute.ts applies the saved theme before the first paint.
 */
export function useTheme(report: (problem: unknown) => void) {
  const [theme, setTheme] = useState<WindowTheme>(storedTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* the theme still applies for this run */ }
    windowApi.setTheme(theme).catch(report);
  }, [theme, report]);
  return [theme, setTheme] as const;
}
