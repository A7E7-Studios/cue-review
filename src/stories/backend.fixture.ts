import type { backend as RealBackend, CaptureSource, Marker, Microphone, Project, RecordingStatus, Session, Settings, SetupStatus } from '../backend';
import { date, previewImage, sections, sessions, SOURCE_GONE, stuckTakeError, takeTwoLiveTranscript, takeTwoStartMs, transcript, twoTakeSession, twoTakeTranscript } from './fixtures';

const sampleVideo = new URL('./sample-capture.webm', import.meta.url).href;
// 'takes' opens the library session with two takes; 'recording-take' records its take 2.
// 'stuck-take': take 2 could not be added to video.mp4 and waits to be retried or discarded.
// 'source-gone': the library session's window has closed, so Record more is refused.
export type Scenario = 'fresh' | 'recording' | 'processing' | 'unavailable' | 'setup' | 'takes' | 'recording-take' | 'stuck-take' | 'source-gone';
let projects: Project[] = [];
let recordings: Session[] = [];
let markers: Marker[] = [];
let settings: Settings = {};
let status: RecordingStatus = { state: 'idle' };
let scenario: Scenario = 'fresh';
let sequence = 0;
const clone = <T,>(value: T): T => structuredClone(value);
const find = (id: string) => {
  const session = recordings.find(item => item.id === id);
  if (!session) throw new Error('This sample recording no longer exists. Reset the story to restore it.');
  return session;
};
const recordTake = (session: Session, microphoneId: string | null, systemAudio: boolean) => {
  const takes = session.takes?.length ? session.takes : [{ index: 1, offsetMs: 0, durationMs: session.durationMs, status: 'ready' as const, folder: '.', systemAudio: !!session.systemAudio, microphoneId: session.microphoneId }];
  const index = takes.length + 1;
  session.takes = [...takes, { index, offsetMs: session.durationMs, durationMs: 0, status: 'recording', folder: `takes/${index}`, systemAudio, microphoneId: microphoneId ?? undefined }];
  session.status = 'recording';
  status = { state: 'recording', sessionId: session.id, elapsedMs: 0, takeIndex: index, takeOffsetMs: session.durationMs };
};
export function configureScenario(next: Scenario) {
  scenario = next;
  projects = clone(sections);
  recordings = clone(sessions);
  markers = [];
  settings = {};
  sequence = 0;
  status = { state: 'idle' };
  if (next === 'recording' || next === 'processing') {
    recordings[0] = { ...recordings[0], status: next, sourceId: 'monitor:1', microphoneId: 'microphone' };
    status = { state: next, sessionId: 'library', elapsedMs: 8200, audioLevel: 0.0126, liveTranscript: clone(transcript) };
  }
  // The two-take session plays a still of the mocks' recorded screen (videoUrl passes paths through).
  if (next === 'takes' || next === 'recording-take') recordings[0] = { ...clone(twoTakeSession), videoPath: sampleVideo };
  // A closed window: its id is no longer listed, so the recording bar names it the original source.
  if (next === 'source-gone') recordings[0] = { ...clone(twoTakeSession), videoPath: sampleVideo, sourceId: 'window:closed' };
  if (next === 'stuck-take') {
    const session: Session = { ...clone(twoTakeSession), videoPath: sampleVideo, durationMs: takeTwoStartMs, status: 'error', error: stuckTakeError };
    session.takes![1].status = 'swapping';
    recordings[0] = session;
  }
  if (next === 'recording-take') {
    const session = recordings[0];
    session.durationMs = takeTwoStartMs;
    session.takes = session.takes!.slice(0, 1);
    recordTake(session, 'microphone', false);
    status = { ...status, elapsedMs: 8000, audioLevel: 0.0126, liveTranscript: clone(takeTwoLiveTranscript) };
  }
}
configureScenario('fresh');

