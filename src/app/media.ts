// Review media and take bookkeeping for the workspace (decision 10).
import type { RecordingStatus, Session, TakeMark, TakeVideo, Transcript } from '../backend';

/**
 * Pauses `media` and drops its source so the webview closes the file. Windows keeps
 * an open file locked, which blocks deleting a recording.
 */
export function releaseMedia(media: HTMLMediaElement | null | undefined) {
  if (!media) return;
  media.pause();
  media.removeAttribute('src');
  media.load();
}

const IN_FLIGHT = new Set(['recording', 'finalizing']);
/** A take after the first is still being captured or its video finished. */
export function takeInFlight(session: Session | null | undefined): boolean {
  return !!session?.takes?.some(take => take.index > 1 && IN_FLIGHT.has(take.status));
}

/** A take's video on the session timeline, with the URL the player loads. */
export interface PlayableVideo extends TakeVideo { url: string }
/**
 * The session's take videos by start. Without `videos` (one take, or takes joined before format 2)
 * the session has one video, `videoPath`, for the whole timeline. Take 1's video is `videoPath`;
 * take N's is `<folderPath>/takes/<N>/video.mp4`, derived from the index, never read from metadata.
 * Files are never replaced, so the URLs need no version.
 */
export function sessionVideos(session: Session, toUrl: (path: string) => string): PlayableVideo[] {
  if (!session.videoPath) return [];
  const listed = session.videos?.length ? session.videos : [{ take: 1, startMs: 0, durationMs: session.durationMs }];
  // The folder's own separator: `\` on Windows, `/` elsewhere.
  const folder = (session.folderPath ?? session.videoPath.replace(/[\\/][^\\/]*$/, '')).replace(/[\\/]+$/, '');
  const separator = folder.includes('\\') ? '\\' : '/';
  const path = (take: number) => take === 1 ? session.videoPath! : [folder, 'takes', String(take), 'video.mp4'].join(separator);
  return [...listed].sort((a, b) => a.startMs - b.startMs).map(video => ({ ...video, url: toUrl(path(video.take)) }));
}

/**
 * Where session time `ms` plays: the last video starting at or before it (the first before
 * any starts) and the time inside it, kept within that video's last millisecond as `takes::video_at` does. A take without its own
 * video plays inside the one before it.
 */
export function videoAt(videos: readonly TakeVideo[], ms: number): { index: number; localMs: number } | undefined {
  if (!videos.length) return undefined;
  let index = 0;
  videos.forEach((video, at) => { if (video.startMs <= ms) index = at; });
  const video = videos[index];
  // As `takes::video_at`: the last millisecond of a video still shows its last frame.
  return { index, localMs: Math.min(Math.max(ms - video.startMs, 0), Math.max(video.durationMs - 1, 0)) };
}

const PLACED = new Set(['transcribing', 'ready', 'error']);
/**
 * Take starts on the session timeline for the scrubber ticks and transcript dividers:
 * the transcript's, plus takes already on the timeline whose transcript is missing.
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
