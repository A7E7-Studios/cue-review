import type { CaptureSource, Marker, Microphone, Project, RecordingStatus, Session, SetupStatus } from '../backend';
import { date, previewImage, sections, sessions, transcript } from './fixtures';

export type Scenario = 'fresh' | 'recording' | 'processing' | 'unavailable' | 'setup';
let projects: Project[] = [];
let recordings: Session[] = [];
let markers: Marker[] = [];
let status: RecordingStatus = { state: 'idle' };
let scenario: Scenario = 'fresh';
let sequence = 0;
const clone = <T,>(value: T): T => structuredClone(value);
const find = (id: string) => {
  const session = recordings.find(item => item.id === id);
  if (!session) throw new Error('This sample recording no longer exists. Reset the story to restore it.');
  return session;
};
export function configureScenario(next: Scenario) {
  scenario = next;
  projects = clone(sections);
  recordings = clone(sessions);
  markers = [];
  sequence = 0;
  status = { state: 'idle' };
  if (next === 'recording' || next === 'processing') {
    recordings[0] = { ...recordings[0], status: next, sourceId: 'display', microphoneId: 'microphone' };
    status = { state: next, sessionId: 'library', elapsedMs: 8200, audioLevel: 0.46, liveTranscript: clone(transcript) };
  }
}
configureScenario('fresh');

export const backend = {
  projects: async () => clone(projects),
  sessions: async () => clone(recordings),
  session: async (id: string) => clone(find(id)),
  transcript: async () => clone(transcript),
  markers: async () => clone(markers),
  status: async () => clone(status),
  sources: async (): Promise<CaptureSource[]> => [
    { id: 'display', name: 'Display 1', kind: 'display', available: scenario !== 'unavailable' },
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
  stop: async () => {
    const session = find(status.sessionId!);
    session.status = 'ready'; session.durationMs = 23000; session.name = 'A clearer library toolbar';
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
};
export const videoUrl = (path: string) => path;
