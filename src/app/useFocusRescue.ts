import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** Whether keyboard focus can land on `element` right now. */
export function canTakeFocus(element: Element | null | undefined): element is HTMLElement {
  return element instanceof HTMLElement && element.isConnected && !element.matches(':disabled') && !element.closest('[inert],[hidden]');
}

/**
 * Keeps keyboard focus in the app when the focused control disappears: a toggle that unmounts,
 * a sidebar overlay that closes, or the controls slot switching between draft, recording and review.
 * After each render, if focus fell back to the page while the root is interactive, `choose`
 * names the new home for focus, given the element that had it.
 */
export function useFocusRescue(root: RefObject<HTMLElement | null>, choose: (lost: Element) => HTMLElement | null | undefined) {
  const last = useRef<Element | null>(null);
  const latest = useRef(choose);
  useLayoutEffect(() => { latest.current = choose; });
  useEffect(() => {
    const track = (event: FocusEvent) => { if (event.target instanceof Element) last.current = event.target; };
    // A press starts over: a click on empty space leaves focus with the page on purpose, and a
    // click on a control records that control through focusin right after.
    const press = (event: PointerEvent) => {
      const focused = document.activeElement;
      if (!(focused && focused !== document.body && event.target instanceof Node && focused.contains(event.target))) last.current = null;
    };
    document.addEventListener('focusin', track);
    document.addEventListener('pointerdown', press, true);
    return () => { document.removeEventListener('focusin', track); document.removeEventListener('pointerdown', press, true); };
  }, []);
  useLayoutEffect(() => {
    const lost = last.current;
    const active = document.activeElement;
    if (!lost || (active && active !== document.body) || !root.current || root.current.closest('[inert]')) return;
    // Focus that the user moved away (a click on empty space) is not lost: only rescue removed or disabled controls.
    if (lost.isConnected && !lost.matches(':disabled')) return;
    const target = latest.current(lost);
    if (canTakeFocus(target)) target.focus({ preventScroll: true });
  });
}
