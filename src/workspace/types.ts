// Frozen contracts for the Float v2 Phase 1 components (docs/IMPLEMENTATION-PLAN.md).
// Each component is built and tested alone against these props, then mounted by WP G.
// Request changes through the coordinator.
import type { ReactNode, Ref, RefObject, VideoHTMLAttributes } from 'react';
import type { CaptureSource, Microphone, Project, Segment, Session, Settings, SetupStatus, TakeMark, Transcript } from '../backend';
import type { Platform, WindowTheme } from '../chrome/windowApi';

/** What the media slot and the controls under it show (decision 6). */
export type WorkspaceMode = 'draft' | 'recording' | 'review';

/** Windows: custom title bar. macOS and Linux: toolbar without window controls (decision 9). */
export interface TitleBarProps {
  platform: Platform;
  sidebarVisible: boolean;
  /** Labelled NAMES.hideSidebar or NAMES.showSidebar. */
  onToggleSidebar: () => void;
  /** Session-name filter for the sidebar (decision 11). */
  search: string;
  onSearch: (value: string) => void;
  /** Ctrl/⌘+K focuses this field. */
  searchRef?: RefObject<HTMLInputElement | null>;
  onOpenSettings: () => void;
  /** Compact recording mode: only a drag strip, leaving room for the macOS traffic lights. */
  compact?: boolean;
  /** The window is maximized, so the control reads NAMES.restoreWindow. Tracked internally when omitted. */
  maximized?: boolean;
}

/** The existing Sidebar props, plus the search filter and the collapse control (decision 2). */
export interface SidebarProps {
  sections: Project[];
  sessions: Session[];
  activeId?: string;
  locked: boolean;
  loading: boolean;
  /** Legacy utility buttons below the list; Float v2 moves them to the title bar and passes null. */
  utilities: ReactNode;
  onCollapse: () => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRename: (session: Session) => void;
  onRenameSection: (section: Project) => void;
  onCreateSection: (sessionId?: string) => void;
  onDeleteSection: (section: Project) => void;
  onDeleteSession: (session: Session) => void;
  onReorder: (ids: string[]) => Promise<boolean>;
  onMove: (sessionId: string, sectionId: string | null) => Promise<boolean>;
  /** Shows only sessions whose name contains it, case-insensitively, with a NAMES.noMatches state. */
  filter?: string;
  /** Render the NAMES.hideSidebar button inside the sidebar (macOS panel). Defaults to true. */
  showCollapse?: boolean;
  /** macOS reserves the traffic-light row at the top of the panel. */
  platform?: Platform;
}

/** Title row: title, open folder and the "Copy for agent" accent pill. No metadata chips (decision 3). */
export interface SessionHeaderProps {
  /** The session name, or NAMES.newRecording for a draft. */
  title: string;
  /** A draft shows a plain title and no actions. */
  draft: boolean;
  /** In review the h1 holds a button titled "Rename recording". */
  renameDisabled: boolean;
  onRename: () => void;
  onOpenFolder: () => void;
  /** Disabled while recording or processing (decision 10). */
  copyDisabled: boolean;
  /** Another action is under way: the pill stays focusable but inert (aria-disabled). */
  copyBusy?: boolean;
  onCopyForAgent: () => void;
}

export interface MediaEmptyState { title: string; detail?: string }
/** The single-border, top-aligned video or live preview, sized with a ResizeObserver (decision 1). */
export interface MediaStageProps {
  mode: WorkspaceMode;
  /** Live preview image (draft and recording). Its alt text is NAMES.livePreview(sourceName). */
  previewUrl?: string;
  /** Captured source, also shown as the "Live · {name}" badge while recording. */
  sourceName?: string;
  previewError?: string;
  /** The live preview image failed to load its stream; the stream hook reconnects it. */
  onPreviewError?: () => void;
  /** Offered as NAMES.retryPreview beside a preview error: starts the preview again. */
  onRetryPreview?: () => void;
  /** Review video source (`videoUrl(session.videoPath)`). */
  videoSrc?: string;
  /** Changing it remounts the <video>, for example to restore playback after a failed delete. */
  videoKey?: string;
  videoRef?: Ref<HTMLVideoElement>;
  /** Forwarded to the <video>: time, metadata, play, pause, ended, click and error handlers. */
  videoProps?: Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'>;
  /** Shown when there is no preview or video to show. */
  empty?: MediaEmptyState;
  /** Focus mode: the transcript is hidden and the video takes the freed space. */
  focused?: boolean;
}

