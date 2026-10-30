import { useEffect } from 'react';

// Input types that take typed text, where the system's Cut / Copy / Paste menu matters.
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

/** True for a target inside a field that takes typed text. */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const field = target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])');
  if (field instanceof HTMLInputElement) return TEXT_INPUTS.has(field.type);
  return !!field;
}

/** Stops the webview's page menu (Refresh, Save as, Print, …) everywhere but text fields. */
export function guardContextMenu(event: MouseEvent) {
  if (!isTextField(event.target)) event.preventDefault();
}

/** Installs guardContextMenu on the document for the app's lifetime. The app's own menus
 * (the sidebar's) open from their elements' handlers, which run before this one. */
export function useContextMenuGuard() {
  useEffect(() => {
    document.addEventListener('contextmenu', guardContextMenu);
    return () => document.removeEventListener('contextmenu', guardContextMenu);
  }, []);
}
