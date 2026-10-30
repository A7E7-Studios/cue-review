import { describe, expect, it } from 'vitest';
import type { Session, Transcript } from '../backend';
import { fold, matchesAll, matchingLines, matchingRecordings, matchRanges, queryWords, recentRecordings } from './searchIndex';

const session = (id: string, name: string, createdAt: string): Session => ({ id, projectId: null, name, createdAt, durationMs: 60000, status: 'ready' });
const transcript = (...lines: [number, string][]): Transcript => ({ segments: lines.map(([startMs, text]) => ({ startMs, endMs: startMs + 4000, text, words: [] })) });

describe('search index', () => {
  it('folds case and accents one unit at a time', () => {
    expect(fold('Café Überblick')).toBe('cafe uberblick');
    expect(fold('Café').length).toBe('Café'.length);
    expect(queryWords('  Filter   PANEL ')).toEqual(['filter', 'panel']);
    expect(queryWords('   ')).toEqual([]);
  });
  it('matches every word in any order', () => {
    expect(matchesAll('Now the filter panel covers the row', queryWords('panel filter'))).toBe(true);
    expect(matchesAll('Now the filter covers the row', queryWords('panel filter'))).toBe(false);
    expect(matchesAll('anything', [])).toBe(false);
  });
  it('marks merged ranges in the original text', () => {
    const text = 'Café filters, the café';
    expect(matchRanges(text, queryWords('cafe filter'))).toEqual([[0, 4], [5, 11], [18, 22]]);
    expect(matchRanges('aaaa', ['aa', 'aaa'])).toEqual([[0, 4]]);
  });
  it('finds names and transcript lines ignoring case', () => {
    const older = session('a', 'Filter panel overlap', '2026-10-27T10:00:00Z');
    const newer = session('b', 'Library review', '2026-10-28T10:00:00Z');
    const transcripts = new Map([
      ['a', transcript([0, 'Nothing here.'], [5000, 'The FILTER is wrong.'])],
      ['b', transcript([24000, 'Now if I open the filters, the panel covers the first row.'], [31000, 'Filter again.'])],
    ]);
    const words = queryWords('filter');
    expect(matchingRecordings([older, newer], words).map(item => item.id)).toEqual(['a']);
    // Newest recordings first, in time order within one.
    expect(matchingLines([older, newer], transcripts, words).map(line => [line.session.id, line.startMs])).toEqual([['b', 24000], ['b', 31000], ['a', 5000]]);
  });
  it('lists recent recordings newest first and keeps to the limits', () => {
    const sessions = Array.from({ length: 10 }, (_, index) => session(`s${index}`, `Filter ${index}`, `2026-10-${String(index + 10)}T10:00:00Z`));
    expect(recentRecordings(sessions).map(item => item.id)).toEqual(['s9', 's8', 's7', 's6', 's5', 's4']);
    expect(matchingRecordings(sessions, ['filter'])).toHaveLength(8);
    const many = new Map(sessions.map(item => [item.id, transcript(...Array.from({ length: 5 }, (_, index): [number, string] => [index * 1000, 'filter line']))]));
    expect(matchingLines(sessions, many, ['filter'])).toHaveLength(30);
  });
});
