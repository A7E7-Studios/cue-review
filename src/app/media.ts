// Review media and take bookkeeping for the workspace (decision 10).
import type { RecordingStatus, Session, TakeMark, Transcript } from '../backend';

/**
 * Pauses `media` and drops its source so the webview closes the file. Windows keeps
 * an open file locked, which blocks deleting a recording and swapping video.mp4.
 */
export function releaseMedia(media: HTMLMediaElement | null | undefined) {
  if (!media) return;
  media.pause();
  media.removeAttribute('src');
  media.load();
}

const IN_FLIGHT = new Set(['recording', 'finalizing', 'swapping']);
/** A take after the first is still being captured or appended to the combined video.mp4. */
export function takeInFlight(session: Session | null | undefined): boolean {
  return !!session?.takes?.some(take => take.index > 1 && IN_FLIGHT.has(take.status));
}

/** A take is being appended to video.mp4, which Retry finishes before transcribing. */
export function takeSwapping(session: Session | null | undefined): boolean {
  return !!session?.takes?.some(take => take.status === 'swapping');
}

/**
 * The review video URL. Record more replaces video.mp4 at the same path, so a session
 * with takes carries a version that changes with every appended take. The asset
 * protocol serves the path and ignores the query.
 */
export function sessionVideoUrl(session: Session, toUrl: (path: string) => string): string | undefined {
  if (!session.videoPath) return undefined;
  const url = toUrl(session.videoPath);
  const takes = session.takes?.length ?? 0;
  return takes > 1 ? `${url}${url.includes('?') ? '&' : '?'}v=${takes}-${session.durationMs}` : url;
}

const PLACED = new Set(['transcribing', 'ready', 'error']);
/**
 * Take starts on the session timeline for the scrubber ticks and transcript dividers:
 * the transcript's, plus takes already in video.mp4 whose transcript is missing.
 */
export function takeMarks(session: Session | null | undefined, transcript: Transcript): TakeMark[] | undefined {
  const marks = new Map<number, TakeMark>();
  for (const take of session?.takes ?? []) if (PLACED.has(take.status)) marks.set(take.index, { index: take.index, startMs: take.offsetMs });
  for (const mark of transcript.takes ?? []) marks.set(mark.index, mark);
  const list = [...marks.values()].sort((a, b) => a.startMs - b.startMs || a.index - b.index);
  return list.length > 1 ? list : transcript.takes;
}

/** The take being recorded after the first, placed on the session timeline. */
export function liveTake(status: RecordingStatus): TakeMark | undefined {
  return status.state === 'recording' && status.takeIndex && status.takeIndex > 1
    ? { index: status.takeIndex, startMs: status.takeOffsetMs ?? 0 }
    : undefined;
}

/**
 * What the transcript shows while recording. A first recording shows its live transcript.
 * A later take shows the saved takes before it, then its own live words, which the backend
 * already times on the session timeline.
 */
export function recordingTranscript(saved: Transcript, status: RecordingStatus): Transcript {
  const live = status.liveTranscript;
  const take = liveTake(status);
  if (!take) return { ...live, segments: live?.segments ?? [] };
  const earlier = saved.takes?.filter(mark => mark.index < take.index);
  return {
    ...saved,
    status: live?.status,
    error: live?.error,
    takes: earlier?.length ? earlier : [{ index: 1, startMs: 0 }],
    segments: [...saved.segments.filter(segment => segment.startMs < take.startMs), ...(live?.segments ?? [])],
  };
}
