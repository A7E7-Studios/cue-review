import { afterEach, expect, test } from 'vitest';
import { renderHook } from '@testing-library/react';
import { isTextField, useContextMenuGuard } from './useContextMenuGuard';

function rightClick(target: Element) {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

afterEach(() => { document.body.innerHTML = ''; });

test('suppresses the webview menu outside text fields', () => {
  const { unmount } = renderHook(() => useContextMenuGuard());
  document.body.innerHTML = '<main><video></video><p><span role="button">word</span></p><button>Play</button><input type="range"><input type="checkbox"><select><option>Light</option></select></main>';
  for (const selector of ['main', 'video', 'span', 'button', 'input[type=range]', 'input[type=checkbox]', 'select']) {
    expect(rightClick(document.querySelector(selector)!), selector).toBe(true);
  }
  unmount();
  expect(rightClick(document.querySelector('main')!)).toBe(false);
});

test('keeps the system menu in text fields', () => {
  renderHook(() => useContextMenuGuard());
  document.body.innerHTML = '<input type="search"><input><textarea></textarea><div contenteditable="true"><b>title</b></div>';
  for (const selector of ['input[type=search]', 'input:not([type])', 'textarea', 'b']) {
    expect(rightClick(document.querySelector(selector)!), selector).toBe(false);
  }
});

test('isTextField ignores non-elements and controls that take no typed text', () => {
  expect(isTextField(null)).toBe(false);
  expect(isTextField(document)).toBe(false);
  const range = document.createElement('input');
  range.type = 'range';
  expect(isTextField(range)).toBe(false);
});
