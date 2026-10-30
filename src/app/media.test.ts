import { describe, expect, it } from 'vitest';
import type { Session, Take } from '../backend';
import { liveTake, recordingTranscript, sessionVideos, takeInFlight, takeMarks, videoAt } from './media';
import { isCommand, isEditable } from './useShortcuts';

const take = (index: number, offsetMs: number, status: Take['status']): Take => ({ index, offsetMs, durationMs: 10000, status, folder: index === 1 ? '.' : `takes/${index}`, systemAudio: false });
const session = (takes?: Take[]): Session => ({ id: 's1', projectId: null, name: 'Review', createdAt: '2026-10-28T09:00:00Z', durationMs: 20000, status: 'ready', videoPath: 'C:/sessions/s1/video.mp4', takes });
const segment = (startMs: number, text: string) => ({ startMs, endMs: startMs + 1000, text, words: [] });

describe('review media', () => {
  it('lists one video for a session without take videos, and derives later take videos from the folder', () => {
    const url = (path: string) => `asset://${path}`;
    expect(sessionVideos(session(), url)).toEqual([{ take: 1, startMs: 0, durationMs: 20000, url: 'asset://C:/sessions/s1/video.mp4' }]);
    expect(sessionVideos({ ...session([take(1, 0, 'ready'), take(2, 10000, 'ready')]), videos: [] }, url)).toHaveLength(1);
    expect(sessionVideos({ ...session(), videoPath: undefined }, url)).toEqual([]);
    const videos = [{ take: 2, startMs: 10000, durationMs: 10000 }, { take: 1, startMs: 0, durationMs: 10000 }];
    expect(sessionVideos({ ...session(), formatVersion: 2, videos, folderPath: 'C:/sessions/s1' }, url).map(video => [video.take, video.url]))
      .toEqual([[1, 'asset://C:/sessions/s1/video.mp4'], [2, 'asset://C:/sessions/s1/takes/2/video.mp4']]);
    // A Windows folder keeps its backslashes; a missing folder falls back to video.mp4's own.
    expect(sessionVideos({ ...session(), videoPath: 'C:\\data\\s1\\video.mp4', folderPath: 'C:\\data\\s1', videos }, url)[1].url).toBe('asset://C:\\data\\s1\\takes\\2\\video.mp4');
    expect(sessionVideos({ ...session(), videos }, url)[1].url).toBe('asset://C:/sessions/s1/takes/2/video.mp4');
  });
  it('holds the video while a later take records or finishes, but not while it only transcribes', () => {
    expect(takeInFlight(session())).toBe(false);
    for (const status of ['recording', 'finalizing'] as const) expect(takeInFlight(session([take(1, 0, 'ready'), take(2, 10000, status)]))).toBe(true);
    for (const status of ['swapping', 'transcribing', 'ready', 'error', 'interrupted'] as const) expect(takeInFlight(session([take(1, 0, 'ready'), take(2, 10000, status)]))).toBe(false);
  });
  it('marks takes already in the video even when their transcript is missing', () => {
    expect(takeMarks(session(), { segments: [] })).toBeUndefined();
    expect(takeMarks(session([take(1, 0, 'ready'), take(2, 10000, 'error'), take(3, 20000, 'interrupted')]), { segments: [], takes: [{ index: 1, startMs: 0 }] }))
      .toEqual([{ index: 1, startMs: 0 }, { index: 2, startMs: 10000 }]);
    expect(takeMarks(null, { segments: [], takes: [{ index: 1, startMs: 0 }, { index: 2, startMs: 9000 }] })).toEqual([{ index: 1, startMs: 0 }, { index: 2, startMs: 9000 }]);
  });
});

