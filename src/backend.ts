import { Channel, convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';

export interface Project { id: string; name: string; createdAt: string }
export type TakeStatus = 'recording' | 'finalizing' | 'swapping' | 'transcribing' | 'ready' | 'error' | 'interrupted';
/**
 * One continuous capture inside a session. Take N lives in `takes/<N>/`; the root files are take 1. `sourceId` is the
 * source the take recorded (absent on older takes, which recorded the session's source), `microphoneId` absent when the
 * take has none. `swapping` appears only in sessions saved before takes kept their own videos.
 */
export interface Take { index: number; offsetMs: number; durationMs: number; status: TakeStatus; folder: string; sourceId?: string; microphoneId?: string; systemAudio: boolean }
/** Start of a take on the combined timeline, for the "Take N · m:ss" divider. */
export interface TakeMark { index: number; startMs: number }
/** What a `window:` or `monitor:` source id named at the session's first capture (docs/ARCHITECTURE.md, Source identity). */
export type SourceIdentity =
  | { kind: 'window'; title: string; process: string; class: string; pid?: number; processCreatedMs?: number }
  | { kind: 'display'; device: string; left: number; top: number; right: number; bottom: number };
/** A take's own video on the session timeline. Take 1's is `videoPath`, take N's `<folderPath>/takes/<N>/video.mp4`. */
export interface TakeVideo { take: number; startMs: number; durationMs: number }
/**
 * `takes` is absent for sessions recorded before takes existed; `sourceIdentity` for sessions recorded before identities
 * and for other sources. `videos` (format 2) lists the take videos by start; without it the session has one video,
 * `videoPath`, from 0 for `durationMs`, the whole timeline's length.
 */
export interface Session { id: string; projectId: string|null; name: string; createdAt: string; durationMs: number; status: 'recording' | 'processing' | 'ready' | 'error'; videoPath?: string; folderPath?: string; error?: string; sourceId?: string; sourceIdentity?: SourceIdentity; microphoneId?: string; systemAudio?: boolean; autoTitle?: boolean; takes?: Take[]; formatVersion?: number; videos?: TakeVideo[] }
export interface Word { text: string; startMs: number; endMs: number; seekMs?: number }
/**
 * A transcript sentence. While recording, the live transcript lists the finished stretches first,
 * ordinary final words whose ids start `stretch-`, then at most one segment of words still being
 * heard, last, whose id starts `live-` (`stillHeard` in review.ts): its words may change every
 * second. While nothing is being heard there is no `live-` segment.
 */
export interface Segment { id?: string; startMs: number; endMs: number; text: string; words: Word[] }
export interface Transcript { segments: Segment[]; language?: string; status?: string; error?: string; takes?: TakeMark[] }
export interface CaptureSource { id: string; name: string; kind: 'display' | 'window' | 'android' | 'quest' | 'camera'; available: boolean; detail?: string }
export interface Microphone { id: string; name: string }
export interface RecordingStatus { state: 'idle' | 'recording' | 'processing' | 'error'; sessionId?: string; elapsedMs?: number; audioLevel?: number; liveTranscript?: Transcript; error?: string; takeIndex?: number; takeOffsetMs?: number;
  /** Counts transcripts refined in the background after Stop; the open recording's transcript is read again when it changes. */
  transcriptRevision?: number }
/** A transcription language: English by default, or German. */
export type Language = 'en' | 'de';
/** The chosen language's speech model: base transcribes until it is `ready`. A failed or missing one is fetched with `downloadLanguageModel`. */
export interface LanguageModel { language: Language; model: string; state: 'ready' | 'downloading' | 'failed' | 'missing'; receivedBytes: number; totalBytes: number; error?: string }
/** `languageModel` is absent when the environment names a custom model. */
export interface SetupStatus { ready: boolean; issues: string[]; dependencies?: {name:string;available:boolean;path?:string;detail?:string}[]; modelReady?:boolean; modelPath?:string; languageModel?: LanguageModel }
export interface Marker { id: string; timeMs: number; label: string }
/** App-wide preferences in `<data root>/settings.json`, shared with the `cue` CLI. An absent `language` is English. */
export interface Settings { vocabulary?: string; language?: Language }

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
  /** The chosen language's model alone, as `setup().languageModel` reports it, without checking the tools: read each second while it downloads. */
  languageModel: () => call<LanguageModel | null>('get_language_model'),
  /** Starts the chosen language's model download in the background, or starts it again after a failure; the model reads `downloading` once it returns. Rejects with a message to show, e.g. while transcription is not installed. */
  downloadLanguageModel: () => call<void>('download_language_model'),
  status: () => call<RecordingStatus>('get_recording_status'),
  start: (projectId: string|null, name: string|null, sourceId: string, microphoneId: string | null, systemAudio: boolean, muted: boolean) => call<Session>('start_recording', { projectId, name, sourceId, microphoneId, systemAudio, muted }),
  stop: () => call<Session>('stop_recording'),
  /** Continue a ready session as a new take of any source, with its own video. A null microphone records without one, as in `start`. */
  recordMore: (id: string, sourceId: string, microphoneId: string | null, systemAudio: boolean, muted: boolean) => call<Session>('record_more', { id, sourceId, microphoneId, systemAudio, muted }),
  transcript: (id: string) => call<Transcript>('get_transcript', { id }),
  /**
   * Starts the live preview of `sourceId`. `onError` hears that the stream failed and stopped;
   * `onDrop` hears the `view` label (`?view=N` on the URL) of an image connection that ended
   * while the stream goes on, so that image can reconnect to the same URL.
   */
  preview: (sourceId: string, id:string, onError:(error:string)=>void, onDrop:(view:string)=>void = () => {}) => {
    const errors=new Channel<string>();errors.onmessage=onError;
    const drops=new Channel<string>();drops.onmessage=onDrop;
    return previewOperation(()=>call<{id:string;url:string}>('start_preview', { sourceId,id,errors,drops }));
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
