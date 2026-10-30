import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../ui/usePresence';
import type { PresencePhase } from '../ui/usePresence';

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

/** How long the sidebar takes to slide out or in; `--motion-sidebar` in tokens.css. */
export const SIDEBAR_SLIDE_MS = 200;

/**
 * Keeps the sidebar mounted while it slides out (window-chrome spec). `phase` is `entering` for the
 * first frames of a slide in, `exiting` while it slides out, `open` otherwise; CSS animates the
 * change from one to the next. `instant` (while recording) and reduced motion skip the slide, and
 * the first render never slides. `overlay` holds its last value while the sidebar slides out.
 */
export function useSidebarSlide(visible: boolean, overlay: boolean, instant: boolean) {
  const reduced = useReducedMotion();
  const skip = instant || reduced;
  const skipRef = useRef(skip);
  skipRef.current = skip;
  const [state, setState] = useState<{ present: boolean; phase: PresencePhase }>({ present: visible, phase: 'open' });
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    if (skipRef.current) { setState({ present: visible, phase: 'open' }); return; }
    let frame = 0;
    let secondFrame = 0;
    let timer = 0;
    if (visible) {
      setState({ present: true, phase: 'entering' });
      frame = requestAnimationFrame(() => { secondFrame = requestAnimationFrame(() => setState({ present: true, phase: 'open' })); });
    } else {
      setState(previous => ({ present: previous.present, phase: 'exiting' }));
      timer = window.setTimeout(() => setState({ present: false, phase: 'open' }), SIDEBAR_SLIDE_MS);
    }
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(secondFrame); clearTimeout(timer); };
  }, [visible]);
  const lastOverlay = useRef(overlay);
  if (visible) lastOverlay.current = overlay;
  if (skip) return { present: visible, phase: 'open' as PresencePhase, overlay };
  return { present: visible || state.present, phase: state.phase, overlay: visible ? overlay : lastOverlay.current };
}
