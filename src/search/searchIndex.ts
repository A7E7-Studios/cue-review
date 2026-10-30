import type { Session, Transcript } from '../backend';

/** How many results each part of the search window shows. */
export const RECENT_LIMIT = 6;
export const RECORDING_LIMIT = 8;
export const LINE_LIMIT = 30;

/**
 * Lower case without accents, so "Café" and "cafe" match. One UTF-16 unit in, one out, so an index
 * into the folded text is an index into the original.
 */
export function fold(text: string): string {
  return text.split('').map(unit => unit.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()[0] ?? unit).join('');
}

/** The words of a query, folded; empty when there is nothing to search for. */
export function queryWords(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/** Whether every word occurs in the text, in any order. */
export function matchesAll(text: string, words: string[]): boolean {
  if (!words.length) return false;
  const folded = fold(text);
  return words.every(word => folded.includes(word));
}

/** The ranges of the text that the words match, merged and in order, for marking. */
export function matchRanges(text: string, words: string[]): [number, number][] {
  const folded = fold(text);
  const ranges: [number, number][] = [];
  for (const word of words) {
    for (let at = folded.indexOf(word); at >= 0; at = folded.indexOf(word, at + word.length)) ranges.push([at, at + word.length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

const newestFirst = (a: Session, b: Session) => b.createdAt.localeCompare(a.createdAt);

export function recentRecordings(sessions: Session[], limit = RECENT_LIMIT): Session[] {
  return [...sessions].sort(newestFirst).slice(0, limit);
}

export function matchingRecordings(sessions: Session[], words: string[], limit = RECORDING_LIMIT): Session[] {
  return [...sessions].sort(newestFirst).filter(session => matchesAll(session.name, words)).slice(0, limit);
}

export interface LineMatch { session: Session; startMs: number; text: string }

/** Transcript lines that match every word, newest recordings first, in time order within one. */
export function matchingLines(sessions: Session[], transcripts: ReadonlyMap<string, Transcript>, words: string[], limit = LINE_LIMIT): LineMatch[] {
  const lines: LineMatch[] = [];
  for (const session of [...sessions].sort(newestFirst)) {
    for (const segment of transcripts.get(session.id)?.segments ?? []) {
      if (lines.length >= limit) return lines;
      const text = segment.text.trim();
      if (matchesAll(text, words)) lines.push({ session, startMs: segment.startMs, text });
    }
  }
  return lines;
}
