import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Platform } from '../chrome/windowApi';

// Workspace shortcuts (decision 8). Ctrl/⌘+K and Ctrl/⌘+F also work from a text field (search spec);
// the others never fire inside one.

/**
 * The letter a shortcut means. `event.key` follows the keyboard layout, so it is used when it
 * is a Latin letter; other layouts (Cyrillic "к", Greek "ρ") fall back to the physical key.
 */
export function shortcutLetter(event: KeyboardEvent): string {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  const physical = /^Key([A-Z])$/.exec(event.code ?? '');
  return physical ? physical[1].toLowerCase() : '';
}

/** Ctrl+`key` on Windows and Linux or ⌘`key` on macOS, with no other modifier. */
export function isCommand(event: KeyboardEvent, os: Platform, key: string): boolean {
  const modifier = os === 'macos' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return modifier && !event.altKey && !event.shiftKey && shortcutLetter(event) === key;
}

/**
 * Keys the webview would turn into a page reload, which drops the workspace mid-recording:
 * F5 with any modifier, and Ctrl or ⌘ with R (also with Shift, on any layout).
 */
export function isReload(event: KeyboardEvent): boolean {
  if (event.key === 'F5' || event.code === 'F5') return true;
  return (event.ctrlKey || event.metaKey) && !event.altKey && (event.code === 'KeyR' || shortcutLetter(event) === 'r');
}

const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);
/** A field that takes typing, where shortcuts belong to the field. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && TEXT_TYPES.has(target.type);
}

/** A control that Space activates itself, so Space must not also play or pause. */
const ACTIVATES_ON_SPACE = 'button, a[href], summary, input:not([type="range"]), [role="button"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="option"], [role="tab"]';
const BLOCKING = '[role="menu"], [role="dialog"], [role="alertdialog"], [inert]';

export interface Shortcuts {
  platform: Platform;
  /** False while a dialog, a picker or a menu is open: every shortcut is ignored. */
  enabled: boolean;
  /** Ctrl/⌘+R: record or stop in a draft, Record more in review, Stop while recording. */
  onRecord: () => void;
  /** Ctrl/⌘+N: new recording. */
  onNew: () => void;
  /** Space, when there is something to play. */
  onTogglePlay?: () => void;
  /** ← and →, when there is something to seek. */
  onSeekBy?: (deltaMs: number) => void;
  /** Ctrl/⌘+K: open search; also from a text field. */
  onSearch?: () => void;
  /** Ctrl/⌘+F: find in the open transcript; also from a text field. */
  onFind?: () => void;
  /** Escape anywhere else, for example to close the sidebar overlay. */
  onEscape?: () => void;
}

export const SEEK_STEP_MS = 5000;

export function useShortcuts(shortcuts: Shortcuts) {
  const latest = useRef(shortcuts);
  useLayoutEffect(() => { latest.current = shortcuts; });
  useEffect(() => {
    // Capture phase on the window runs before any field, menu or dialog handler, including
    // ones that stop propagation, so a reload key never reaches the webview: not in a text
    // field, not behind a dialog, not while a picker is open, not on another layout.
    const swallowReload = (event: KeyboardEvent) => { if (isReload(event)) event.preventDefault(); };
    const onKey = (event: KeyboardEvent) => {
      const current = latest.current;
      const target = event.target;
      // The reload guard above prevents the default of Ctrl/⌘+R itself; that is not a component claiming the key.
      if (event.defaultPrevented && !isReload(event)) return;
      if (event.key === 'Escape') {
        if (current.enabled && current.onEscape && !(target instanceof Element && target.closest(BLOCKING))) { event.preventDefault(); current.onEscape(); }
        return;
      }
      if (!current.enabled || (target instanceof Element && target.closest(BLOCKING))) return;
      if (isCommand(event, current.platform, 'k') && current.onSearch) { event.preventDefault(); if (!event.repeat) current.onSearch(); return; }
      // Ctrl/⌘+F never opens the webview's own find bar, also where there is no transcript to find in.
      if (isCommand(event, current.platform, 'f')) { event.preventDefault(); if (!event.repeat) current.onFind?.(); return; }
      if (isEditable(target)) return;
      if (isCommand(event, current.platform, 'r')) { event.preventDefault(); if (!event.repeat) current.onRecord(); return; }
      if (isCommand(event, current.platform, 'n')) { event.preventDefault(); if (!event.repeat) current.onNew(); return; }
      // A modifier combination never falls through to a bare-key action.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === ' ' || event.code === 'Space') {
        if (!current.onTogglePlay || (target instanceof Element && target.closest(ACTIVATES_ON_SPACE))) return;
        event.preventDefault();
        if (!event.repeat) current.onTogglePlay();
      } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && current.onSeekBy) {
        event.preventDefault();
        current.onSeekBy(event.key === 'ArrowLeft' ? -SEEK_STEP_MS : SEEK_STEP_MS);
      }
    };
    window.addEventListener('keydown', swallowReload, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', swallowReload, true); window.removeEventListener('keydown', onKey); };
  }, []);
}
