// Sizes the media box to fit the stage in both width and height (decision 1).
// The stage fills the space under the title; the controls slot sits directly
// under the media, so the media gets what is left after the controls and the gap.
import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

export interface Size { width: number; height: number }
/** Used until the media reports its own size, and for the empty states. */
export const DEFAULT_ASPECT = 16 / 9;

/** width ÷ height when both are positive and finite, otherwise DEFAULT_ASPECT. */
export function mediaAspect(width?: number, height?: number): number {
  return width && height && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width / height : DEFAULT_ASPECT;
}

/** The largest box of `aspect` that fits inside `available`, in whole pixels. */
export function fitMedia(available: Size, aspect: number): Size {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT;
  const width = Math.max(0, Number.isFinite(available.width) ? available.width : 0);
  const height = Math.max(0, Number.isFinite(available.height) ? available.height : 0);
  if (!width || !height) return { width: 0, height: 0 };
  // The epsilon keeps exact fits (400 × 16/9 ÷ 16/9) from flooring a pixel short.
  if (width / height > ratio) {
    const fittedHeight = Math.floor(height);
    return { width: Math.floor(fittedHeight * ratio + 1e-6), height: fittedHeight };
  }
  const fittedWidth = Math.floor(width);
  return { width: fittedWidth, height: Math.floor(fittedWidth / ratio + 1e-6) };
}

/** The space left for the media inside a stage of `stage` after the controls and the gap between them. */
export function availableMediaSize(stage: Size, controlsHeight: number, gap: number): Size {
  const reserved = controlsHeight > 0 ? controlsHeight + Math.max(0, gap) : 0;
  return { width: Math.max(0, stage.width), height: Math.max(0, stage.height - reserved) };
}

/** Content-box size of an element (what ResizeObserver reports as contentRect). */
function contentSize(element: HTMLElement): Size {
  const style = getComputedStyle(element);
  const px = (value: string) => parseFloat(value) || 0;
  return {
    width: element.clientWidth - px(style.paddingLeft) - px(style.paddingRight),
    height: element.clientHeight - px(style.paddingTop) - px(style.paddingBottom),
  };
}

/**
 * Observes `stage` and `controls` with a ResizeObserver and returns the fitted media
 * size, or null before the stage has been measured (or where ResizeObserver is missing).
 */
export function useMediaFit(stage: RefObject<HTMLElement | null>, controls: RefObject<HTMLElement | null>, aspect: number): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const root = stage.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const box = contentSize(root);
      const slot = controls.current;
      const gap = parseFloat(getComputedStyle(root).rowGap) || 0;
      const next = fitMedia(availableMediaSize(box, slot?.offsetHeight ?? 0, gap), aspect);
      setSize(current => current && current.width === next.width && current.height === next.height ? current : next.width && next.height ? next : null);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    if (controls.current) observer.observe(controls.current);
    measure();
    return () => observer.disconnect();
  }, [stage, controls, aspect]);
  return size;
}
