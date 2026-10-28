import { describe, expect, it } from 'vitest';
import type { Session, Take } from '../backend';
import { liveTake, recordingTranscript, sessionVideoUrl, takeInFlight, takeMarks, takeSwapping } from './media';
import { isCommand, isEditable } from './useShortcuts';

const take = (index: number, offsetMs: number, status: Take['status']): Take => ({ index, offsetMs, durationMs: 10000, status, folder: index === 1 ? '.' : `takes/${index}`, systemAudio: false });
const session = (takes?: Take[]): Session => ({ id: 's1', projectId: null, name: 'Review', createdAt: '2026-10-28T09:00:00Z', durationMs: 20000, status: 'ready', videoPath: 'C:/sessions/s1/video.mp4', takes });
const segment = (startMs: number, text: string) => ({ startMs, endMs: startMs + 1000, text, words: [] });

describe('review media', () => {
  it('versions the video URL by take count and length, since video.mp4 is replaced in place', () => {
    const url = (path: string) => `asset://${path}`;
    expect(sessionVideoUrl(session(), url)).toBe('asset://C:/sessions/s1/video.mp4');
    expect(sessionVideoUrl(session([take(1, 0, 'ready')]), url)).toBe('asset://C:/sessions/s1/video.mp4');
    expect(sessionVideoUrl(session([take(1, 0, 'ready'), take(2, 10000, 'ready')]), url)).toBe('asset://C:/sessions/s1/video.mp4?v=2-20000');
    expect(sessionVideoUrl(session([take(1, 0, 'ready'), take(2, 10000, 'ready')]), path => `http://asset.localhost/${path}?a=1`)).toBe('http://asset.localhost/C:/sessions/s1/video.mp4?a=1&v=2-20000');
    expect(sessionVideoUrl({ ...session(), videoPath: undefined }, url)).toBeUndefined();
  });
  it('holds the video while a later take records or is appended, but not while it only transcribes', () => {
    expect(takeInFlight(session())).toBe(false);
    for (const status of ['recording', 'finalizing', 'swapping'] as const) expect(takeInFlight(session([take(1, 0, 'ready'), take(2, 10000, status)]))).toBe(true);
    for (const status of ['transcribing', 'ready', 'error', 'interrupted'] as const) expect(takeInFlight(session([take(1, 0, 'ready'), take(2, 10000, status)]))).toBe(false);
    expect(takeSwapping(session([take(1, 0, 'ready'), take(2, 10000, 'swapping')]))).toBe(true);
    expect(takeSwapping(session([take(1, 0, 'ready'), take(2, 10000, 'error')]))).toBe(false);
  });
  it('marks takes already in the video even when their transcript is missing', () => {
    expect(takeMarks(session(), { segments: [] })).toBeUndefined();
    expect(takeMarks(session([take(1, 0, 'ready'), take(2, 10000, 'error'), take(3, 20000, 'interrupted')]), { segments: [], takes: [{ index: 1, startMs: 0 }] }))
      .toEqual([{ index: 1, startMs: 0 }, { index: 2, startMs: 10000 }]);
    expect(takeMarks(null, { segments: [], takes: [{ index: 1, startMs: 0 }, { index: 2, startMs: 9000 }] })).toEqual([{ index: 1, startMs: 0 }, { index: 2, startMs: 9000 }]);
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
