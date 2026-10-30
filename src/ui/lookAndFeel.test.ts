import { describe, expect, it } from 'vitest';

// Read the stylesheets themselves (Vitest turns CSS imports into empty modules). The project has no Node types, hence the cast.
const fs = 'node:fs';
const { readFileSync, readdirSync } = await import(/* @vite-ignore */ fs) as {
  readFileSync: (path: string, encoding: 'utf8') => string;
  readdirSync: (path: string, options: { recursive: true }) => string[];
};
const read = (path: string) => readFileSync(path, 'utf8');
const stylesheets = readdirSync('src', { recursive: true }).filter(path => path.endsWith('.css')).map(path => `src/${path.replaceAll('\\', '/')}`);
const tokens = read('src/ui/tokens.css');
const darkBlock = tokens.slice(tokens.indexOf(":root[data-theme='dark']"));
/** A token's value in the light theme (its first declaration) or in the dark block. */
const token = (name: string, theme: 'light' | 'dark' = 'light') =>
  new RegExp(`--${name}:\\s*([^;]+);`).exec(theme === 'light' ? tokens : darkBlock)?.[1].trim();
const alpha = (rgba?: string) => Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(rgba ?? '')?.[1]);
const luminance = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
  .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);

describe('scrollbars', () => {
  it('every scroll area uses the app scrollbar', () => {
    // Chromium drops ::-webkit-scrollbar styling for any element that sets the standard properties.
    for (const path of stylesheets) expect(read(path), path).not.toMatch(/scrollbar-(width|color)\s*:/);
    const base = read('src/styles.css');
    expect(base).toMatch(/::-webkit-scrollbar\s*{[^}]*width:\s*10px/);
    expect(base).toMatch(/::-webkit-scrollbar-button\s*{\s*display:\s*none/);
    expect(base).toMatch(/::-webkit-scrollbar-thumb\s*{[^}]*border-radius:\s*var\(--radius-pill\)[^}]*var\(--color-scrollbar\)/);
    expect(base).toMatch(/::-webkit-scrollbar-thumb:hover\s*{[^}]*var\(--color-scrollbar-hover\)/);
    for (const theme of ['light', 'dark'] as const) {
      expect(alpha(token('color-scrollbar-hover', theme))).toBeGreaterThan(alpha(token('color-scrollbar', theme)));
    }
  });

  it('keeps the dialog scrollbar clear of its corners', () => {
    expect(read('src/ui/Dialog.css')).toMatch(/\.ui-dialog::-webkit-scrollbar-track\s*{\s*margin-block:\s*12px/);
  });
});

describe('dialogs', () => {
  it('darkens the backdrop in the dark theme and lifts the dialog', () => {
    expect(read('src/ui/Dialog.css')).toMatch(/\.ui-dialog-backdrop\s*{[^}]*background:\s*var\(--color-scrim/);
    expect(token('color-scrim', 'dark')).toBe('rgba(0, 0, 0, .50)');
    const dialog = token('color-dialog', 'dark')!;
    expect(luminance(dialog)).toBeGreaterThan(luminance(token('color-sheet', 'dark')!));
    // Tertiary text stays legible on the lifted surface (WCAG 2.2: 4.5:1).
    const [text, surface] = [luminance(token('color-text-tertiary', 'dark')!), luminance(dialog)];
    expect((text + 0.05) / (surface + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect(read('src/dialogs/SettingsDialog.css')).toMatch(/background:\s*var\(--color-dialog\)/);
  });

  it('keeps the light theme backdrop', () => {
    expect(token('color-scrim')).toBe('rgba(16, 20, 26, .33)');
    expect(token('color-dialog')).toBe('var(--color-sheet)');
  });
});

describe('form controls', () => {
  it('styles the Appearance dropdown and its open list', () => {
    const settings = read('src/dialogs/SettingsDialog.css');
    expect(settings).toMatch(/@supports \(appearance: base-select\)/);
    expect(settings).toMatch(/\.settings-dialog select::picker\(select\)\s*{\s*appearance:\s*base-select/);
    expect(settings).toMatch(/\.settings-dialog select::picker\(select\)\s*{[^}]*background:\s*var\(--color-sheet\)/);
    expect(settings).toMatch(/\.settings-dialog option::checkmark/);
  });
});