/** A visually hidden native range labelled NAMES.playbackPosition, with speech, take ticks and progress drawn over it. */
export interface ScrubberProps {
  timeMs: number;
  durationMs: number;
  /** Speech ranges; the played part is drawn in the accent. */
  segments: Pick<Segment, 'startMs' | 'endMs'>[];
  /** Take starts. Take 1 draws no tick. */
  takes?: TakeMark[];
  onSeek: (ms: number) => void;
  disabled?: boolean;
}

/** Review controls: scrubber, play, time, speed, focus and the Record more pill (decision 6). */
export interface PlaybackBarProps {
  timeMs: number;
  durationMs: number;
  segments: Pick<Segment, 'startMs' | 'endMs'>[];
  takes?: TakeMark[];
  onSeek: (ms: number) => void;
  playing: boolean;
  /** False when the session has no playable video. */
  canPlay: boolean;
  onTogglePlay: () => void;
  /** 0.75, 1, 1.5 or 2; labelled NAMES.playbackSpeed(speed). */
  speed: number;
  onCycleSpeed: () => void;
  focused: boolean;
  /** Labelled NAMES.focusVideo or NAMES.restoreTranscript. */
  onToggleFocus: () => void;
  recordMoreDisabled: boolean;
  /** Another action is under way: Record more and the error's actions stay focusable but inert (aria-disabled). */
  recordMoreBusy?: boolean;
  onRecordMore: () => void;
  /** Why Record more failed, shown beside the pill as an alert, with NAMES.newRecording and NAMES.dismissError. */
  recordMoreError?: string;
  /** Starts a new recording instead, for a source that is gone. */
  onNewRecording?: () => void;
  onDismissRecordMoreError?: () => void;
}

export type CaptureMenu = 'source' | 'microphone';
/** Draft controls: source and microphone pickers and Record. Keeps the `.source-trigger` and `.mic-trigger` hooks. */
export interface CaptureControlsProps {
  /** Every listed source, including a placeholder for a missing previous choice. */
  sources: CaptureSource[];
  /** The selected source, possibly that placeholder. */
  source?: CaptureSource;
  microphones: Microphone[];
  /** '' is "No microphone"; undefined means the list has not loaded yet. */
  microphoneId?: string;
  microphoneUnavailable: boolean;
  systemAudio: boolean;
  muted: boolean;
  /** The open picker, controlled so Escape can close it and refocus its trigger. */
  menu: CaptureMenu | null;
  onMenu: (menu: CaptureMenu | null) => void;
  sourceTriggerRef?: Ref<HTMLButtonElement>;
  microphoneTriggerRef?: Ref<HTMLButtonElement>;
  onSelectSource: (id: string) => void;
  onSelectMicrophone: (id: string) => void;
  onSystemAudio: (enabled: boolean) => void;
  onMuted: (muted: boolean) => void;
  onRefreshSources: () => void;
  onRefreshMicrophones: () => void;
  /** Disables the source picker (recording or busy). */
  locked: boolean;
  /** Disables the microphone picker. */
  busy: boolean;
  /** NAMES.record, NAMES.pleaseWait or NAMES.transcribing. */
  recordLabel: string;
  recordDisabled: boolean;
  /** Recording is starting: Record stays focusable but inert (aria-disabled). */
  recordBusy?: boolean;
  onRecord: () => void;
}

