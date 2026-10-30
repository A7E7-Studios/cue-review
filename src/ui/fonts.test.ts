import { describe, expect, it } from 'vitest';

// Read the files themselves (Vitest turns CSS imports into empty modules). The project has no Node types, hence the cast.
const fs = 'node:fs';
const { readFileSync, readdirSync } = await import(/* @vite-ignore */ fs) as {
  readFileSync: { (path: string, encoding: 'utf8'): string; (path: string): Uint8Array };
  readdirSync: (path: string, options: { recursive: true }) => string[];
};
const fontsCss = readFileSync('src/ui/fonts.css', 'utf8');
const faces = [...fontsCss.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => ({
  family: /font-family:\s*'([^']+)'/.exec(body)?.[1],
  weight: Number(/font-weight:\s*(\d+)/.exec(body)?.[1]),
  file: /url\('\.\.\/([^']+)'\)/.exec(body)?.[1],
}));

// WOFF2's table directory (W3C WOFF2 §5.2): a flags byte whose low 6 bits index the known tags, 63 meaning
// a 4-byte tag follows, then UIntBase128 lengths. Only the tags this test asks about need names.
const KNOWN: Record<number, string> = { 8: 'cvt ', 9: 'fpgm', 10: 'glyf', 11: 'loca', 12: 'prep', 17: 'gasp', 47: 'fvar', 48: 'gvar' };
function woff2Tables(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('wOF2');
  const count = view.getUint16(12);
  let at = 48;
  const base128 = () => { let value = 0; for (;;) { const byte = bytes[at++]; value = value * 128 + (byte & 0x7f); if (!(byte & 0x80)) return value; } };
  const tags: string[] = [];
  for (let index = 0; index < count; index++) {
    const flags = bytes[at++];
    const tag = (flags & 0x3f) === 63 ? String.fromCharCode(...bytes.slice(at, (at += 4))) : KNOWN[flags & 0x3f] ?? `#${flags & 0x3f}`;
    const transform = flags >> 6;
    base128();
    // glyf and loca are transformed at version 0; every other table only at a non-zero version.
    if ((tag === 'glyf' || tag === 'loca') ? transform === 0 : transform !== 0) base128();
    tags.push(tag);
  }
  return tags;
}

describe('the bundled typeface', () => {
  it('ships hinted static Figtree faces', () => {
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face.family).toBe('Figtree');
      const tables = woff2Tables(readFileSync(`src/${face.file}`));
      // TrueType instructions make it hinted; no variation tables make it one static weight.
      expect(tables, face.file).toEqual(expect.arrayContaining(['fpgm', 'prep', 'cvt ', 'glyf']));
      expect(tables, face.file).not.toContain('fvar');
      expect(tables, face.file).not.toContain('gvar');
    }
  });

  it('declares a face for every weight the styles use', () => {
    const tokens = readFileSync('src/ui/tokens.css', 'utf8');
    const resolve = (value: string) => {
      const name = /var\((--[\w-]+)/.exec(value)?.[1];
      return Number(name ? new RegExp(`${name}:\\s*(\\d+)`).exec(tokens)?.[1] : value);
    };
    const used = new Set<number>([400, 700]); // body text, and <strong> (bolder than 400)
    for (const path of readdirSync('src', { recursive: true }).filter(path => path.endsWith('.css'))) {
      for (const [, value] of readFileSync(`src/${path.replaceAll('\\', '/')}`, 'utf8').matchAll(/font-weight:\s*([^;}]+)/g)) {
        if (value.trim() !== 'inherit') used.add(resolve(value.trim()));
      }
    }
    expect([...used].every(Number.isFinite)).toBe(true);
    for (const weight of used) {
      const files = faces.filter(face => face.weight === weight).map(face => face.file);
      expect(files, `weight ${weight}`).toEqual(expect.arrayContaining([expect.stringContaining('-latin-'), expect.stringContaining('-latin-ext-')]));
    }
  });
});
