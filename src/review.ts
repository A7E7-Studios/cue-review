import type { Segment, Word } from './backend';
export function formatTime(ms: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function seekTime(ms: number, durationMs: number): number {
  return Math.max(0, Math.min(Number.isFinite(durationMs) ? durationMs : 0, Number.isFinite(ms) ? ms : 0));
}
function hasSeekAnchor(word: Word): word is Word & {seekMs:number} {
  return typeof word.seekMs==='number' && Number.isFinite(word.seekMs) && word.seekMs>=0;
}
export function wordSeekMs(word: Word): number {
  return hasSeekAnchor(word) ? word.seekMs : word.startMs;
}
export function segmentSeekMs(segment: Segment): number {
  const first = segment.words[0];
  return first && hasSeekAnchor(first) ? first.seekMs : segment.startMs;
}
export function activeWord(words: Word[], ms: number): number {
  // DTW gives an estimated point, not a spoken interval. A short visual pulse
  // around that point does not repurpose or overwrite the original ASR bounds.
  let nearest = -1;
  let distance = Infinity;
  words.forEach((word,index)=>{
    if(hasSeekAnchor(word)) {
      const delta = Math.abs(ms-word.seekMs);
      if(delta<=180&&delta<distance){distance=delta;nearest=index;}
    }
  });
  if(nearest!==-1)return nearest;
  return words.findIndex(word => !hasSeekAnchor(word) && word.startMs <= ms && ms < word.endMs);
}
export function activeSegment(segments: Segment[], ms: number): number {
  let nearest = -1;
  let distance = Infinity;
  segments.forEach((segment,index)=>segment.words.forEach(word=>{
    if(hasSeekAnchor(word)) {
      const delta = Math.abs(ms-word.seekMs);
      if(delta<=180&&delta<distance){distance=delta;nearest=index;}
    }
  }));
  if(nearest!==-1)return nearest;
  return segments.findIndex(segment => segment.words.some(hasSeekAnchor) ? activeWord(segment.words,ms)!==-1 : segment.startMs <= ms && ms < segment.endMs);
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return 'The operation could not finish. Check the selected device and try again.';
}
