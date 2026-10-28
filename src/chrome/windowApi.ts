import { isTauri } from '@tauri-apps/api/core';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';

// The only window API the UI uses. Outside the desktop app (tests, Storybook,
// a plain browser) every call is a harmless no-op with a browser fallback.
export type Platform = 'windows' | 'macos' | 'linux';
export type WindowTheme = 'light' | 'dark';
/** Width and height in logical (CSS) pixels unless a function says otherwise. */
export interface WindowSize { width: number; height: number }

const current = () => isTauri() ? getCurrentWindow() : null;

export const windowApi = {
  minimize: async () => { await current()?.minimize(); },
  toggleMaximize: async () => { await current()?.toggleMaximize(); },
  isMaximized: async () => await current()?.isMaximized() ?? false,
  /** Calls `handler` with the new size in physical pixels. Resolves to an unsubscribe function. */
  onResized: async (handler: (size: WindowSize) => void): Promise<() => void> => {
    const win = current();
    if (!win) return () => {};
    return win.onResized(event => handler({ width: event.payload.width, height: event.payload.height }));
  },
  /** Requests a close. The backend still blocks it while recording or processing. */
  close: async () => { await current()?.close(); },
  /** Starts a native window drag. Call it from a primary-button mousedown. */
  startDragging: async () => { await current()?.startDragging(); },
  setSize: async (size: WindowSize) => { await current()?.setSize(new LogicalSize(size.width, size.height)); },
  setMinSize: async (size: WindowSize | null) => { await current()?.setMinSize(size ? new LogicalSize(size.width, size.height) : null); },
  setAlwaysOnTop: async (alwaysOnTop: boolean) => { await current()?.setAlwaysOnTop(alwaysOnTop); },
  /** Inner size in physical pixels. Divide by `scaleFactor()` for logical pixels. */
  innerSize: async (): Promise<WindowSize> => {
    const win = current();
    if (!win) return { width: Math.round(window.innerWidth * window.devicePixelRatio), height: Math.round(window.innerHeight * window.devicePixelRatio) };
    const size = await win.innerSize();
    return { width: size.width, height: size.height };
  },
  scaleFactor: async () => await current()?.scaleFactor() ?? window.devicePixelRatio,
  /** `null` follows the system theme. */
  setTheme: async (theme: WindowTheme | null) => { await current()?.setTheme(theme); },
  /**
   * The native window's own color (a hex string such as '#121215'), shown behind the page while
   * the window resizes or the webview repaints. Windows ignores alpha.
   */
  setBackgroundColor: async (color: string) => { await current()?.setBackgroundColor(color); },
};

type NavigatorWithData = Navigator & { userAgentData?: { platform?: string } };
/** The desktop platform, read from the user agent. Anything unrecognized counts as Linux. */
export function platform(): Platform {
  if (typeof navigator === 'undefined') return 'linux';
  const agent = `${(navigator as NavigatorWithData).userAgentData?.platform ?? ''} ${navigator.userAgent}`;
  if (/mac/i.test(agent)) return 'macos';
  if (/win/i.test(agent)) return 'windows';
  return 'linux';
}

/**
 * A shortcut for `key` on this platform (decision 7): the visible hint ("Ctrl+K", "⌘K")
 * for an aria-hidden <kbd> or tooltip, and the matching `aria-keyshortcuts` value.
 */
export function shortcut(key: string, os: Platform = platform()) {
  const upper = key.toUpperCase();
  return os === 'macos'
    ? { label: `⌘${upper}`, aria: `Meta+${upper}` }
    : { label: `Ctrl+${upper}`, aria: `Control+${upper}` };
}
