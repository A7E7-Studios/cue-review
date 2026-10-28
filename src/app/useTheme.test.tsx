import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from './useTheme';

const windowApi = vi.hoisted(() => ({ setTheme: vi.fn(), setBackgroundColor: vi.fn() }));
vi.mock('../chrome/windowApi', () => ({ windowApi }));

// The real tokens (Vitest turns CSS imports into empty modules), so the native color follows tokens.css.
const fs = 'node:fs';
const { readFileSync } = await import(/* @vite-ignore */ fs) as { readFileSync: (path: string, encoding: 'utf8') => string };
const tokens = readFileSync('src/ui/tokens.css', 'utf8');

describe('useTheme', () => {
  let style: HTMLStyleElement;
  beforeEach(() => {
    vi.clearAllMocks();
    windowApi.setTheme.mockResolvedValue(undefined);
    windowApi.setBackgroundColor.mockResolvedValue(undefined);
    localStorage.clear();
    style = document.createElement('style');
    style.textContent = tokens;
    document.head.append(style);
  });
  afterEach(() => { style.remove(); delete document.documentElement.dataset.theme; });

  it('gives the native window the ground color of each theme on Windows', () => {
    const { result } = renderHook(() => useTheme(vi.fn(), 'windows'));
    expect(windowApi.setTheme).toHaveBeenLastCalledWith('light');
    expect(windowApi.setBackgroundColor).toHaveBeenLastCalledWith('#ECEEF2');
    act(() => result.current[1]('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(windowApi.setTheme).toHaveBeenLastCalledWith('dark');
    expect(windowApi.setBackgroundColor).toHaveBeenLastCalledWith('#121215');
    expect(localStorage.getItem('cuereview.theme')).toBe('dark');
  });

  it('uses the sheet on macOS, where the sheet is the window', () => {
    localStorage.setItem('cuereview.theme', 'dark');
    const { result } = renderHook(() => useTheme(vi.fn(), 'macos'));
    expect(windowApi.setBackgroundColor).toHaveBeenLastCalledWith('#1A1A1E');
    act(() => result.current[1]('light'));
    expect(windowApi.setBackgroundColor).toHaveBeenLastCalledWith('#FFFFFF');
  });

  it('reports a refused color and leaves the native window alone without tokens', async () => {
    const report = vi.fn();
    windowApi.setBackgroundColor.mockRejectedValueOnce('Not allowed: set_background_color');
    renderHook(() => useTheme(report, 'linux'));
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith('Not allowed: set_background_color'));
    style.remove();
    vi.clearAllMocks();
    const { result } = renderHook(() => useTheme(report, 'linux'));
    act(() => result.current[1]('dark'));
    expect(windowApi.setTheme).toHaveBeenLastCalledWith('dark');
    expect(windowApi.setBackgroundColor).not.toHaveBeenCalled();
  });
});