/** The dark dock that replaces the playback bar while recording (decision 6). No progress bar. */
export interface RecordingDockProps {
  elapsedMs: number;
  /** The take being recorded, named only in the timer's name NAMES.takeTimer(take). 1 for a first recording. */
  take: number;
  /** 0 to 1. The meter is labelled NAMES.microphoneLevel; hidden when there is no live microphone. */
  audioLevel?: number;
  /** The locked source, shown as a disabled button. */
  sourceName: string;
  hasMicrophone: boolean;
  /** Toggle labelled NAMES.muteMicrophone with aria-pressed. */
  muted: boolean;
  onMuted: (muted: boolean) => void;
  /** Labelled NAMES.compact or NAMES.expand. */
  compact: boolean;
  onToggleCompact: () => void;
  /** Stop is under way. Stop stays visible and focusable but inert (aria-disabled). */
  stopDisabled: boolean;
  /** Labelled NAMES.stop. */
  onStop: () => void;
}

/** The transcript column (decisions 4, 10 and 12). */
export interface TranscriptPaneProps {
  mode: WorkspaceMode;
  /** The saved transcript, or during recording the live one. */
  transcript: Transcript;
  /** Playback time in review, elapsed time on the combined timeline while recording. */
  timeMs: number;
  /** Seek handler for NAMES.seekTo and NAMES.seekToWord. Words are inert while recording. */
  onSeek: (ms: number) => void;
  /** The only status chip: shown while recording or processing, never once ready. */
  status?: 'recording' | 'processing';
  /** The take being recorded: its divider and the live tail with its note. */
  liveTake?: TakeMark;
  /** Live transcription problem, shown as a status note. */
  liveError?: string;
  /** Shown in the body when there are no segments. */
  emptyMessage?: string;
  /** Inline error with NAMES.retryTranscription. */
  error?: string;
  onRetry?: () => void;
  retryDisabled?: boolean;
  /** Another action is under way: Retry and Discard take stay focusable but inert (aria-disabled). */
  retryBusy?: boolean;
  /** A take stuck being added to video.mp4: the error also offers NAMES.discardTake(discardTake). */
  discardTake?: number;
  onDiscardTake?: () => void;
}

/** Settings → Appearance, capability statuses, technical details and the vocabulary (decision 14, C5). */
export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  theme: WindowTheme;
  onTheme: (theme: WindowTheme) => void;
  /** null before the desktop app has reported its tools. */
  setup: SetupStatus | null;
  installing: boolean;
  onInstall: () => void;
  onCheckAgain: () => void;
  /** null until loaded. */
  settings: Settings | null;
  onSaveSettings: (settings: Settings) => Promise<void>;
  error?: string;
}

/**
 * Accessible names the app, src/*.test.tsx and scripts/verify-*.cjs find controls by.
 * Keep them exact: a renamed control breaks those lookups.
 */
