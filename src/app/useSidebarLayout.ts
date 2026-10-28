import { useCallback, useEffect, useState } from 'react';

/** Below this window width the sidebar hides, and the toggle shows it over the sheet (decision 13). */
export const SIDEBAR_AUTO_HIDE_BELOW = 1000;
const isNarrow = () => typeof window !== 'undefined' && window.innerWidth < SIDEBAR_AUTO_HIDE_BELOW;

export function useSidebarLayout() {
  const [narrow, setNarrow] = useState(isNarrow);
  /** Whether a wide window shows the sidebar beside the sheet. */
  const [docked, setDocked] = useState(true);
  /** Whether a narrow window shows the sidebar over the sheet. */
  const [floating, setFloating] = useState(false);

  useEffect(() => {
    const resize = () => setNarrow(isNarrow());
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => { if (!narrow) setFloating(false); }, [narrow]);

  const toggle = useCallback(() => { if (narrow) setFloating(value => !value); else setDocked(value => !value); }, [narrow]);
  const show = useCallback(() => { if (narrow) setFloating(true); else setDocked(true); }, [narrow]);
  const hide = useCallback(() => { if (narrow) setFloating(false); else setDocked(false); }, [narrow]);
  const dismissOverlay = useCallback(() => setFloating(false), []);

  const overlay = narrow && floating;
  return { visible: narrow ? floating : docked, overlay, toggle, show, hide, dismissOverlay };
}
