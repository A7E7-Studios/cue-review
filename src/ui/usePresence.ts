import { useEffect, useLayoutEffect, useState } from 'react';

export function prefersReducedMotion(): boolean {
  const override = document.documentElement.dataset.motion;
  return override === 'reduced' || (override !== 'full' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const update = () => setReduced(prefersReducedMotion());
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    media?.addEventListener('change', update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    update();
    return () => { media?.removeEventListener('change', update); observer.disconnect(); };
  }, []);
  return reduced;
}

export type PresencePhase = 'entering' | 'open' | 'exiting';
export function usePresence(open: boolean, durationMs = 180): {present: boolean; phase: PresencePhase} {
  const reduced = useReducedMotion();
  const [state, setState] = useState<{present: boolean; phase: PresencePhase}>(() => ({present: open, phase: reduced ? 'open' : 'entering'}));
  useLayoutEffect(() => {
    if (reduced) { setState({present: open, phase: open ? 'open' : 'exiting'}); return; }
    let frame = 0;
    let secondFrame = 0;
    let timer = 0;
    if (open) {
      setState({present: true, phase: 'entering'});
      frame = requestAnimationFrame(() => { secondFrame = requestAnimationFrame(() => setState({present: true, phase: 'open'})); });
    } else {
      setState(previous => ({present: previous.present, phase: 'exiting'}));
      timer = window.setTimeout(() => setState({present: false, phase: 'exiting'}), durationMs);
    }
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(secondFrame); clearTimeout(timer); };
  }, [open, durationMs, reduced]);
  return {present: open || state.present, phase: state.phase};
}
