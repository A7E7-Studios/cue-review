import { describe, expect, it } from 'vitest';
import { placeSubmenu } from './submenuPlacement';

const box = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height });
const viewport = { width: 1280, height: 820 };
const size = { width: 200, height: 160 };

describe('placeSubmenu', () => {
  it('opens to the right with its first item level with the trigger', () => {
    const menu = box(120, 140, 220, 120);
    const trigger = box(124, 144, 212, 32);
    expect(placeSubmenu(trigger, menu, size, viewport)).toEqual({ left: 336, top: 140, side: 'right' });
  });
  it('flips to the left at the right edge', () => {
    const menu = box(1000, 140, 220, 120);
    const trigger = box(1004, 144, 212, 32);
    expect(placeSubmenu(trigger, menu, size, viewport)).toEqual({ left: 804, top: 140, side: 'left' });
  });
  it('shifts up at the bottom edge', () => {
    const menu = box(120, 700, 220, 100);
    const trigger = box(124, 740, 212, 32);
    expect(placeSubmenu(trigger, menu, size, viewport).top).toBe(820 - 160 - 8);
  });
  it('stays inside a viewport too narrow for either side', () => {
    const menu = box(40, 140, 220, 120);
    const trigger = box(44, 144, 212, 32);
    const placed = placeSubmenu(trigger, menu, size, { width: 400, height: 820 });
    expect(placed.left).toBeGreaterThanOrEqual(8);
    expect(placed.left + size.width).toBeLessThanOrEqual(392);
  });
});
