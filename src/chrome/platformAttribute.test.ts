import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.platform;
});

describe('root attributes before the first paint', () => {
  it('applies the saved dark theme as soon as the module loads, before React mounts', async () => {
    localStorage.setItem('cuereview.theme', 'dark');
    vi.resetModules();
    await import('./platformAttribute');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(['windows', 'macos', 'linux']).toContain(document.documentElement.dataset.platform);
  });

  it('falls back to light without a saved theme or without storage', async () => {
    const { applyRootAttributes } = await import('./platformAttribute');
    const root = document.createElement('div');
    applyRootAttributes(root);
    expect(root.dataset.theme).toBe('light');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage is disabled'); });
    applyRootAttributes(root);
    expect(root.dataset.theme).toBe('light');
  });
});
