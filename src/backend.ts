import { Channel, convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';

export interface Project { id: string; name: string; createdAt: string }
export type TakeStatus = 'recording' | 'finalizing' | 'swapping' | 'transcribing' | 'ready' | 'error' | 'interrupted';
/** One continuous capture inside a session. Take N lives in `takes/<N>/`; the legacy root files are take 1. `sourceId` is absent when it is the session's source, `microphoneId` when the take has none. */
export interface Take { index: number; offsetMs: number; durationMs: number; status: TakeStatus; folder: string; sourceId?: string; microphoneId?: string; systemAudio: boolean }
/** Start of a take on the combined timeline, for the "Take N · m:ss" divider. */
export interface TakeMark { index: number; startMs: number }
/** `takes` is absent for sessions recorded before takes existed. */
export interface Session { id: string; projectId: string|null; name: string; createdAt: string; durationMs: number; status: 'recording' | 'processing' | 'ready' | 'error'; videoPath?: string; folderPath?: string; error?: string; sourceId?: string; microphoneId?: string; systemAudio?: boolean; autoTitle?: boolean; takes?: Take[] }
export interface Word { text: string; startMs: number; endMs: number; seekMs?: number }
export interface Segment { id?: string; startMs: number; endMs: number; text: string; words: Word[] }
export interface Transcript { segments: Segment[]; language?: string; status?: string; error?: string; takes?: TakeMark[] }
export interface CaptureSource { id: string; name: string; kind: 'display' | 'window' | 'android' | 'quest' | 'camera'; available: boolean; detail?: string }
export interface Microphone { id: string; name: string }
export interface RecordingStatus { state: 'idle' | 'recording' | 'processing' | 'error'; sessionId?: string; elapsedMs?: number; audioLevel?: number; liveTranscript?: Transcript; error?: string; takeIndex?: number; takeOffsetMs?: number }
export interface SetupStatus { ready: boolean; issues: string[]; dependencies?: {name:string;available:boolean;path?:string;detail?:string}[]; modelReady?:boolean; modelPath?:string }
export interface Marker { id: string; timeMs: number; label: string }
/** App-wide preferences in `<data root>/settings.json`, shared with the `cue` CLI. */
export interface Settings { vocabulary?: string }

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error('Open CueReview as a desktop app to access your recordings and capture devices. Run npm run tauri dev.');
  return invoke<T>(command, args);
}
// Preserve start/stop order when switching sources before startup has finished.
let previewQueue:Promise<unknown>=Promise.resolve();
function previewOperation<T>(operation:()=>Promise<T>):Promise<T> {
  const next=previewQueue.then(operation,operation);previewQueue=next.catch(()=>{});return next;
}
export const backend = {
  projects: () => call<Project[]>('list_projects'),
  createProject: (name: string) => call<Project>('create_project', { name }),
  renameProject: (id: string, name: string) => call<void>('rename_project', { id, name }),
  reorderProjects: (ids: string[]) => call<void>('reorder_projects', { ids }),
  deleteProject: (id: string) => call<void>('delete_project', { id }),
  deleteSession: (id: string) => call<void>('delete_session', { id }),
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
  /** Continue a ready session as a new take, locked to its source. A null microphone records without one, as in `start`. */
  recordMore: (id: string, microphoneId: string | null, systemAudio: boolean, muted: boolean) => call<Session>('record_more', { id, microphoneId, systemAudio, muted }),
  /**
   * Drop take `index` (2 or later) while it is stuck `swapping`: it becomes `interrupted` and keeps its
   * folder, and the session settles, usually to ready. Resolves to the updated session; the transcript's
   * take marks are updated too, so read it again.
   */
  discardTake: (id: string, index: number) => call<Session>('discard_take', { id, index }),
  transcript: (id: string) => call<Transcript>('get_transcript', { id }),
  preview: (sourceId: string, id:string, onError:(error:string)=>void) => {
    const errors=new Channel<string>();errors.onmessage=onError;
    return previewOperation(()=>call<{id:string;url:string}>('start_preview', { sourceId,id,errors }));
  },
  stopPreview: (id:string) => previewOperation(()=>call<void>('stop_preview',{id})),
  openFolder: (id: string) => call<void>('open_session_folder', { id }),
  markers: (id: string) => call<Marker[]>('get_markers', { id }),
  addMarker: (id: string, timeMs: number, label: string) => call<Marker>('add_marker', { id, timeMs, label }),
  handoff: (id: string) => call<string>('get_agent_handoff', { id }),
  mute: (muted: boolean) => call<void>('set_microphone_muted', { muted }),
  retry: (id: string) => call<void>('retry_transcription', { id }),
  settings: () => call<Settings>('get_settings'),
  saveSettings: (settings: Settings) => call<Settings>('save_settings', { settings }),
};
export const videoUrl = (path: string) => convertFileSrc(path);
