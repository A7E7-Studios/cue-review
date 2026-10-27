import type { Segment, Word } from './backend';
export function formatTime(ms: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function seekTime(ms: number, durationMs: number): number {
  return Math.max(0, Math.min(Number.isFinite(durationMs) ? durationMs : 0, Number.isFinite(ms) ? ms : 0));
}
export function activeWord(words: Word[], ms: number): number {
  return words.findIndex(word => word.startMs <= ms && ms < word.endMs);
}
export function activeSegment(segments: Segment[], ms: number): number {
  return segments.findIndex(segment => segment.startMs <= ms && ms < segment.endMs);
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return 'The operation could not finish. Check the selected device and try again.';
}
