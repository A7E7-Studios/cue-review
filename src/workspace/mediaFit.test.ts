import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { availableMediaSize, DEFAULT_ASPECT, fitMedia, mediaAspect, useMediaFit } from './mediaFit';

describe('fitting media to the stage', () => {
  it('is bound by height in a wide stage and by width in a tall one', () => {
    expect(fitMedia({ width: 1000, height: 400 }, 16 / 9)).toEqual({ width: 711, height: 400 });
    expect(fitMedia({ width: 600, height: 900 }, 16 / 9)).toEqual({ width: 600, height: 337 });
  });
  it('never exceeds the available space and rounds down to whole pixels', () => {
    const size = fitMedia({ width: 333.7, height: 187.9 }, 1600 / 900);
    expect(size.width).toBeLessThanOrEqual(333.7);
    expect(size.height).toBeLessThanOrEqual(187.9);
    expect(Number.isInteger(size.width) && Number.isInteger(size.height)).toBe(true);
  });
  it('collapses to nothing without space and falls back to 16:9 for an unknown ratio', () => {
    expect(fitMedia({ width: 0, height: 300 }, 2)).toEqual({ width: 0, height: 0 });
    expect(fitMedia({ width: 500, height: -1 }, 2)).toEqual({ width: 0, height: 0 });
    expect(fitMedia({ width: 1600, height: 2000 }, NaN)).toEqual({ width: 1600, height: 900 });
    expect(mediaAspect(1920, 1080)).toBeCloseTo(16 / 9);
    expect(mediaAspect(0, 1080)).toBe(DEFAULT_ASPECT);
    expect(mediaAspect(undefined, undefined)).toBe(DEFAULT_ASPECT);
  });
  it('leaves room for the controls and their gap only when there are controls', () => {
    expect(availableMediaSize({ width: 800, height: 600 }, 90, 16)).toEqual({ width: 800, height: 494 });
    expect(availableMediaSize({ width: 800, height: 600 }, 0, 16)).toEqual({ width: 800, height: 600 });
    expect(availableMediaSize({ width: 800, height: 60 }, 90, 16)).toEqual({ width: 800, height: 0 });
  });
});

describe('useMediaFit', () => {
  const original = globalThis.ResizeObserver;
  afterEach(() => { globalThis.ResizeObserver = original; });

  it('measures the stage and controls with a ResizeObserver and disconnects on unmount', () => {
    const observed: Element[] = [];
    let notify = () => {};
    const disconnect = vi.fn();
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) { notify = () => callback([], this as unknown as ResizeObserver); }
      observe(element: Element) { observed.push(element); }
      unobserve() {}
      disconnect() { disconnect(); }
    } as unknown as typeof ResizeObserver;
    const stage = document.createElement('div');
    const controls = document.createElement('div');
    stage.style.rowGap = '16px';
    let width = 1000; let height = 600;
    Object.defineProperty(stage, 'clientWidth', { get: () => width });
    Object.defineProperty(stage, 'clientHeight', { get: () => height });
    Object.defineProperty(controls, 'offsetHeight', { get: () => 84 });
    const stageRef = { current: stage }; const controlsRef = { current: controls };
    const { result, unmount } = renderHook(() => useMediaFit(stageRef, controlsRef, 16 / 9));
    expect(observed).toEqual([stage, controls]);
    expect(result.current).toEqual({ width: 888, height: 500 });
    width = 600; height = 800;
    act(() => notify());
    expect(result.current).toEqual({ width: 600, height: 337 });
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
  it('reports nothing where ResizeObserver is unavailable, so CSS sizes the media', () => {
    globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
    const { result } = renderHook(() => useMediaFit({ current: document.createElement('div') }, { current: null }, 2));
    expect(result.current).toBeNull();
  });
});