export const backend = {
  projects: async () => clone(projects),
  sessions: async () => clone(recordings),
  session: async (id: string) => clone(find(id)),
  transcript: async (id: string) => {
    const session = recordings.find(item => item.id === id);
    if (!session?.takes?.length) return clone(transcript);
    // While take 2 records, or when it never joined video.mp4, the saved transcript ends with take 1.
    const takeOne = twoTakeTranscript.segments.filter(segment => segment.startMs < takeTwoStartMs);
    const second = session.takes.find(take => take.index === 2);
    if (second?.status === 'recording') return clone({ ...twoTakeTranscript, segments: takeOne, takes: [{ index: 1, startMs: 0 }] });
    if (second?.status === 'swapping' || second?.status === 'interrupted') return clone({ ...twoTakeTranscript, segments: takeOne, takes: undefined });
    return clone(twoTakeTranscript);
  },
  markers: async () => clone(markers),
  status: async () => clone(status),
  sources: async (): Promise<CaptureSource[]> => [
    { id: 'monitor:1', name: 'Display 1', kind: 'display', available: scenario !== 'unavailable' },
    { id: 'quest', name: 'Quest 3', kind: 'quest', available: scenario !== 'unavailable', detail: scenario === 'unavailable' ? 'Reconnect this device to resume its preview.' : undefined },
    { id: 'camera', name: 'Studio camera with a very long device name', kind: 'camera', available: false },
  ],
  microphones: async (): Promise<Microphone[]> => [{ id: 'microphone', name: 'Studio microphone' }, { id: 'headset', name: 'Headset microphone' }],
  setup: async (): Promise<SetupStatus> => ({ ready: scenario !== 'setup', modelReady: scenario !== 'setup', issues: scenario === 'setup' ? ['Local speech model is missing.'] : [], dependencies: ['ffmpeg', 'ffprobe', 'whisper-cli', 'whisper-vad-speech-segments', 'adb', 'scrcpy'].map(name => ({ name, available: true })) }),
  preview: async (_source: string, id: string) => ({ id, url: previewImage }),
  stopPreview: async () => {},
  start: async (_project: string | null, _name: string | null, sourceId: string, microphoneId: string | null, systemAudio: boolean) => {
    const session: Session = { id: `sample-${++sequence}`, name: 'New recording', projectId: null, createdAt: date, durationMs: 0, status: 'recording', sourceId, microphoneId: microphoneId ?? undefined, systemAudio };
    recordings.unshift(session);
    status = { state: 'recording', sessionId: session.id };
    return clone(session);
  },
  recordMore: async (id: string, microphoneId: string | null, systemAudio: boolean) => {
    const session = find(id);
    if (session.status !== 'ready' || status.state !== 'idle') throw new Error('Finish the current recording or processing job first.');
    if (scenario === 'source-gone') throw new Error(SOURCE_GONE);
    recordTake(session, microphoneId, systemAudio);
    return clone(session);
  },
  discardTake: async (id: string, index: number) => {
    const session = find(id);
    const take = session.takes?.find(item => item.index === index);
    if (index < 2) throw new Error('Take 1 is the original recording and cannot be discarded.');
    if (take?.status !== 'swapping') throw new Error(`Take ${index} is already part of the recording and cannot be discarded.`);
    take.status = 'interrupted';
    session.status = 'ready'; session.error = undefined;
    return clone(session);
  },
  stop: async () => {
    const session = find(status.sessionId!);
    const take = session.takes?.find(item => item.index === status.takeIndex);
    if (take) { take.status = 'ready'; take.durationMs = 54000; session.durationMs = take.offsetMs + take.durationMs; }
    else { session.durationMs = 23000; session.name = 'A clearer library toolbar'; }
    session.status = 'ready';
    status = { state: 'idle' };
    return clone(session);
  },
  mute: async () => {},
  createProject: async (name: string) => { const project = { id: `section-${++sequence}`, name, createdAt: date }; projects.push(project); return clone(project); },
  renameProject: async (id: string, name: string) => { const project = projects.find(item => item.id === id); if (project) project.name = name; },
  renameSession: async (id: string, name: string) => { find(id).name = name; },
  reorderProjects: async (ids: string[]) => { projects = ids.map(id => projects.find(item => item.id === id)!); },
  moveSession: async (id: string, projectId: string | null) => { find(id).projectId = projectId; return clone(find(id)); },
  deleteProject: async (id: string) => { projects = projects.filter(item => item.id !== id); recordings.forEach(item => { if (item.projectId === id) item.projectId = null; }); },
  deleteSession: async (id: string) => { recordings = recordings.filter(item => item.id !== id); },
  addMarker: async (_id: string, timeMs: number, label: string) => { const marker = { id: `marker-${++sequence}`, timeMs, label }; markers.push(marker); return clone(marker); },
  handoff: async () => 'Storybook sample only. No recording files are created or accessible.',
  openFolder: async () => { throw new Error('Sample recordings have no local folder.'); },
  retry: async () => {},
  installTranscription: async () => { scenario = 'fresh'; },
  settings: async () => clone(settings),
  saveSettings: async (next: Settings) => { settings = clone(next); return clone(settings); },
} satisfies typeof RealBackend;
export const videoUrl = (path: string) => path;
