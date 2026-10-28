// Geometry for the playback scrubber (decision 6): speech runs, take ticks, pointer
// and keyboard seeking. Positions are percentages of the track width.
import type { Segment, TakeMark } from '../backend';
import { formatTime } from '../review';

export interface SpeechRun { left: number; width: number; played: boolean }
export interface TakeTick { index: number; startMs: number; left: number }

const finite = (value: number) => Number.isFinite(value) ? value : 0;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** `ms` as a percentage of `durationMs`, clamped to the track. */
export function toPercent(ms: number, durationMs: number): number {
  const duration = finite(durationMs);
  return duration > 0 ? clamp(finite(ms) / duration * 100, 0, 100) : 0;
}

/**
 * Speech ranges clamped to the recording, merged where they overlap, and split at
 * the playhead so the played part can be drawn in the accent.
 */
export function speechRuns(segments: Pick<Segment, 'startMs' | 'endMs'>[], durationMs: number, timeMs: number): SpeechRun[] {
  const duration = finite(durationMs);
  if (duration <= 0) return [];
  const ranges = segments
    .map(segment => [clamp(finite(segment.startMs), 0, duration), clamp(finite(segment.endMs), 0, duration)] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const playhead = clamp(finite(timeMs), 0, duration);
  const run = (start: number, end: number, played: boolean): SpeechRun => ({ left: start / duration * 100, width: (end - start) / duration * 100, played });
  return merged.flatMap(([start, end]) => {
    if (end <= playhead) return [run(start, end, true)];
    if (start >= playhead) return [run(start, end, false)];
    return [run(start, playhead, true), run(playhead, end, false)];
  });
}

/** Ticks where takes after the first start. Take 1 and takes outside the recording draw none. */
export function takeTicks(takes: TakeMark[] | undefined, durationMs: number): TakeTick[] {
  const duration = finite(durationMs);
  if (!takes || duration <= 0) return [];
  return takes
    .filter(take => take.index > 1 && take.startMs > 0 && take.startMs < duration)
    .map(take => ({ index: take.index, startMs: take.startMs, left: take.startMs / duration * 100 }));
}

/** The time under a pointer at `clientX` on a track drawn at `rect`. */
export function pointerToMs(clientX: number, rect: { left: number; width: number }, durationMs: number): number {
  const duration = finite(durationMs);
  if (duration <= 0 || !(rect.width > 0)) return 0;
  return Math.round(clamp((finite(clientX) - rect.left) / rect.width, 0, 1) * duration);
}

export const ARROW_STEP_MS = 5000;
export const SHIFT_ARROW_STEP_MS = 1000;
/**
 * The seek target for a key on the focused scrubber, or null for keys it doesn't handle.
 * Arrows move 5 s (1 s with Shift), Page Up/Down a tenth of the recording, Home/End to the ends.
 */
export function keyboardSeek(key: string, timeMs: number, durationMs: number, shift = false): number | null {
  const duration = Math.max(0, finite(durationMs));
  const time = clamp(finite(timeMs), 0, duration);
  const arrow = shift ? SHIFT_ARROW_STEP_MS : ARROW_STEP_MS;
  const page = Math.max(ARROW_STEP_MS, duration / 10);
  switch (key) {
    case 'ArrowLeft': case 'ArrowDown': return clamp(time - arrow, 0, duration);
    case 'ArrowRight': case 'ArrowUp': return clamp(time + arrow, 0, duration);
    case 'PageDown': return clamp(time - page, 0, duration);
    case 'PageUp': return clamp(time + page, 0, duration);
    case 'Home': return 0;
    case 'End': return duration;
    default: return null;
  }
}

/** The slider's aria-valuetext: "0:33 of 2:14, take 2 starts at 1:20". */
export function positionText(timeMs: number, durationMs: number, takes?: TakeMark[]): string {
  const starts = takeTicks(takes, durationMs).map(tick => `take ${tick.index} starts at ${formatTime(tick.startMs)}`);
  return [`${formatTime(Math.min(finite(timeMs), finite(durationMs)))} of ${formatTime(durationMs)}`, ...starts].join(', ');
}
