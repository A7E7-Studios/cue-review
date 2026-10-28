import { describe, expect, it } from 'vitest';
import { keyboardSeek, pointerToMs, positionText, speechRuns, takeTicks, toPercent } from './scrubber.ts';

describe('scrubber geometry', () => {
  it('maps time to a clamped percentage of the track', () => {
    expect(toPercent(33500, 134000)).toBe(25);
    expect(toPercent(-1, 134000)).toBe(0);
    expect(toPercent(200000, 134000)).toBe(100);
    expect(toPercent(1000, 0)).toBe(0);
    expect(toPercent(NaN, 1000)).toBe(0);
  });
  it('splits speech at the playhead so only the played part is drawn in the accent', () => {
    expect(speechRuns([{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 4000 }, { startMs: 6000, endMs: 8000 }], 10000, 3000)).toEqual([
      { left: 0, width: 10, played: true },
      { left: 20, width: 10, played: true },
      { left: 30, width: 10, played: false },
      { left: 60, width: 20, played: false },
    ]);
  });
  it('merges overlapping speech, drops empty ranges and clamps to the recording', () => {
    expect(speechRuns([{ startMs: 3000, endMs: 5000 }, { startMs: 1000, endMs: 3500 }, { startMs: 7000, endMs: 7000 }, { startMs: 9000, endMs: 12000 }], 10000, 0)).toEqual([
      { left: 10, width: 40, played: false },
      { left: 90, width: 10, played: false },
    ]);
    expect(speechRuns([{ startMs: 0, endMs: 1000 }], 0, 0)).toEqual([]);
  });
  it('draws a tick for every take after the first that starts inside the recording', () => {
    expect(takeTicks([{ index: 1, startMs: 0 }, { index: 2, startMs: 80000 }, { index: 3, startMs: 200000 }], 160000)).toEqual([{ index: 2, startMs: 80000, left: 50 }]);
    expect(takeTicks(undefined, 1000)).toEqual([]);
  });
  it('turns a pointer position into a time on the track', () => {
    const rect = { left: 100, width: 400 };
    expect(pointerToMs(300, rect, 134000)).toBe(67000);
    expect(pointerToMs(50, rect, 134000)).toBe(0);
    expect(pointerToMs(900, rect, 134000)).toBe(134000);
    expect(pointerToMs(300, { left: 0, width: 0 }, 134000)).toBe(0);
  });
  it('seeks 5 s with arrows, 1 s with Shift, a tenth with Page keys and to the ends with Home and End', () => {
    expect(keyboardSeek('ArrowRight', 33000, 134000)).toBe(38000);
    expect(keyboardSeek('ArrowUp', 33000, 134000)).toBe(38000);
    expect(keyboardSeek('ArrowLeft', 33000, 134000)).toBe(28000);
    expect(keyboardSeek('ArrowDown', 3000, 134000)).toBe(0);
    expect(keyboardSeek('ArrowRight', 33000, 134000, true)).toBe(34000);
    expect(keyboardSeek('PageUp', 33000, 134000)).toBe(46400);
    expect(keyboardSeek('PageDown', 33000, 20000)).toBe(15000);
    expect(keyboardSeek('Home', 33000, 134000)).toBe(0);
    expect(keyboardSeek('End', 33000, 134000)).toBe(134000);
    expect(keyboardSeek('ArrowRight', 132000, 134000)).toBe(134000);
    expect(keyboardSeek('a', 33000, 134000)).toBeNull();
  });
  it('describes the position and take starts for assistive technology', () => {
    expect(positionText(33400, 134000, [{ index: 1, startMs: 0 }, { index: 2, startMs: 80000 }])).toBe('0:33 of 2:14, take 2 starts at 1:20');
    expect(positionText(5000, 10000)).toBe('0:05 of 0:10');
  });
});
