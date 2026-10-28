import { useEffect, useState } from 'react';
import { windowApi } from '../chrome/windowApi';
import type { WindowTheme } from '../chrome/windowApi';

const KEY = 'cuereview.theme';
function storedTheme(): WindowTheme {
  try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

/** Settings → Appearance (decision 14): kept in localStorage and applied to the page and the native window. */
export function useTheme(report: (problem: unknown) => void) {
  const [theme, setTheme] = useState<WindowTheme>(storedTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(KEY, theme); } catch { /* the theme still applies for this run */ }
    windowApi.setTheme(theme).catch(report);
  }, [theme, report]);
  return [theme, setTheme] as const;
}
