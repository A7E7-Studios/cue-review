// Markdown reading for the gate and the overview: code fences, inline code, GitHub heading
// anchors, links, and a document's first heading and paragraph.
import { stripBom } from './git.mjs';

export function splitLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

/** true for each line inside a fenced code block, the fence lines included. Index 0 is line 1. */
export function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open = null; // { ch, len }
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (open) {
      mask[i] = true;
      if (m && m[1][0] === open.ch && m[1].length >= open.len && m[2].trim() === '') open = null;
    } else if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      mask[i] = true;
      open = { ch: m[1][0], len: m[1].length };
    }
  }
  return mask;
}

/**
 * Replaces inline code spans with spaces, keeping columns. A span opens at a run of backticks and
 * closes at the next run of the same length; a run with no such partner is plain text. One pass
 * over the line, so a line of thousands of backticks costs no more than its length.
 */
export function stripInlineCode(line) {
  const runs = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] !== '`') {
      i++;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] === '`') j++;
    runs.push([i, j - i]);
    i = j;
  }
  if (runs.length < 2) return line;
  const next = new Array(runs.length).fill(-1);
  const seen = new Map();
  for (let k = runs.length - 1; k >= 0; k--) {
    next[k] = seen.get(runs[k][1]) ?? -1;
    seen.set(runs[k][1], k);
  }
  const out = [];
  let from = 0;
  for (let k = 0; k < runs.length; ) {
    const m = next[k];
    if (m === -1) {
      k++;
      continue;
    }
    const start = runs[k][0];
    const end = runs[m][0] + runs[m][1];
    out.push(line.slice(from, start), line.slice(start, end).replace(/[^\n]/g, ' '));
    from = end;
    k = m + 1;
  }
  out.push(line.slice(from));
  return out.join('');
}

/** Inline Markdown as plain text: links and images to their text, code, emphasis and HTML tags dropped. */
export function plainText(raw) {
  return String(raw ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`+/g, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Removes inline markup so a heading reads as GitHub renders it. */
function headingText(raw) {
  return raw
    .replace(/\s+#+\s*$/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`/g, '')
    .trim();
}

/** github-slugger's rule: lowercase, drop punctuation, each space becomes a hyphen. */
export function slugify(text) {
  return headingText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

/** Every anchor a document offers: heading slugs (with -1, -2 for repeats) and HTML ids/names. */
export function anchors(text) {
  const lines = splitLines(text);
  const mask = fenceMask(lines);
  const seen = new Map();
  const out = new Set();
  const add = (slug) => {
    const n = seen.get(slug) ?? 0;
    out.add(n === 0 ? slug : `${slug}-${n}`);
    seen.set(slug, n + 1);
  };
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const l = lines[i];
    const atx = /^ {0,3}#{1,6}\s+(.*)$/.exec(l);
    if (atx) add(slugify(atx[1]));
    else if (
      l.trim() !== '' &&
      i + 1 < lines.length &&
      !mask[i + 1] &&
      /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1]) &&
      !/^\s*([-*+]|\d+[.)])\s/.test(l) &&
      !/^\s*\|/.test(l) &&
      !/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(l)
    ) {
      add(slugify(l));
    }
    for (const m of l.matchAll(/<[a-zA-Z][^>]*?\s(?:id|name)\s*=\s*["']([^"']+)["']/g)) out.add(m[1]);
  }
  return out;
}

/** Links in a document: [{ n, target }] from inline links, images and reference definitions. */
export function links(text) {
  const lines = splitLines(text);
  const mask = fenceMask(lines);
  const out = [];
  // A line that starts a block of its own: a heading, a table row or a thematic break stands
  // alone; a list item, a block quote or an HTML block starts one that its next lines continue.
  const alone = (l) => /^ {0,3}#{1,6}(\s|$)/.test(l) || /^\s*\|/.test(l) || /^ {0,3}([-*_])( *\1){2,} *$/.test(l);
  const starts = (l) =>
    alone(l) || /^\s*([-*+]|\d+[.)])\s/.test(l) || /^ {0,3}>/.test(l) || /^ {0,3}<(\/?[A-Za-z][A-Za-z0-9-]*|!--)/.test(l);
  for (let i = 0; i < lines.length; ) {
    if (mask[i] || lines[i].trim() === '') {
      i++;
      continue;
    }
    let j = i + 1;
    if (!alone(lines[i])) while (j < lines.length && !mask[j] && lines[j].trim() !== '' && !starts(lines[j])) j++;
    // A code span may run across the lines of one block; a reference definition only opens one.
    const block = stripInlineCode(lines.slice(i, j).join('\n')).split('\n');
    let opening = true;
    block.forEach((l, k) => {
      const ref = opening ? /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(l) : null;
      if (ref) {
        out.push({ n: i + k + 1, target: ref[1].replace(/^<|>$/g, '') });
        return;
      }
      opening = false;
      for (const m of l.matchAll(/\]\(\s*(<[^>]*>|[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)) {
        out.push({ n: i + k + 1, target: m[1].replace(/^<|>$/g, '') });
      }
    });
    i = j;
  }
  return out;
}

/** A document's first heading as plain text, or null. Front matter and fenced code are skipped. */
export function firstHeading(text) {
  const lines = splitLines(text);
  const mask = fenceMask(lines);
  const start = frontMatterEnd(lines);
  for (let i = start; i < lines.length; i++) {
    if (mask[i]) continue;
    const atx = /^ {0,3}#{1,6}\s+(.*)$/.exec(lines[i]);
    if (atx) return plainText(atx[1].replace(/\s+#+\s*$/, '')) || null;
    if (lines[i].trim() && i + 1 < lines.length && /^ {0,3}=+\s*$/.test(lines[i + 1])) return plainText(lines[i]) || null;
  }
  return null;
}

/**
 * A document's first paragraph of prose as plain text, at most `max` characters: the first run of
 * non-blank lines that is not a heading, list, table, quote, HTML block, rule or fenced code.
 */
export function firstParagraph(text, max = 300) {
  const lines = splitLines(text);
  const mask = fenceMask(lines);
  const prose = (l) =>
    l.trim() !== '' &&
    !/^ {0,3}#{1,6}(\s|$)/.test(l) &&
    !/^\s*([-*+]|\d+[.)])\s/.test(l) &&
    !/^\s*\|/.test(l) &&
    !/^\s*>/.test(l) &&
    !/^\s*</.test(l) &&
    !/^ {0,3}(-{3,}|\*{3,}|_{3,}|={3,})\s*$/.test(l) &&
    !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(l) &&
    !/^ {0,3}\[[^\]]+\]:\s/.test(l);
  for (let i = frontMatterEnd(lines); i < lines.length; i++) {
    if (mask[i] || !prose(lines[i])) continue;
    const para = [lines[i].trim()];
    for (i++; i < lines.length && !mask[i] && prose(lines[i]); i++) para.push(lines[i].trim());
    return clip(plainText(para.join(' ')), max);
  }
  return '';
}

/** `s` cut at a word boundary to at most `max` characters, an ellipsis marking the cut. */
export function clip(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** The index of the first line after a leading `---` front matter block, or 0. */
function frontMatterEnd(lines) {
  if (stripBom(lines[0] ?? '').trimEnd() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) if (lines[i].trimEnd() === '---') return i + 1;
  return 0;
}

export const PROOF_LINE = /^\s*[-*+]\s+\*\*PROOF\*\*/;
