import { beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { CompactDragStrip, TitleBar } from './TitleBar';
import type { WindowSize } from './windowApi';

const api = vi.hoisted(() => ({
  minimize: vi.fn<() => Promise<void>>(),
  toggleMaximize: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
  isMaximized: vi.fn<() => Promise<boolean>>(),
  onResized: vi.fn<(handler: (size: WindowSize) => void) => Promise<() => void>>(),
}));
vi.mock('./windowApi', async importOriginal => ({ ...await importOriginal<typeof import('./windowApi')>(), windowApi: api }));

let resized: ((size: WindowSize) => void) | undefined;
const unlisten = vi.fn();
beforeEach(() => {
  resized = undefined;
  unlisten.mockReset();
  api.minimize.mockReset().mockResolvedValue();
  api.toggleMaximize.mockReset().mockResolvedValue();
  api.close.mockReset().mockResolvedValue();
  api.isMaximized.mockReset().mockResolvedValue(false);
  api.onResized.mockReset().mockImplementation(async handler => { resized = handler; return unlisten; });
});

type Props = ComponentProps<typeof TitleBar>;
function renderBar(overrides: Partial<Props> = {}) {
  const props: Props = { platform: 'windows', sidebarVisible: true, onToggleSidebar: vi.fn(), search: '', onSearch: vi.fn(), onOpenSettings: vi.fn(), ...overrides };
  return { ...render(<TitleBar {...props}/>), props };
}
const dragRegions = (root: HTMLElement) => [...root.querySelectorAll('[data-tauri-drag-region]'), ...(root.hasAttribute('data-tauri-drag-region') ? [root] : [])];

describe('Windows title bar', () => {
  test('names its controls and drives the window', async () => {
    const user = userEvent.setup();
    const { props } = renderBar();
    const bar = screen.getByRole('banner', { name: 'Title bar' });
    expect(within(bar).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Hide sidebar', 'Settings', 'Minimize window', 'Maximize window', 'Close window']);
    await user.click(screen.getByRole('button', { name: 'Minimize window' }));
    await user.click(screen.getByRole('button', { name: 'Maximize window' }));
    await user.click(screen.getByRole('button', { name: 'Close window' }));
    expect(api.minimize).toHaveBeenCalledTimes(1);
    expect(api.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(api.close).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(props.onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  test('swaps Maximize for Restore when the window is maximized or restored', async () => {
    const { unmount } = renderBar();
    expect(await screen.findByRole('button', { name: 'Maximize window' })).toBeVisible();
    expect(api.onResized).toHaveBeenCalledTimes(1);
    api.isMaximized.mockResolvedValue(true);
    await act(async () => resized?.({ width: 2560, height: 1400 }));
    expect(await screen.findByRole('button', { name: 'Restore window' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Maximize window' })).not.toBeInTheDocument();
    api.isMaximized.mockResolvedValue(false);
    await act(async () => resized?.({ width: 1280, height: 820 }));
    expect(await screen.findByRole('button', { name: 'Maximize window' })).toBeVisible();
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  test('starts maximized when the window already is, and follows the maximized prop without listening', async () => {
    api.isMaximized.mockResolvedValue(true);
    const first = renderBar();
    expect(await screen.findByRole('button', { name: 'Restore window' })).toBeVisible();
    first.unmount();
    api.onResized.mockClear();
    const { rerender, props } = renderBar({ maximized: false });
    expect(screen.getByRole('button', { name: 'Maximize window' })).toBeVisible();
    rerender(<TitleBar {...props} maximized/>);
    expect(screen.getByRole('button', { name: 'Restore window' })).toBeVisible();
    expect(api.onResized).not.toHaveBeenCalled();
  });

  test('drag regions cover only empty bar areas', () => {
    renderBar();
    const bar = screen.getByRole('banner', { name: 'Title bar' });
    expect(bar).toHaveAttribute('data-tauri-drag-region', '');
    for (const region of dragRegions(bar)) {
      expect(region.matches('button, input, kbd, .chrome-search')).toBe(false);
      expect(region.getAttribute('data-tauri-drag-region')).toBe('');
    }
    for (const control of within(bar).getAllByRole('button')) expect(control.closest('[data-tauri-drag-region="deep"]')).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Search recordings' }).closest('.chrome-search')).not.toHaveAttribute('data-tauri-drag-region');
    expect(bar.querySelector('.chrome-center')).toHaveAttribute('data-tauri-drag-region');
    expect(bar.querySelector('.chrome-brand')).toHaveAttribute('data-tauri-drag-region');
  });

  test('Ctrl+K focuses search; the hint is aria-hidden and the field announces the shortcut', async () => {
    const user = userEvent.setup();
    const searchRef = createRef<HTMLInputElement>();
    const { props } = renderBar({ searchRef, search: 'lib' });
    const field = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search recordings' });
    expect(searchRef.current).toBe(field);
    expect(field).toHaveAttribute('aria-keyshortcuts', 'Control+K');
    expect(field).toHaveAttribute('placeholder', 'Search recordings');
    const hint = field.parentElement!.querySelector('kbd')!;
    expect(hint).toHaveTextContent('Ctrl+K');
    expect(hint).toHaveAttribute('aria-hidden', 'true');
    await user.keyboard('{Meta>}k{/Meta}');
    expect(field).not.toHaveFocus();
    await user.keyboard('{Control>}k{/Control}');
    expect(field).toHaveFocus();
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 3]);
    await user.keyboard('x');
    expect(props.onSearch).toHaveBeenLastCalledWith('x');
  });

  test('Ctrl+K leaves dialogs, menus and an inert title bar alone', () => {
    renderBar();
    const field = screen.getByRole('searchbox', { name: 'Search recordings' });
    for (const role of ['dialog', 'menu']) {
      const surface = document.body.appendChild(document.createElement('div'));
      surface.setAttribute('role', role);
      const inside = surface.appendChild(document.createElement('button'));
      expect(fireEvent.keyDown(inside, { key: 'k', ctrlKey: true })).toBe(true);
      expect(field).not.toHaveFocus();
      surface.remove();
    }
    field.closest('header')!.setAttribute('inert', '');
    expect(fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })).toBe(true);
    expect(field).not.toHaveFocus();
    field.closest('header')!.removeAttribute('inert');
    expect(fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })).toBe(false);
    expect(field).toHaveFocus();
  });
});

describe('macOS and Linux toolbars', () => {
  test('macOS uses ⌘K, keeps native window controls, and shows the sidebar toggle only while hidden', async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderBar({ platform: 'macos' });
    const bar = screen.getByRole('banner', { name: 'Toolbar' });
    expect(within(bar).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Settings']);
    expect(bar.querySelector('.chrome-traffic-lights')).toBeNull();
    const field = screen.getByRole('searchbox', { name: 'Search recordings' });
    expect(field).toHaveAttribute('aria-keyshortcuts', 'Meta+K');
    expect(field.parentElement!.querySelector('kbd')).toHaveTextContent('⌘K');
    await user.keyboard('{Control>}k{/Control}');
    expect(field).not.toHaveFocus();
    await user.keyboard('{Meta>}k{/Meta}');
    expect(field).toHaveFocus();
    expect(api.isMaximized).not.toHaveBeenCalled();

    rerender(<TitleBar {...props} sidebarVisible={false}/>);
    const space = bar.querySelector('.chrome-traffic-lights')!;
    expect(space).toHaveAttribute('aria-hidden', 'true');
    expect(space).toHaveAttribute('data-tauri-drag-region');
    expect(space.nextElementSibling).toBe(screen.getByRole('button', { name: 'Show sidebar' }));
    for (const region of dragRegions(bar)) expect(region.matches('button, input, .chrome-search')).toBe(false);
  });

  test('Linux shows the sidebar toggle and no window controls or drag regions', () => {
    renderBar({ platform: 'linux', sidebarVisible: false });
    const bar = screen.getByRole('banner', { name: 'Toolbar' });
    expect(within(bar).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Show sidebar', 'Settings']);
    expect(dragRegions(bar)).toEqual([]);
    expect(screen.getByRole('searchbox', { name: 'Search recordings' })).toHaveAttribute('aria-keyshortcuts', 'Control+K');
  });
});

describe('compact drag strip', () => {
  test('drops search and the sidebar toggle; Windows keeps Minimize and Close', async () => {
    const user = userEvent.setup();
    renderBar({ compact: true });
    const strip = screen.getByRole('banner', { name: 'Title bar' });
    expect(within(strip).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Minimize window', 'Close window']);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(strip).toHaveAttribute('data-tauri-drag-region');
    await user.click(screen.getByRole('button', { name: 'Close window' }));
    expect(api.close).toHaveBeenCalledTimes(1);
    expect(api.onResized).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })).toBe(true);
  });

  test('macOS leaves the traffic lights clear and Linux keeps its native title bar', () => {
    const { container, rerender } = render(<CompactDragStrip platform="macos"/>);
    const strip = container.firstElementChild!;
    expect(strip).toHaveAttribute('data-tauri-drag-region');
    expect(strip.querySelector('.chrome-traffic-lights')).toHaveAttribute('aria-hidden', 'true');
    expect(strip.querySelector('button, input')).toBeNull();
    rerender(<CompactDragStrip platform="linux"/>);
    expect(container).toBeEmptyDOMElement();
  });
});
