import { fireEvent, render, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Platform } from '../chrome/windowApi';
import { isCommand, isReload, shortcutLetter, useShortcuts } from './useShortcuts';
import type { Shortcuts } from './useShortcuts';

function setup(overrides: Partial<Shortcuts> = {}, platform: Platform = 'windows') {
  const handlers = { onRecord: vi.fn(), onNew: vi.fn() };
  const hook = renderHook((props: Partial<Shortcuts>) => useShortcuts({ platform, enabled: true, ...handlers, ...props }), { initialProps: overrides });
  return { ...handlers, rerender: hook.rerender };
}
/** Dispatches a keydown on `target` and reports whether its default (the webview's reload) was prevented. */
function press(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('reload keys', () => {
  it('always swallows Ctrl+R and F5, even in a text field, a dialog, an open menu or while shortcuts are off', () => {
    const { onRecord, rerender } = setup();
    render(<>
      <input type="search" aria-label="Search"/>
      <div role="dialog"><button>Cancel</button></div>
      <div role="menu" onKeyDown={event => event.stopPropagation()}><button role="menuitem">Rename</button></div>
    </>);
    const field = document.querySelector('input')!;
    const dialogButton = document.querySelector('[role=dialog] button')!;
    const menuItem = document.querySelector('[role=menuitem]')!;
    for (const target of [field, dialogButton, menuItem, document.body]) {
      expect(press(target, { key: 'r', code: 'KeyR', ctrlKey: true })).toBe(true);
      expect(press(target, { key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true })).toBe(true);
      expect(press(target, { key: 'F5', code: 'F5' })).toBe(true);
      expect(press(target, { key: 'F5', code: 'F5', ctrlKey: true })).toBe(true);
    }
    // Only the plain shortcut on the workspace records; the field, dialog and menu keep it inert.
    expect(onRecord).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    expect(press(document.body, { key: 'r', code: 'KeyR', ctrlKey: true })).toBe(true);
    expect(onRecord).toHaveBeenCalledTimes(1);
  });

  it('never lets Ctrl+F reach the webview, and finds only where a transcript can', () => {
    const onFind = vi.fn();
    const { rerender } = setup();
    render(<>
      <input type="search" aria-label="Search"/>
      <div role="dialog"><button>Cancel</button></div>
    </>);
    const field = document.querySelector('input')!;
    const dialogButton = document.querySelector('[role=dialog] button')!;
    // No transcript to find in: still swallowed.
    for (const target of [field, dialogButton, document.body]) expect(press(target, { key: 'f', code: 'KeyF', ctrlKey: true })).toBe(true);
    rerender({ onFind });
    expect(press(field, { key: 'f', code: 'KeyF', ctrlKey: true })).toBe(true);
    expect(press(document.body, { key: 'f', code: 'KeyF', ctrlKey: true })).toBe(true);
    expect(onFind).toHaveBeenCalledTimes(2);
    // Behind a dialog it is swallowed and finds nothing.
    expect(press(dialogButton, { key: 'f', code: 'KeyF', ctrlKey: true })).toBe(true);
    expect(onFind).toHaveBeenCalledTimes(2);
  });

  it('matches the physical R key on non-Latin layouts, for both the guard and the shortcut', () => {
    const { onRecord, onNew } = setup();
    expect(press(document.body, { key: 'к', code: 'KeyR', ctrlKey: true })).toBe(true);
    expect(onRecord).toHaveBeenCalledTimes(1);
    expect(press(document.body, { key: 'т', code: 'KeyN', ctrlKey: true })).toBe(true);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('swallows ⌘R on macOS too, and records with it', () => {
    const { onRecord } = setup({}, 'macos');
    expect(press(document.body, { key: 'r', code: 'KeyR', metaKey: true })).toBe(true);
    expect(onRecord).toHaveBeenCalledTimes(1);
  });

  it('ignores a repeated key for the action but still swallows it', () => {
    const { onRecord } = setup();
    expect(press(document.body, { key: 'r', code: 'KeyR', ctrlKey: true, repeat: true })).toBe(true);
    expect(onRecord).not.toHaveBeenCalled();
  });

  it('leaves other keys alone', () => {
    setup();
    expect(press(document.body, { key: 'r', code: 'KeyR' })).toBe(false);
    expect(press(document.body, { key: 'r', code: 'KeyR', ctrlKey: true, altKey: true })).toBe(false);
    expect(press(document.body, { key: 'F6', code: 'F6' })).toBe(false);
  });
});

describe('shortcut letters', () => {
  const event = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
  it('uses the typed letter on Latin layouts and the physical key otherwise', () => {
    expect(shortcutLetter(event({ key: 'R', code: 'KeyR' }))).toBe('r');
    // Dvorak: the key labelled R sits where QWERTY has O.
    expect(shortcutLetter(event({ key: 'r', code: 'KeyO' }))).toBe('r');
    expect(shortcutLetter(event({ key: 'к', code: 'KeyR' }))).toBe('r');
    expect(shortcutLetter(event({ key: '5', code: 'Digit5' }))).toBe('');
  });
  it('needs exactly the platform modifier for a command', () => {
    expect(isCommand(event({ key: 'к', code: 'KeyR', ctrlKey: true }), 'windows', 'r')).toBe(true);
    expect(isCommand(event({ key: 'r', code: 'KeyR', ctrlKey: true, shiftKey: true }), 'windows', 'r')).toBe(false);
    expect(isCommand(event({ key: 'r', code: 'KeyR', ctrlKey: true }), 'macos', 'r')).toBe(false);
    expect(isReload(event({ key: 'r', code: 'KeyR', ctrlKey: true, shiftKey: true }))).toBe(true);
  });
});

it('keeps the App-level Escape and Space behaviour for components that claim a key', () => {
  const onTogglePlay = vi.fn();
  setup({ onTogglePlay });
  render(<div onKeyDown={event => { if (event.key === ' ') event.preventDefault(); }}><span tabIndex={0}>row</span></div>);
  fireEvent.keyDown(document.querySelector('span')!, { key: ' ', code: 'Space' });
  expect(onTogglePlay).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
  expect(onTogglePlay).toHaveBeenCalledTimes(1);
});
