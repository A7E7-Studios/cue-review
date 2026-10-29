import { describe, expect, it } from 'vitest';

// Read the stylesheet itself (Vitest turns CSS imports into empty modules). The project has no Node types, hence the cast.
const fs = 'node:fs';
const { readFileSync } = await import(/* @vite-ignore */ fs) as { readFileSync: (path: string, encoding: 'utf8') => string };
const css = readFileSync('src/ui/tokens.css', 'utf8');

// Contrast floors for token pairs that the design review measured (WCAG 2.2: 4.5:1 for text, 3:1 for UI graphics).
/** The light value of a token: its first declaration, in the base `:root` block. */
function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!match) throw new Error(`No hex value for --${name}`);
  return match[1];
}
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe('token contrast', () => {
  it('keeps tertiary text legible on the macOS selected row', () => {
    expect(contrast(token('color-text-tertiary-on-selected'), token('color-panel-row-selected'))).toBeGreaterThanOrEqual(4.5);
  });
  it('keeps take ticks visible on the scrubber track and over speech', () => {
    expect(contrast(token('color-scrubber-tick'), token('color-scrubber-track'))).toBeGreaterThanOrEqual(3);
    expect(contrast(token('color-scrubber-tick'), token('color-scrubber-speech'))).toBeGreaterThanOrEqual(3);
  });
  it('keeps tertiary text legible on the sheet and the ground', () => {
    expect(contrast(token('color-text-tertiary'), token('color-sheet'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('color-text-tertiary'), token('color-ground'))).toBeGreaterThanOrEqual(4.5);
  });
});