describe('videoAt', () => {
  it('picks the take video by session time', () => {
    const videos = [{ take: 1, startMs: 0, durationMs: 10000 }, { take: 2, startMs: 10000, durationMs: 8000 }, { take: 4, startMs: 25000, durationMs: 5000 }];
    expect(videoAt([], 1000)).toBeUndefined();
    expect(videoAt(videos, 0)).toEqual({ index: 0, localMs: 0 });
    expect(videoAt(videos, 9999)).toEqual({ index: 0, localMs: 9999 });
    // A boundary belongs to the take that starts there.
    expect(videoAt(videos, 10000)).toEqual({ index: 1, localMs: 0 });
    expect(videoAt(videos, 12500)).toEqual({ index: 1, localMs: 2500 });
    // Take 3 has no video of its own: it plays inside take 2's, clamped to that video's end.
    expect(videoAt(videos, 20000)).toEqual({ index: 1, localMs: 8000 });
    expect(videoAt(videos, 26000)).toEqual({ index: 2, localMs: 1000 });
    expect(videoAt(videos, 40000)).toEqual({ index: 2, localMs: 5000 });
    expect(videoAt(videos, -50)).toEqual({ index: 0, localMs: 0 });
    // A joined session (no videos listed) is one video for the whole timeline.
    expect(videoAt([{ take: 1, startMs: 0, durationMs: 20000 }], 15000)).toEqual({ index: 0, localMs: 15000 });
  });
});

describe('recording transcript', () => {
  it('shows a first recording as its live transcript', () => {
    expect(liveTake({ state: 'recording', elapsedMs: 1000 })).toBeUndefined();
    expect(recordingTranscript({ segments: [segment(0, 'Saved')] }, { state: 'recording', liveTranscript: { segments: [segment(500, 'Live')] } }).segments.map(item => item.text)).toEqual(['Live']);
    expect(recordingTranscript({ segments: [] }, { state: 'recording' })).toEqual({ segments: [] });
  });
  it('places a later take after the saved takes on the session timeline', () => {
    const status = { state: 'recording' as const, takeIndex: 3, takeOffsetMs: 20000, liveTranscript: { segments: [segment(21000, 'Third')], error: 'Live transcription paused.' } };
    expect(liveTake(status)).toEqual({ index: 3, startMs: 20000 });
    const merged = recordingTranscript({ takes: [{ index: 1, startMs: 0 }, { index: 2, startMs: 10000 }, { index: 3, startMs: 20000 }], segments: [segment(0, 'One'), segment(11000, 'Two'), segment(20500, 'Stale')] }, status);
    expect(merged.segments.map(item => item.text)).toEqual(['One', 'Two', 'Third']);
    expect(merged.takes).toEqual([{ index: 1, startMs: 0 }, { index: 2, startMs: 10000 }]);
    expect(merged.error).toBe('Live transcription paused.');
    expect(recordingTranscript({ segments: [segment(0, 'One')] }, { ...status, takeIndex: 2, takeOffsetMs: 10000, liveTranscript: undefined }).takes).toEqual([{ index: 1, startMs: 0 }]);
  });
});

describe('shortcut matching', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
  it('uses Ctrl on Windows and Linux and ⌘ on macOS, with no other modifier', () => {
    expect(isCommand(key({ key: 'r', ctrlKey: true }), 'windows', 'r')).toBe(true);
    expect(isCommand(key({ key: 'R', ctrlKey: true }), 'linux', 'r')).toBe(true);
    expect(isCommand(key({ key: 'r', metaKey: true }), 'windows', 'r')).toBe(false);
    expect(isCommand(key({ key: 'r', metaKey: true }), 'macos', 'r')).toBe(true);
    expect(isCommand(key({ key: 'r', ctrlKey: true }), 'macos', 'r')).toBe(false);
    expect(isCommand(key({ key: 'r', ctrlKey: true, shiftKey: true }), 'windows', 'r')).toBe(false);
    expect(isCommand(key({ key: 'r', ctrlKey: true, altKey: true }), 'windows', 'r')).toBe(false);
    expect(isCommand(key({ key: 'n', ctrlKey: true }), 'windows', 'r')).toBe(false);
  });
  it('treats text fields as editable but not ranges, checkboxes or buttons', () => {
    const input = (type: string) => Object.assign(document.createElement('input'), { type });
    expect(isEditable(input('text'))).toBe(true);
    expect(isEditable(input('search'))).toBe(true);
    expect(isEditable(document.createElement('textarea'))).toBe(true);
    expect(isEditable(document.createElement('select'))).toBe(true);
    expect(isEditable(input('range'))).toBe(false);
    expect(isEditable(input('checkbox'))).toBe(false);
    expect(isEditable(document.createElement('button'))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});
