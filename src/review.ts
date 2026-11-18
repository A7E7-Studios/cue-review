import type { Segment, SpeechLanguage, TakeMark, Word } from './backend';
export function formatTime(ms: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
/** The recording dock's clock: "00:08", "12:34", then "1:02:03" after an hour. */
export function formatTimer(ms: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${String(minutes).padStart(2, '0')}:${rest}`;
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
/**
 * The row the playhead belongs to: the active segment, else the last one whose seek point it has
 * passed (it sits in a pause), else -1 when the playhead is before the first sentence.
 */
export function playheadSegment(segments: Segment[], ms: number): number {
  const active = activeSegment(segments, ms);
  if (active !== -1) return active;
  let last = -1;
  segments.forEach((segment, index) => { if (segmentSeekMs(segment) <= ms) last = index; });
  return last;
}
/** What a segment says: its words when it has them, otherwise its text. */
export function segmentText(segment: Segment): string {
  return segment.words.length ? segment.words.map(word => word.text).join(' ') : segment.text;
}
/** Indexes of the segments containing `query`, ignoring case and surrounding space. */
export function findMatches(segments: Segment[], query: string): number[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return segments.flatMap((segment, index) => segmentText(segment).toLocaleLowerCase().includes(needle) ? [index] : []);
}

/** The id prefix of the live transcript's segment of words still being heard (see `Segment`). */
export const LIVE_SEGMENT_PREFIX = 'live-';
/** The live transcript's words still being heard, which may change (see `Segment`). */
export function stillHeard(segment: Segment): boolean {
  return !!segment.id?.startsWith(LIVE_SEGMENT_PREFIX);
}

/** A take's language as a divider names it: its code and whether Auto detected it. */
export interface TakeLanguage { language?: string; languageDetected?: boolean }
/** A language code's English name, or the code itself when the speech model's list does not name it. */
export function languageName(code: string, languages: SpeechLanguage[] = []): string {
  return languages.find(item => item.code === code)?.name ?? code;
}
/** "German, detected" for a language Auto found, "German" for one chosen in Settings. */
export function takeLanguageLabel({ language, languageDetected }: TakeLanguage, languages: SpeechLanguage[] = []): string | undefined {
  if (!language) return undefined;
  const name = languageName(language, languages);
  return languageDetected ? `${name}, detected` : name;
}

export type TranscriptItem =
  /**
   * "Take N · m:ss", or "Take N · recording" for the take being recorded, followed by the take's
   * language when it is known; `detecting` while the take records with words and no language yet.
   */
  | { kind: 'divider'; take: number; startMs: number; live: boolean; language?: string; languageDetected?: boolean; detecting?: boolean }
  /** `live` rows belong to the take being recorded; `tail` is its words still being heard. */
  | { kind: 'segment'; index: number; live: boolean; tail: boolean };
type Divider = Extract<TranscriptItem, { kind: 'divider' }>;
/**
 * Segments in order with a divider before the first segment of each take after
 * take 1, and before take 1 too once its language is known. A session of one take
 * (no marks after take 1) takes its language from `own`, the transcript's own.
 * While a take records, pass it as `liveTake`: its segments are live, its
 * segment of words still being heard (a last `live-` one, see `Segment`) is the tail;
 * its language is its mark's or else `own`. A later take's divider is shown even
 * before it has any words, a first recording's once it has words or a language.
 */
export function transcriptItems(segments: Segment[], takes: TakeMark[] = [], liveTake?: TakeMark, own: TakeLanguage = {}): TranscriptItem[] {
  const single = !takes.some(take => take.index > 1);
  const dividers: Divider[] = takes.filter(take => take.index !== liveTake?.index && (take.index > 1 || take.language))
    .map(take => ({ kind: 'divider', take: take.index, startMs: take.startMs, live: false, language: take.language, languageDetected: take.language ? take.languageDetected : undefined }));
  const markOne = takes.find(take => take.index === 1);
  if (single && !liveTake && !markOne?.language && own.language) dividers.push({ kind: 'divider', take: 1, startMs: markOne?.startMs ?? 0, live: false, language: own.language, languageDetected: own.languageDetected });
  if (liveTake) {
    const { language, languageDetected } = liveTake.language ? liveTake : own;
    const heard = segments.some(segment => segment.startMs >= liveTake.startMs);
    if (liveTake.index > 1 || language || heard) dividers.push({ kind: 'divider', take: liveTake.index, startMs: liveTake.startMs, live: true, language, languageDetected: language ? languageDetected : undefined, detecting: !language && heard });
  }
  dividers.sort((a, b) => a.startMs - b.startMs || a.take - b.take);
  const lastLive = liveTake ? segments.reduce((last, segment, index) => segment.startMs >= liveTake.startMs ? index : last, -1) : -1;
  const items: TranscriptItem[] = [];
  let next = 0;
  segments.forEach((segment, index) => {
    while (next < dividers.length && dividers[next].startMs <= segment.startMs) items.push(dividers[next++]);
    const live = !!liveTake && segment.startMs >= liveTake.startMs;
    items.push({ kind: 'segment', index, live, tail: live && index === lastLive && stillHeard(segment) });
  });
  while (next < dividers.length) items.push(dividers[next++]);
  return items;
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return 'The operation could not finish. Check the selected device and try again.';
}