export const NAMES = {
  // Window chrome
  titleBar: 'Title bar',
  toolbar: 'Toolbar',
  minimizeWindow: 'Minimize window',
  maximizeWindow: 'Maximize window',
  restoreWindow: 'Restore window',
  closeWindow: 'Close window',
  searchRecordings: 'Search recordings',
  settings: 'Settings',
  showSidebar: 'Show sidebar',
  hideSidebar: 'Hide sidebar',

  // Sidebar
  recordings: 'Recordings',
  newRecording: 'New recording',
  newSection: 'New section',
  recents: 'Recents',
  section: (name: string) => `Section: ${name}`,
  sectionOptions: (name: string) => `Section options for ${name}`,
  recordingOptions: 'Recording options',
  recordingActions: 'Recording actions',
  sectionActions: 'Section actions',
  moveToSection: 'Move to section',
  rename: 'Rename',
  moveUp: 'Move up',
  moveDown: 'Move down',
  deleteSectionItem: 'Delete section…',
  deleteRecordingItem: 'Delete recording…',
  noRecordings: 'No recordings',
  noMatches: 'No matches',

  // Session header
  renameRecording: 'Rename recording',
  openRecordingFolder: 'Open recording folder',
  copyForAgent: 'Copy for agent',

  // Media
  capturePreview: 'Capture preview',
  recordingVideo: 'Recording video',
  livePreview: (source: string) => `Live preview of ${source}`,
  retryPreview: 'Retry preview',

  // Playback
  playback: 'Playback',
  play: 'Play',
  pause: 'Pause',
  playbackPosition: 'Playback position',
  playbackSpeed: (speed: number) => `Playback speed ${speed}×`,
  focusVideo: 'Focus video',
  restoreTranscript: 'Restore transcript',
  recordMore: 'Record more',

  // Capture controls
  record: 'Record',
  pleaseWait: 'Please wait…',
  transcribing: 'Transcribing…',
  captureSources: 'Capture sources',
  refreshCaptureDevices: 'Refresh capture devices',
  unavailableSource: (name: string) => `${name} · unavailable`,
  includeSystemAudio: 'Include system audio',
  includeDeviceAudio: 'Include device audio',
  microphoneOptions: 'Microphone options',
  refreshMicrophones: 'Refresh microphones',
  noMicrophone: 'No microphone',
  microphoneUnavailable: 'Microphone unavailable',
  previousMicrophoneUnavailable: 'Previously selected microphone · unavailable',
  muted: 'Muted',
  muteMicrophone: 'Mute microphone',

  // Recording dock
  recordingControls: 'Recording controls',
  takeTimer: (take: number) => `Take ${take} elapsed time`,
  microphoneLevel: 'Microphone level',
  compact: 'Compact',
  expand: 'Expand',
  stop: 'Stop',

  // Transcript
  transcript: 'Transcript',
  findInTranscript: 'Find in transcript',
  seekTo: (time: string) => `Seek to ${time}`,
  seekToWord: (word: string, time: string) => `Seek to ${word} at ${time}`,
  returnToPlayback: 'Return to playback',
  retryTranscription: 'Retry transcription',
  discardTake: (take: number) => `Discard take ${take}`,

  // Dialogs and notices
  settingsDialog: 'Settings',
  closeSettings: 'Close settings',
  appearance: 'Appearance',
  installTranscription: 'Install transcription',
  downloadingSpeechTools: 'Downloading speech tools…',
  checkAgain: 'Check again',
  reviewSetup: 'Review setup',
  vocabulary: 'Vocabulary',
  nameField: 'Name',
  save: 'Save',
  cancel: 'Cancel',
  renameSectionDialog: 'Rename section',
  recordingNameDialog: 'Recording name',
  deleteRecordingDialog: 'Delete recording?',
  deleteRecording: 'Delete recording',
  discardTakeDialog: (take: number) => `Discard take ${take}?`,
  dismissError: 'Dismiss error',
} as const;

/** Names the current UI and scripts still use, removed during v0.2.0: markers (decision 5, WP G and H) and the sidebar theme toggle (decision 14). */
export const RETIRED_NAMES = {
  addMarker: 'Add marker',
  addMarkerDialog: 'Add marker',
  markerNote: 'Note',
  useLightTheme: 'Use light theme',
  useDarkTheme: 'Use dark theme',
} as const;

/** Class and attribute hooks scripts/verify-*.cjs select by, besides `video` and `h1 button` (rename). Keep them on the same elements. */
export const HOOKS = {
  sessionRow: 'session',
  sectionToggle: 'section-toggle',
  recentsHeading: 'recents-heading',
  recordingSection: 'recording-section',
  sideTools: 'side-tools',
  sourceTrigger: 'source-trigger',
  micTrigger: 'mic-trigger',
  previewImage: 'preview-image',
  word: 'word',
  sessionId: 'data-session-id',
  sectionId: 'data-section-id',
} as const;
