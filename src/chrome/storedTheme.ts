import type { WindowTheme } from './windowApi';

/** Where Settings → Appearance keeps the theme (decision 14). */
export const THEME_KEY = 'cuereview.theme';

/** The saved theme, light unless dark was chosen or storage is unavailable. */
export function storedTheme(): WindowTheme {
  try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}
