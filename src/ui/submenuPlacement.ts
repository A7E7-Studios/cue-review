export interface Box { left: number; top: number; right: number; bottom: number }

/** How far a submenu overlaps its menu's edge, and how far its first item sits below its own top. */
const OVERLAP = 4;
const INSET = 4;

/**
 * Where a submenu opens beside its menu, as the Claude app's (Radix) submenus do: to the right of
 * the menu with its first item level with the trigger, flipped to the left when the right has no
 * room, and shifted up so it stays `margin` inside the viewport.
 */
export function placeSubmenu(trigger: Box, menu: Box, size: { width: number; height: number }, viewport: { width: number; height: number }, margin = 8) {
  let side: 'right' | 'left' = 'right';
  let left = menu.right - OVERLAP;
  if (left + size.width > viewport.width - margin) {
    const flipped = menu.left - size.width + OVERLAP;
    // Flip only when the left has more room; otherwise clamp on the right.
    if (flipped >= margin || menu.left > viewport.width - menu.right) { side = 'left'; left = flipped; }
  }
  left = Math.max(margin, Math.min(left, viewport.width - size.width - margin));
  const top = Math.max(margin, Math.min(trigger.top - INSET, viewport.height - size.height - margin));
  return { left, top, side };
}
