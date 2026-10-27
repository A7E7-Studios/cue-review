import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';

export interface Project { id: string; name: string; createdAt: string }
export interface Session { id: string; projectId: string|null; name: string; createdAt: string; durationMs: number; status: 'recording' | 'processing' | 'ready' | 'error'; videoPath?: string; folderPath?: string; error?: string; sourceId?: string; microphoneId?: string; systemAudio?: boolean; autoTitle?: boolean }
export interface Word { text: string; startMs: number; endMs: number; seekMs?: number }
export interface Segment { id?: string; startMs: number; endMs: number; text: string; words: Word[] }
export interface Transcript { segments: Segment[]; language?: string; status?: string; error?: string }
export interface CaptureSource { id: string; name: string; kind: 'display' | 'window' | 'android' | 'quest' | 'camera'; available: boolean; detail?: string }
export interface Microphone { id: string; name: string }
export interface RecordingStatus { state: 'idle' | 'recording' | 'processing' | 'error'; sessionId?: string; elapsedMs?: number; audioLevel?: number; liveTranscript?: Transcript; error?: string }
export interface SetupStatus { ready: boolean; issues: string[]; dependencies?: {name:string;available:boolean;path?:string;detail?:string}[]; modelReady?:boolean; modelPath?:string }
export interface Marker { id: string; timeMs: number; label: string }

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error('Open CueReview as a desktop app to access your recordings and capture devices. Run npm run tauri dev.');
  return invoke<T>(command, args);
}
export const backend = {
  projects: () => call<Project[]>('list_projects'),
  createProject: (name: string) => call<Project>('create_project', { name }),
  renameProject: (id: string, name: string) => call<void>('rename_project', { id, name }),
  sessions: (projectId?: string|null) => call<Session[]>('list_sessions', { projectId:projectId??null }),
  session: (id: string) => call<Session>('get_session', { id }),
  renameSession: (id: string, name: string) => call<void>('rename_session', { id, name }),
  moveSession: (id:string,projectId:string|null) => call<Session>('move_session',{id,projectId}),
  sources: () => call<CaptureSource[]>('list_sources'),
  microphones: () => call<Microphone[]>('list_microphones'),
  setup: () => call<SetupStatus>('get_setup_status'),
  installTranscription: () => call<void>('install_transcription'),
  status: () => call<RecordingStatus>('get_recording_status'),
  start: (projectId: string|null, name: string|null, sourceId: string, microphoneId: string | null, systemAudio: boolean, muted: boolean) => call<Session>('start_recording', { projectId, name, sourceId, microphoneId, systemAudio, muted }),
  stop: () => call<Session>('stop_recording'),
  transcript: (id: string) => call<Transcript>('get_transcript', { id }),
  preview: (sourceId: string) => call<string>('source_preview', { sourceId }),
  openFolder: (id: string) => call<void>('open_session_folder', { id }),
  markers: (id: string) => call<Marker[]>('get_markers', { id }),
  addMarker: (id: string, timeMs: number, label: string) => call<Marker>('add_marker', { id, timeMs, label }),
  handoff: (id: string) => call<string>('get_agent_handoff', { id }),
  mute: (muted: boolean) => call<void>('set_microphone_muted', { muted }),
  retry: (id: string) => call<void>('retry_transcription', { id }),
};
export const videoUrl = (path: string) => convertFileSrc(path);
