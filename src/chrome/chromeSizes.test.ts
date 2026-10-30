import { describe, expect, it } from 'vitest';

// Read the stylesheets themselves (Vitest turns CSS imports into empty modules). The project has no Node types, hence the cast.
const fs = 'node:fs';
const { readFileSync } = await import(/* @vite-ignore */ fs) as { readFileSync: (path: string, encoding: 'utf8') => string };
const tokens = readFileSync('src/ui/tokens.css', 'utf8');
const chrome = readFileSync('src/chrome/chrome.css', 'utf8');
const shell = readFileSync('src/styles.css', 'utf8');

/** The value of a token in the base `:root` block (its first declaration). */
const token = (name: string) => new RegExp(`--${name}:\s*([^;]+);`).exec(tokens)?.[1].trim();
/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No rule for ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}
/** Each block of a stylesheet that reduced motion selects. */
const reducedBlocks = () => [
  rule(tokens, ":root[data-motion='reduced']"),
  rule(tokens, ":root:not([data-motion='full'])"),
];

describe('window chrome sizes', () => {
  it('the title bar is 44px with 46×44 window controls', () => {
    expect(token('size-titlebar')).toBe('44px');
    expect(token('size-window-control')).toBe('46px');
    expect(rule(chrome, ".chrome-titlebar, .chrome-bar[data-platform='linux']")).toContain('height: var(--size-titlebar)');
    // Window controls fill the bar's height.
    expect(rule(chrome, '.window-controls')).toContain('align-self: stretch');
    expect(rule(chrome, '.window-control')).toContain('height: 100%');
  });
  it('toolbar icon buttons are 36×32', () => {
    expect(token('size-chrome-icon-button-width')).toBe('36px');
    expect(token('size-chrome-icon-button-height')).toBe('32px');
    const icon = rule(chrome, '.chrome-icon');
    expect(icon).toContain('width: var(--size-chrome-icon-button-width)');
    expect(icon).toContain('height: var(--size-chrome-icon-button-height)');
  });
});

describe('sidebar slide', () => {
  it('slides over 200ms', () => {
    expect(token('motion-sidebar')).toBe('200ms');
    expect(rule(shell, '.app-sidebar-slot')).toContain('transition: width var(--motion-sidebar)');
  });
  it('the sidebar slide is instant under reduced motion', () => {
    for (const block of reducedBlocks()) expect(block).toMatch(/--motion-sidebar:\s*0ms/);
    expect(rule(shell, ".app[data-sidebar-motion='instant'] .app-sidebar-slot")).toContain('transition: none');
  });
});
