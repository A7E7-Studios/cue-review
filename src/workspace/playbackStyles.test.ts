import { describe, expect, it } from 'vitest';

// Read the stylesheets themselves (Vitest turns CSS imports into empty modules). The project has no Node types, hence the cast.
const fs = 'node:fs';
const { readFileSync } = await import(/* @vite-ignore */ fs) as { readFileSync: (path: string, encoding: 'utf8') => string };
const workspace = readFileSync('src/workspace/workspace.css', 'utf8');
const tokens = readFileSync('src/ui/tokens.css', 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No rule for ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('playback control styles', () => {
  it('gives the speed button a fixed width', () => {
    const speed = rule(workspace, '.cr-speed');
    expect(speed).toContain('width: var(--size-speed-button)');
    expect(speed).toMatch(/padding: 0;/);
    expect(speed).not.toMatch(/min-width|max-width/);
    // Wide enough for "1.75×" at the control size, with room on each side.
    expect(String.raw`${/--size-speed-button:\s*(\d+)px/.exec(tokens)?.[1]}`).toBe('56');
  });
});
