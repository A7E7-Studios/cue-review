import { useCallback, useRef, useState } from 'react';
import { windowApi } from '../chrome/windowApi';
import type { WindowSize } from '../chrome/windowApi';

export const COMPACT_SIZE: WindowSize = { width: 520, height: 320 };
export const COMPACT_MIN_SIZE: WindowSize = { width: 420, height: 250 };
/** tauri.conf.json's minWidth and minHeight. */
export const WINDOW_MIN_SIZE: WindowSize = { width: 640, height: 480 };
const FALLBACK_SIZE: WindowSize = { width: 1200, height: 780 };

/**
 * Compact recording mode: a small always-on-top window holding only the recording dock.
 * Leaving it restores the size the window had before.
 */
export function useCompactWindow(report: (problem: unknown) => void) {
  const [compact, setCompact] = useState(false);
  const restored = useRef<WindowSize | null>(null);
  const changing = useRef(false);
  /** A change asked for while another was under way, for example Stop during the shrink. */
  const queued = useRef<boolean | null>(null);

  const change = useCallback(async function apply(next: boolean): Promise<void> {
    if (changing.current) { queued.current = next; return; }
    changing.current = true;
    // The layout switches while the window is large: compact before shrinking, full after growing.
    let shrunk = false;
    try {
      if (next) {
        const size = await windowApi.innerSize();
        const scale = await windowApi.scaleFactor();
        restored.current = { width: size.width / scale, height: size.height / scale };
        setCompact(true);
        await windowApi.setMinSize(COMPACT_MIN_SIZE);
        await windowApi.setSize(COMPACT_SIZE);
        shrunk = true;
        await windowApi.setAlwaysOnTop(true);
      } else {
        await windowApi.setAlwaysOnTop(false);
        await windowApi.setSize(restored.current ?? FALLBACK_SIZE);
        await windowApi.setMinSize(WINDOW_MIN_SIZE);
        setCompact(false);
      }
    } catch (problem) {
      report(problem);
      // Keep the layout that fits the size the window ended up with.
      if (next && !shrunk) setCompact(false);
    } finally {
      changing.current = false;
      const again = queued.current;
      queued.current = null;
      if (again !== null && again !== next) await apply(again);
    }
  }, [report]);

  const toggleCompact = useCallback(() => change(!compact), [change, compact]);
  const exitCompact = useCallback(() => change(false), [change]);
  return { compact, toggleCompact, exitCompact };
}
