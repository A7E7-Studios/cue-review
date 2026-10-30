import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { backend, videoUrl } from './backend';
import type { CaptureSource, Project, RecordingStatus, Session, Settings, SetupStatus, Transcript } from './backend';
import { CompactDragStrip, TitleBar } from './chrome/TitleBar';
import { platform as detectPlatform } from './chrome/windowApi';
import type { Platform } from './chrome/windowApi';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { Icon } from './icons';
import { errorMessage, seekTime } from './review';
import { SearchDialog } from './search/SearchDialog';
import { Sidebar } from './Sidebar';
import { CaptureControls } from './workspace/CaptureControls';
import { captureEmptyState, MediaStage, reviewEmptyState } from './workspace/MediaStage';
import type { MediaStageViewProps } from './workspace/MediaStage';
import { PLAYBACK_SPEEDS, PlaybackBar } from './workspace/PlaybackBar';
import { RecordingDock } from './workspace/RecordingDock';
import { SessionHeader } from './workspace/SessionHeader';
import { TranscriptPane } from './workspace/TranscriptPane';
import { NAMES } from './workspace/types';
import type { CaptureMenu, MediaEmptyState, WorkspaceMode } from './workspace/types';
import { DeleteRecordingDialog, DiscardTakeDialog, NameDialog } from './app/dialogs';
import type { NameDialogState } from './app/dialogs';
import { liveTake, recordingTranscript, releaseMedia, sessionVideoUrl, takeInFlight, takeMarks, takeSwapping } from './app/media';
import { MICROPHONE_UNAVAILABLE, useCaptureDevices } from './app/useCaptureDevices';
import { useCompactWindow } from './app/useCompactWindow';
import { useContextMenuGuard } from './app/useContextMenuGuard';
import { canTakeFocus, useFocusRescue } from './app/useFocusRescue';
import { usePreviewStream } from './app/usePreviewStream';
import { useShortcuts } from './app/useShortcuts';
import { useSidebarLayout, useSidebarSlide } from './app/useSidebarLayout';
import { useTheme } from './app/useTheme';

const EMPTY_TRANSCRIPT: Transcript = { segments: [] };
/** The chosen playback speed stays for every recording and the next start (playback-controls spec). */
const SPEED_KEY = 'cuereview.playbackSpeed';
function storedSpeed() {
  try {
    const value = Number(localStorage.getItem(SPEED_KEY));
    return (PLAYBACK_SPEEDS as readonly number[]).includes(value) ? value : 1;
  } catch { return 1; }
}
const STARTING_TAKE: MediaEmptyState = { title: 'Starting the next take…' };
/** The recording bar's source in review when the session's source is no longer listed, or a reused window or display id has no stored identity to name it by. */
const ORIGINAL_SOURCE = 'Original source';
/** Ids a restart can hand to another window or display (docs/ARCHITECTURE.md, Source identity). */
const REUSABLE_SOURCE_ID = /^(window|monitor):/;
/**
 * The session's own source, which Record more records, as the recording bar in review names it. A listed
 * source keeps its listed name only when its id cannot have passed to another source: a `window:` or
 * `monitor:` id can name another window or display after a restart, and the listing lacks what tells
 * them apart (the owning process, the display device), so such a source is named by what the session
 * stored for it: its window's title, or its display's device number ("Display 1" for `\\.\DISPLAY1`),
 * else as the original source. A source that is no longer listed is the original source.
 */
function sessionSourceOf(session: Session, sources: CaptureSource[]): CaptureSource {
  const id = session.sourceId ?? '';
  const listed = sources.find(item => item.id === id);
  if (listed && !REUSABLE_SOURCE_ID.test(id)) return listed;
  const identity = session.sourceIdentity;
  const display = identity?.kind === 'display' ? /DISPLAY(\d+)$/i.exec(identity.device)?.[1] : undefined;
  const stored = identity?.kind === 'window' ? identity.title.trim() : display ? `Display ${display}` : '';
  return { id, name: listed && stored ? stored : ORIGINAL_SOURCE, kind: id.startsWith('window:') ? 'window' : 'display', available: !!listed };
}
/** Runtime status polling: every 700 ms, backing off up to 10 s while the backend keeps failing. */
const POLL_MS = 700;
const POLL_MAX_MS = 10000;
const pollDelay = (failures: number) => Math.min(POLL_MS * 2 ** failures, POLL_MAX_MS);
type Playback = { id: string; time: number; playing: boolean };
const inProgress = (item: Session) => item.status === 'recording' || item.status === 'processing';
const settled = (item: Session) => item.status === 'ready' || item.status === 'error';

export interface AppProps {
  /** Window chrome and shortcut labels follow this platform; detected from the user agent when omitted. */
  platform?: Platform;
}

export default function App({ platform: requested }: AppProps = {}) {
  const os = requested ?? detectPlatform();
  /** The workspace's inline error. Dialogs show only `dialogError`, so a stale banner never reads as a dialog failure. */
  const [error, setError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [notice, setNotice] = useState('');
  const report = useCallback((problem: unknown) => { setError(errorMessage(problem)); }, []);
  const reportInDialog = useCallback((problem: unknown) => { setDialogError(errorMessage(problem)); }, []);
  const [theme, setTheme] = useTheme(report, os);
  useContextMenuGuard();
  const sidebar = useSidebarLayout();
  const { visible: sidebarVisible, overlay: sidebarOverlay, dismissOverlay } = sidebar;
  const { compact, toggleCompact, exitCompact } = useCompactWindow(report);
  const {
    sources, sourceOptions, microphones, source, microphoneUnavailable, refreshDevices,
    sourceId, setSourceId, microphoneId, setMicrophoneId, systemAudio, setSystemAudio, muted, setMuted,
  } = useCaptureDevices();

  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [draft, setDraft] = useState(true);
  const [transcript, setTranscript] = useState<Transcript>(EMPTY_TRANSCRIPT);
  const [status, setStatus] = useState<RecordingStatus>({ state: 'idle' });
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [captureMenu, setCaptureMenu] = useState<CaptureMenu | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [startingRecording, setStartingRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [dialog, setDialog] = useState<NameDialogState | null>(null);
  const [deletion, setDeletion] = useState<{ id: string; name: string } | null>(null);
  /** The take whose discard is being confirmed. */
  const [discarding, setDiscarding] = useState<{ id: string; index: number } | null>(null);
  /** Why Record more failed, shown under the recording bar rather than in the workspace banner. */
  const [recordMoreError, setRecordMoreError] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  /** Transcripts the search window searches, by session id, with the status and length they were read at. */
  const [searchTranscripts, setSearchTranscripts] = useState<ReadonlyMap<string, Transcript>>(() => new Map());
  const searchRead = useRef(new Map<string, string>());
  /** Each Ctrl/⌘+F asks the transcript to open its find bar. */
  const [findRequest, setFindRequest] = useState(0);
  /** Changing it remounts the <video>, for example to restore playback after a failed delete. */
  const [mediaRevision, setMediaRevision] = useState(0);
  /** The session whose video stays unloaded while a take records and is appended to video.mp4. */
  const [heldMedia, setHeldMedia] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(storedSpeed);
  const [focusVideo, setFocusVideo] = useState(false);
  /** Whether leaving focus docks the sidebar again: only when it was docked before focus. */
  const focusRestoresSidebar = useRef(false);
  const [draftSection, setDraftSection] = useState<string | null>(null);

  const video = useRef<HTMLVideoElement>(null);
  const appRoot = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const deletionFocus = useRef<HTMLElement | null>(null);
  /** Set while the app itself unloads the video, so the resulting media events are not failures. */
  const releasing = useRef(false);
  const restorePlayback = useRef<Playback | null>(null);
  const selection = useRef(0);
  /** The recording shown or about to be shown, set as soon as it is chosen (before React re-renders). */
  const shownId = useRef<string | null>(null);
  const actionEpoch = useRef(0);
  const runtimeState = useRef<RecordingStatus['state']>('idle');
  /** The last runtime error shown, so the poll does not bring back a dismissed one. */
  const runtimeError = useRef('');
  /** The last poll failure shown, so a backend that keeps failing reports it once. */
  const pollError = useRef('');
  /** Whether a dialog is open, for errors that arrive from outside it. */
  const dialogOpen = useRef(false);

  const recording = status.state === 'recording';
  /** The runtime transcribes one job at a time and refuses a new capture meanwhile, whichever recording it is. */
  const captureBlocked = status.state === 'processing';
  /** Processing of the open recording. A background job for another recording does not count. */
  const processing = session?.status === 'processing' || (captureBlocked && !!session && status.sessionId === session.id);
  const mode: WorkspaceMode = recording ? 'recording' : draft ? 'draft' : 'review';
  const locked = recording || busy;
  const previewPaused = sourceId.startsWith('v4l2:') && (recording || startingRecording);
  const { preview, previewError, onPreviewError } = usePreviewStream(sourceId, (draft || recording) && !previewPaused && !!source?.available, previewRevision);
  const mediaHeld = !!session && (heldMedia === session.id || takeInFlight(session));
  const videoSrc = session && !draft && !mediaHeld ? sessionVideoUrl(session, videoUrl) : undefined;
  /** Devices must have loaded: until then the microphone choice is unknown and a take would record without it. */
  const devicesReady = microphoneId !== undefined;
  /**
   * Record more itself unloads the video while its take starts. That is a busy moment for Record more
   * (aria-disabled), not a reason to disable it, so focus stays on it through a refusal.
   */
  const startingTake = busy && !!session && heldMedia === session.id && !takeInFlight(session);
  const canRecordMore = !!session && !draft && settled(session) && (!!videoSrc || startingTake) && devicesReady;
  const sessionSource = session ? sessionSourceOf(session, sources) : undefined;
  useLayoutEffect(() => { dialogOpen.current = !!dialog || !!deletion || !!discarding || settingsOpen; });
  const noAudio = !microphoneId && !systemAudio;
  const deviceAudioOnly = (source?.kind === 'android' || source?.kind === 'quest') && !microphoneId && systemAudio;

  useLayoutEffect(() => { document.documentElement.dataset.platform = os; }, [os]);

  const refreshProjects = useCallback(async () => {
    const [items, all] = await Promise.all([backend.projects(), backend.sessions()]);
    const sorted = all.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    setProjects(items);
    setSessions(sorted);
    // A rename from the CLI (`cue rename`) reaches the open recording's title too.
    setSession(current => {
      const fresh = current && sorted.find(item => item.id === current.id);
      return current && fresh && fresh.name !== current.name ? { ...current, name: fresh.name, autoTitle: fresh.autoTitle } : current;
    });
  }, []);

  const openSession = useCallback(async (id: string) => {
    const request = ++selection.current;
    restorePlayback.current = null; setDraftSection(null); setLoading(true); setCaptureMenu(null); setError(''); setRecordMoreError(''); dismissOverlay();
    try {
      const next = await backend.session(id);
      const text = await backend.transcript(id);
      if (request !== selection.current) return;
      shownId.current = next.id;
      setSession(next); setTranscript(text); setDraft(false); setTime(0); setPlaying(false); setDuration(next.durationMs);
      if (settled(next)) setHeldMedia(current => current === next.id ? null : current);
      if (next.status === 'recording') {
        // Restore the capture's choices, including a later take's microphone.
        const take = next.takes?.find(item => item.status === 'recording');
        if (next.sourceId) setSourceId(next.sourceId);
        setMicrophoneId(take ? take.microphoneId || '' : next.microphoneId || '');
        setSystemAudio(take ? take.systemAudio : next.systemAudio || false);
      }
    } catch (problem) { if (request === selection.current) report(problem); }
    finally { if (request === selection.current) setLoading(false); }
  }, [report, dismissOverlay, setSourceId, setMicrophoneId, setSystemAudio]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await refreshProjects();
        const [health, recordingStatus] = await Promise.all([backend.setup(), backend.status()]);
        if (!alive) return;
        setSetup(health); setStatus(recordingStatus); runtimeState.current = recordingStatus.state;
        if (recordingStatus.sessionId) await openSession(recordingStatus.sessionId);
        await refreshDevices();
      } catch (problem) { if (alive) report(problem); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [refreshProjects, refreshDevices, openSession, report]);

  useEffect(() => {
    if (!isTauri()) return;
    // The window refused to close: say why where the user is, in an open dialog or in the workspace.
    const subscription = listen<string>('close-blocked', event => (dialogOpen.current ? setDialogError : setError)(event.payload));
    return () => { void subscription.then(unlisten => unlisten()); };
  }, []);

  // The CLI can rename or add recordings while the app is in the background.
  useEffect(() => {
    const refresh = () => { void refreshProjects().catch(() => {}); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible); };
  }, [refreshProjects]);

  // Runtime status. Stop returns before a take is appended and transcribed, so the open
  // recording is re-read until it settles, and then its video and transcript reload.
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const poll = async () => {
      const epoch = actionEpoch.current;
      const current = () => alive && epoch === actionEpoch.current;
      // A response about this recording lands only if it is still the one shown and the user has not
      // asked for another one (or a new draft) since this poll began, even before React re-renders.
      const picked = selection.current;
      const stillOpen = () => current() && picked === selection.current && !!session && shownId.current === session.id;
      try {
        const next = await backend.status();
        if (!current()) return;
        setStatus(next);
        const finished = runtimeState.current === 'processing' && next.state === 'idle';
        runtimeState.current = next.state;
        if (finished) await refreshProjects();
        if (!current()) return;
        if (next.error && next.error !== runtimeError.current) setError(next.error);
        runtimeError.current = next.error || '';
        if (session && inProgress(session) && next.state !== 'recording' && stillOpen()) {
          const fresh = await backend.session(session.id);
          if (!stillOpen()) return;
          if (settled(fresh)) {
            // The recording is done even if its transcript cannot be read yet: show it, then report the read.
            let text: Transcript | undefined;
            let unreadable: unknown;
            try { text = await backend.transcript(fresh.id); } catch (problem) { unreadable = problem; }
            if (!stillOpen()) return;
            setSession(fresh); setDuration(fresh.durationMs);
            if (text) setTranscript(text);
            setHeldMedia(held => held === fresh.id ? null : held);
            if (unreadable !== undefined) report(unreadable);
            if (!finished) await refreshProjects();
          } else setSession(fresh);
        }
        failures = 0;
        pollError.current = '';
      } catch (problem) {
        if (!alive) return;
        failures++;
        // Report a failure once, not every poll; a dismissed one stays dismissed until it changes or recovers.
        const message = errorMessage(problem);
        if (message !== pollError.current) { pollError.current = message; setError(message); }
      } finally {
        if (alive) timer = setTimeout(() => void poll(), pollDelay(failures));
      }
    };
    timer = setTimeout(() => void poll(), POLL_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [session?.id, session?.status, refreshProjects, report]);

  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(timer); }, [notice]);
  // Compact mode exists only while recording.
  useEffect(() => { if (compact && !recording) void exitCompact(); }, [compact, recording, exitCompact]);

  /** A new session; one started from a section heading is filed in that section when it records. */
  const prepare = useCallback((sectionId?: unknown) => {
    if (locked) return;
    setDraftSection(typeof sectionId === 'string' ? sectionId : null);
    selection.current++; shownId.current = null; restorePlayback.current = null; dismissOverlay();
    setLoading(false); setDraft(true); setSession(null); setTranscript(EMPTY_TRANSCRIPT); setPlaying(false); setTime(0); setCaptureMenu(null); setRecordMoreError('');
  }, [locked, dismissOverlay]);
  const seek = useCallback((ms: number) => {
    const next = seekTime(ms, duration);
    if (video.current) video.current.currentTime = next / 1000;
    setTime(next);
  }, [duration]);
  const togglePlay = useCallback(async () => {
    const media = video.current;
    if (!media || mode !== 'review') return;
    try { if (media.paused) await media.play(); else media.pause(); } catch (problem) { report(problem); }
  }, [mode, report]);
  // Focus video hides the sidebar and the transcript; leaving it docks the sidebar again if it was docked before.
  const toggleFocus = () => {
    if (focusVideo) { setFocusVideo(false); return; }
    // Focus clears the docked preference at any width, so a window that widens meanwhile shows no
    // sidebar; an overlay (a narrow window) simply closes. Leaving focus docks it again if it was.
    focusRestoresSidebar.current = sidebar.docked;
    sidebar.undock(); dismissOverlay();
    setFocusVideo(true);
  };
  /** Showing the sidebar while focused ends focus, so the transcript returns with it. */
  const toggleSidebar = () => {
    // It shows the sidebar now; leaving focus still docks it again if it was docked before focus.
    if (focusVideo && !sidebarVisible) { setFocusVideo(false); sidebar.show(); } else sidebar.toggle();
  };
  const wasFocused = useRef(false);
  useEffect(() => {
    if (wasFocused.current && !focusVideo && focusRestoresSidebar.current) sidebar.dock();
    if (!focusVideo) focusRestoresSidebar.current = false;
    wasFocused.current = focusVideo;
  }, [focusVideo, sidebar.dock]);
  // Focus belongs to review: a new recording or a recording in progress ends it.
  useEffect(() => { if (focusVideo && mode !== 'review') setFocusVideo(false); }, [focusVideo, mode]);
  const chooseSpeed = (next: number) => {
    setSpeed(next);
    try { localStorage.setItem(SPEED_KEY, String(next)); } catch { /* the speed still applies now */ }
    if (video.current) video.current.playbackRate = next;
  };

  /** Unloads the review video, remembering where playback was in case it must come back. */
  const unloadVideo = (id: string): Playback | null => {
    const media = video.current;
    if (!media) return null;
    const playback = { id, time: media.currentTime, playing: !media.paused };
    restorePlayback.current = null; releasing.current = true;
    releaseMedia(media);
    setPlaying(false);
    return playback;
  };
  const reloadVideo = (playback: Playback | null) => {
    if (playback) restorePlayback.current = playback;
    setMediaRevision(value => value + 1);
  };

  const start = async () => {
    if (busy || captureBlocked || loading || recording || !devicesReady) return;
    actionEpoch.current++; setBusy(true); setError(''); setCaptureMenu(null);
    try {
      if (!source?.available) throw new Error(source?.detail || 'Choose an available screen, window, or connected device first.');
      if (microphoneUnavailable) throw new Error(MICROPHONE_UNAVAILABLE);
      setStartingRecording(true);
      const target = draftSection && projects.some(section => section.id === draftSection) ? draftSection : null;
      const next = await backend.start(target, null, sourceId, microphoneId || null, systemAudio, muted);
      shownId.current = next.id;
      setSession(next); setDraft(false); setTranscript(EMPTY_TRANSCRIPT); runtimeState.current = 'recording';
      setStatus({ state: 'recording', sessionId: next.id, elapsedMs: 0 }); setTime(0); setPlaying(false);
      await refreshProjects();
    } catch (problem) { report(problem); }
    finally { setStartingRecording(false); setBusy(false); }
  };
  const stop = async () => {
    if (busy || !recording) return;
    actionEpoch.current++; setBusy(true); setError('');
    try {
      const next = await backend.stop();
      // A mute from the dock lasts for its take: the next one starts unmuted unless Mute is ticked again.
      setMuted(false);
      setSession(next); setDraft(false);
      runtimeState.current = next.status === 'processing' ? 'processing' : 'idle';
      setStatus({ state: runtimeState.current, sessionId: runtimeState.current === 'processing' ? next.id : undefined }); setDuration(next.durationMs);
      if (settled(next)) {
        setTranscript(await backend.transcript(next.id));
        setHeldMedia(current => current === next.id ? null : current);
      }
      await refreshProjects();
    } catch (problem) { report(problem); }
    finally { setBusy(false); }
  };
  /**
   * Continues the open recording as a new take on its own source (decision 10), with the recording
   * bar's microphone. A refusal, such as a source that is gone, is shown under the bar with New
   * recording as the way forward.
   */
  const recordMore = async () => {
    if (!session || !canRecordMore || busy || loading || recording || processing || captureBlocked) return;
    if (microphoneUnavailable) { setRecordMoreError(MICROPHONE_UNAVAILABLE); return; }
    actionEpoch.current++; setBusy(true); setError(''); setRecordMoreError(''); setCaptureMenu(null);
    // Windows keeps an open file locked and the backend replaces video.mp4 after the take,
    // so the video is unloaded first and stays unloaded until processing has finished.
    const playback = unloadVideo(session.id);
    setHeldMedia(session.id);
    try {
      // The take uses the current microphone choice and the session's own source and system audio.
      const next = await backend.recordMore(session.id, microphoneId || null, session.systemAudio ?? false, muted);
      const take = next.takes?.find(item => item.status === 'recording') ?? next.takes?.at(-1);
      setSession(next); setTime(0);
      if (next.sourceId) setSourceId(next.sourceId);
      setSystemAudio(next.systemAudio ?? false);
      runtimeState.current = 'recording';
      setStatus({ state: 'recording', sessionId: next.id, elapsedMs: 0, takeIndex: take?.index, takeOffsetMs: take?.offsetMs });
      await refreshProjects();
    } catch (problem) {
      setHeldMedia(null);
      reloadVideo(playback);
      setRecordMoreError(errorMessage(problem));
    } finally { releasing.current = false; setBusy(false); }
  };
  const recordCommand = () => { if (recording) void stop(); else if (draft) void start(); else void recordMore(); };

  /** Search waits while recording, like the sidebar's rows. */
  const openSearch = () => { if (!locked) setSearchOpen(true); };
  // Reads the transcripts of settled recordings when search opens, a few at a time, and again only
  // for a recording whose status or length changed.
  useEffect(() => {
    if (!searchOpen) return;
    let alive = true;
    const stale = sessions.filter(item => settled(item) && searchRead.current.get(item.id) !== `${item.status}:${item.durationMs}`);
    const next = async () => {
      for (let item = stale.shift(); item && alive; item = stale.shift()) {
        const key = `${item.status}:${item.durationMs}`;
        const read = await backend.transcript(item.id).catch(() => null);
        if (!alive || !read) continue;
        searchRead.current.set(item.id, key);
        const id = item.id;
        setSearchTranscripts(current => new Map(current).set(id, read));
      }
    };
    void Promise.all([next(), next(), next(), next()]);
    return () => { alive = false; };
  }, [searchOpen, sessions]);
  /** A search result: the recording, standing at the line's time when there is one. */
  const openResult = (id: string, atMs?: number) => {
    void openSession(id);
    if (atMs !== undefined) restorePlayback.current = { id, time: atMs / 1000, playing: false };
  };
  useShortcuts({
    platform: os,
    enabled: !dialog && !deletion && !discarding && !settingsOpen && !searchOpen && !captureMenu,
    onRecord: recordCommand,
    onNew: prepare,
    onTogglePlay: mode === 'review' && videoSrc ? () => void togglePlay() : undefined,
    onSeekBy: mode === 'review' ? delta => seek(time + delta) : undefined,
    onSearch: locked ? undefined : openSearch,
    onFind: mode === 'review' ? () => setFindRequest(value => value + 1) : undefined,
    onEscape: sidebarOverlay ? dismissOverlay : focusVideo ? () => setFocusVideo(false) : undefined,
  });

  const changeMuted = async (next: boolean) => {
    try { await backend.mute(next); setMuted(next); } catch (problem) { report(problem); }
  };
  /** Every dialog opens without an error of its own. */
  const openDialog = (next: NameDialogState) => { setDialogError(''); setDialog(next); };
  const submitDialog = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog) return;
    const name = dialog.value.trim();
    if (!name) return;
    setBusy(true); setDialogError('');
    // A new section closes the dialog before moving a recording into it; a failed move belongs to the workspace.
    let closed = false;
    try {
      if (dialog.kind === 'section') {
        const next = await backend.createProject(name);
        setDialog(null); closed = true;
        await refreshProjects();
        if (dialog.sessionId) {
          const moved = await backend.moveSession(dialog.sessionId, next.id);
          setSession(current => current?.id === moved.id ? { ...current, projectId: moved.projectId } : current);
          await refreshProjects();
        }
      }
      if (dialog.kind === 'renameSection') { await backend.renameProject(dialog.id!, name); await refreshProjects(); }
      if (dialog.kind === 'renameRecording') {
        await backend.renameSession(dialog.id!, name);
        setSession(current => current && current.id === dialog.id ? { ...current, name } : current);
        await refreshProjects();
      }
      setDialog(null);
    } catch (problem) { (closed ? report : reportInDialog)(problem); }
    finally { setBusy(false); }
  };
  const copyHandoff = async () => {
    if (!session || recording || processing || busy) return;
    setBusy(true);
    try {
      const text = await backend.handoff(session.id);
      await navigator.clipboard.writeText(text);
      setNotice('Agent instructions copied');
    } catch (problem) { report(problem); }
    finally { setBusy(false); }
  };
  const moveSession = async (id: string, sectionId: string | null): Promise<boolean> => {
    const item = sessions.find(entry => entry.id === id);
    if (!item || locked || inProgress(item)) return false;
    if (item.projectId === sectionId) return true;
    setBusy(true); setError('');
    try {
      const moved = await backend.moveSession(id, sectionId);
      setSession(current => current?.id === moved.id ? { ...current, projectId: moved.projectId } : current);
      await refreshProjects();
      return true;
    } catch (problem) { report(problem); return false; }
    finally { setBusy(false); }
  };
  const reorderSections = async (ids: string[]): Promise<boolean> => {
    if (locked) return false;
    setBusy(true); setError('');
    try { await backend.reorderProjects(ids); await refreshProjects(); return true; }
    catch (problem) { report(problem); return false; }
    finally { setBusy(false); }
  };
  const deleteSection = async (item: Project) => {
    if (locked || sessions.some(entry => entry.projectId === item.id && inProgress(entry))) return;
    setBusy(true); setError('');
    try {
      await backend.deleteProject(item.id);
      setProjects(items => items.filter(section => section.id !== item.id));
      setSessions(items => items.map(entry => entry.projectId === item.id ? { ...entry, projectId: null } : entry));
      setSession(current => current?.projectId === item.id ? { ...current, projectId: null } : current);
      await refreshProjects();
      setNotice('Section deleted. Recordings moved to Recents.');
    } catch (problem) {
      report(problem);
      await refreshProjects().catch(() => {});
      if (session) await backend.session(session.id).then(fresh => setSession(current => current?.id === fresh.id ? { ...current, projectId: fresh.projectId } : current)).catch(() => {});
    } finally { setBusy(false); }
  };
  const deleteRecording = async () => {
    if (!deletion || locked) return;
    const item = sessions.find(entry => entry.id === deletion.id);
    if (!item || inProgress(item)) return;
    setBusy(true); setDialogError(''); selection.current++; actionEpoch.current++;
    // Windows holds the playing file open. Release it before deleting the folder.
    const playback = session?.id === item.id ? unloadVideo(item.id) : null;
    let deleted = false;
    try {
      await backend.deleteSession(item.id);
      deleted = true;
      setSessions(items => items.filter(entry => entry.id !== item.id));
      setDeletion(null);
      if (session?.id === item.id) {
        shownId.current = null;
        setSession(null); setDraft(true); setTranscript(EMPTY_TRANSCRIPT); setTime(0); setDuration(0); setPlaying(false); setLoading(false); setFocusVideo(false);
      }
      await refreshProjects();
      setNotice('Recording deleted');
    } catch (problem) {
      if (!deleted && playback) reloadVideo(playback);
      reportInDialog(problem);
    } finally { releasing.current = false; setBusy(false); }
  };
  const retry = async () => {
    // The runtime transcribes one job at a time, whichever recording it belongs to.
    if (!session || busy || captureBlocked) return;
    setBusy(true);
    // Retry may finish appending a take to video.mp4 first.
    const swapping = takeSwapping(session);
    const playback = swapping ? unloadVideo(session.id) : null;
    if (swapping) setHeldMedia(session.id);
    try {
      await backend.retry(session.id);
      setSession({ ...session, status: 'processing', error: undefined });
      runtimeState.current = 'processing';
      setStatus({ state: 'processing', sessionId: session.id });
      setError('');
    } catch (problem) {
      if (swapping) { setHeldMedia(null); reloadVideo(playback); }
      report(problem);
    } finally { releasing.current = false; setBusy(false); }
  };
  /**
   * Drops a take whose swap into video.mp4 keeps failing (`swapping` after a failed Retry). The take
   * keeps its folder and the session settles, usually to ready. The video stayed unloaded while the
   * take was pending; it reloads under a version that counts the discarded take, so the webview
   * cannot serve the copy it cached before Record more.
   */
  const discardTake = async () => {
    const target = discarding;
    if (!target || busy) return;
    actionEpoch.current++; setBusy(true); setDialogError('');
    try {
      const next = await backend.discardTake(target.id, target.index);
      // The take is gone either way: a transcript that cannot be read yet is reported in the workspace.
      let text: Transcript | undefined;
      let unreadable: unknown;
      try { text = await backend.transcript(next.id); } catch (problem) { unreadable = problem; }
      if (shownId.current === next.id) {
        setSession(next); setDuration(next.durationMs); setTime(0); setPlaying(false); setError('');
        if (text) setTranscript(text);
        setHeldMedia(held => held === next.id ? null : held);
        reloadVideo(null);
      }
      setDiscarding(null);
      setNotice(`Take ${target.index} discarded`);
      if (unreadable !== undefined) report(unreadable);
      await refreshProjects().catch(report);
    } catch (problem) { reportInDialog(problem); }
    finally { setBusy(false); }
  };
  /** Settings may close while it works: a late failure then goes to the workspace. */
  const reportFromSettings = (problem: unknown) => (dialogOpen.current ? reportInDialog : report)(problem);
  const install = async () => {
    setInstalling(true); setDialogError('');
    try { await backend.installTranscription(); setSetup(await backend.setup()); setNotice('Transcription tools installed'); }
    catch (problem) { reportFromSettings(problem); }
    finally { setInstalling(false); }
  };
  const openSettings = () => {
    setDialogError(''); setSettingsOpen(true);
    backend.settings().then(setSettings).catch(reportFromSettings);
  };
  const saveSettings = async (next: Settings) => { setSettings(await backend.saveSettings(next)); };

  // Workspace contents
  const marks = takeMarks(session, transcript);
  const shownTranscript = recording ? recordingTranscript(transcript, status) : { ...transcript, takes: marks };
  const transcriptError = mode === 'review' && !processing && (session?.status === 'error' || transcript.error)
    ? transcript.error || session?.error || 'The transcript could not be created.' : undefined;
  /** A take that Retry could not add to video.mp4, offered for discarding beside Retry. */
  const stuckTake = transcriptError && session?.status === 'error' ? session.takes?.find(take => take.index > 1 && take.status === 'swapping') : undefined;
  const emptyMessage = recording
    ? noAudio ? 'No audio input was selected for this recording.'
      : !setup?.modelReady ? 'Transcription needs setup.'
        : deviceAudioOnly ? 'Device audio is transcribed after recording.' : 'Listening… transcript updates in short batches.'
    : processing ? 'Transcribing…'
      : draft ? noAudio && microphoneId !== undefined ? 'No audio input is selected, so this recording will be video only.' : 'Words appear here while you record.'
        : loading ? undefined : 'No speech was detected in this recording.';
  const empty = mode !== 'review'
    ? captureEmptyState({ source, loading, paused: previewPaused, previewError })
    : busy && heldMedia === session?.id && !processing ? STARTING_TAKE
      // Nothing is under way for a stuck take, so the stage does not say it is finishing.
      : stuckTake && !loading ? { title: `Take ${stuckTake.index} is not in the video yet`, detail: 'Retry to add it, or discard the take to play the recording.' }
        : reviewEmptyState({ loading, processing: processing || mediaHeld });
  const videoProps: MediaStageViewProps['videoProps'] = {
    onTimeUpdate: event => setTime(event.currentTarget.currentTime * 1000),
    onLoadedMetadata: event => {
      const media = event.currentTarget;
      setDuration(Number.isFinite(media.duration) ? media.duration * 1000 : session?.durationMs ?? 0);
      media.playbackRate = speed;
      const restore = restorePlayback.current;
      if (restore && restore.id === session?.id) {
        restorePlayback.current = null;
        media.currentTime = restore.time; setTime(restore.time * 1000);
        if (restore.playing) void media.play().catch(report);
      }
    },
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onClick: () => void togglePlay(),
    onError: () => {
      const restoring = restorePlayback.current?.id === session?.id;
      if (restoring) restorePlayback.current = null;
      if (!releasing.current && !restoring) setError('This recording could not be played. Open its folder to inspect the video file.');
    },
  };

  const dock = <RecordingDock platform={os} elapsedMs={status.elapsedMs || 0} take={status.takeIndex ?? 1} audioLevel={status.audioLevel}
    sourceName={source?.name || 'Capture source'} hasMicrophone={!!microphoneId && !microphoneUnavailable}
    microphoneName={microphones.find(item => item.id === microphoneId)?.name} muted={muted} onMuted={next => void changeMuted(next)}
    compact={compact} onToggleCompact={() => void toggleCompact()} stopDisabled={busy} onStop={() => void stop()}/>;
  // The recording bar in a draft and in review: its microphone picker sets the next recording's or take's microphone.
  const bar = {
    platform: os, microphones, microphoneId, microphoneUnavailable, muted, menu: captureMenu, onMenu: setCaptureMenu,
    onSelectMicrophone: setMicrophoneId, onMuted: setMuted, onRefreshMicrophones: () => void refreshDevices().catch(report),
    onRefreshSources: () => void refreshDevices().then(() => setPreviewRevision(value => value + 1)).catch(report),
    locked, busy,
  };
  // `busy` is a moment, not a state of the control: those buttons stay focusable (aria-disabled), so focus never drops to the page.
  const controls = mode === 'recording' ? dock
    : mode === 'draft' ? <CaptureControls {...bar} sources={sourceOptions} source={source} systemAudio={systemAudio}
        onSelectSource={id => { setSourceId(id); setPreviewRevision(value => value + 1); }} onSystemAudio={setSystemAudio}
        recordLabel={busy ? NAMES.pleaseWait : captureBlocked ? NAMES.transcribing : NAMES.record}
        recordDisabled={captureBlocked || loading || !devicesReady || !source?.available || microphoneUnavailable} recordBusy={busy} onRecord={() => void start()}/>
      : <>
        <PlaybackBar platform={os} timeMs={time} durationMs={duration} segments={shownTranscript.segments} takes={marks} onSeek={seek}
          playing={playing} canPlay={!!videoSrc} onTogglePlay={() => void togglePlay()} speed={speed} onSpeed={chooseSpeed}
          focused={focusVideo} onToggleFocus={toggleFocus}/>
        {/* A take records the session's own source, so its picker is locked. */}
        <CaptureControls {...bar} review sourceLocked sources={sourceOptions} source={sessionSource} systemAudio={session?.systemAudio ?? false}
          onSelectSource={() => {}} onSystemAudio={() => {}}
          recordLabel={NAMES.recordMore} recordDisabled={!canRecordMore || loading || processing || captureBlocked} recordBusy={busy} onRecord={() => void recordMore()}
          recordMoreError={recordMoreError || undefined} onNewRecording={prepare} onDismissRecordMoreError={() => setRecordMoreError('')}/>
      </>;

  // Focus that loses its control goes to the control taking its place (decisions 6 and 9).
  useFocusRescue(appRoot, lost => {
    const find = (selector: string) => [...(appRoot.current?.querySelectorAll(selector) ?? [])].find(canTakeFocus);
    const toggle = lost.classList.contains('chrome-sidebar-toggle');
    if (toggle || lost.closest('.sidebar')) {
      // A row disabled for a moment keeps its place; a hidden sidebar or toggle hands focus to its counterpart.
      if (lost.isConnected && !lost.closest('[inert]')) return null;
      return sidebarVisible ? find('.sidebar .side-collapse') ?? find('.chrome-sidebar-toggle') : find('.chrome-sidebar-toggle');
    }
    // Compact and Expand swap with the layout: focus follows to the other one.
    const label = lost.getAttribute('aria-label');
    if (label === NAMES.compact || label === NAMES.expand) {
      const other = find(`.cr-dock-button[aria-label="${label === NAMES.compact ? NAMES.expand : NAMES.compact}"]`);
      if (other) return other;
    }
    if (mode === 'recording') return find('.cr-stop');
    return find('.cr-stage-controls .cr-record') ?? sheet.current;
  });
  /** The same home for a dialog whose invoking control is gone when it closes (a discarded take's button). */
  const stageFocus = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() { return [...(appRoot.current?.querySelectorAll('.cr-stage-controls .cr-record') ?? [])].find(canTakeFocus) ?? sheet.current; },
  }), []);

  const errorBanner = error && !dialog && !deletion && !discarding && !settingsOpen && <div className="app-error" role="alert">
    <Icon name="warning" strokeWidth={1.8}/><p>{error}</p>
    <button type="button" aria-label={NAMES.dismissError} title={NAMES.dismissError} onClick={() => setError('')}><Icon name="close" strokeWidth={1.8}/></button>
  </div>;
  const setupBanner = setup && !setup.ready && !recording && <div className="app-setup">
    <span>Transcription needs setup.</span>
    <button type="button" onClick={openSettings}>{NAMES.reviewSetup}<Icon name="arrow" strokeWidth={1.8}/></button>
  </div>;

  const workspace = <main ref={sheet} className="app-sheet" tabIndex={-1} data-dialog-focus-fallback>
    <div className="cr-center">
      <SessionHeader title={draft ? NAMES.newRecording : session?.name || 'Recording'} draft={draft}
        renameDisabled={recording || processing || busy} onRename={() => session && openDialog({ kind: 'renameRecording', id: session.id, value: session.name })}
        onOpenFolder={() => session && void backend.openFolder(session.id).catch(report)}
        copyDisabled={recording || processing} copyBusy={busy} onCopyForAgent={() => void copyHandoff()}/>
      {errorBanner}
      {setupBanner}
      <MediaStage mode={mode} previewUrl={preview || undefined} sourceName={source?.name} previewError={previewError || undefined}
        onPreviewError={onPreviewError} onRetryPreview={() => setPreviewRevision(value => value + 1)}
        videoSrc={videoSrc} videoKey={`${session?.id}:${mediaRevision}`} videoRef={video} videoProps={videoProps} empty={empty}
        focused={focusVideo && mode === 'review'}>
        {controls}
      </MediaStage>
    </div>
    {!(focusVideo && mode === 'review') && <div className="cr-transcript-column">
      <TranscriptPane mode={mode} transcript={shownTranscript} timeMs={recording ? (status.takeOffsetMs ?? 0) + (status.elapsedMs || 0) : time} onSeek={seek}
        status={recording ? 'recording' : processing ? 'processing' : undefined} liveTake={liveTake(status)}
        liveError={recording ? status.liveTranscript?.error : undefined} emptyMessage={emptyMessage}
        error={transcriptError} onRetry={() => void retry()} retryDisabled={captureBlocked} retryBusy={busy}
        findRequest={findRequest} discardTake={stuckTake?.index} onDiscardTake={stuckTake && session ? () => { setDialogError(''); setDiscarding({ id: session.id, index: stuckTake.index }); } : undefined}/>
    </div>}
  </main>;

  // The sidebar slides out and in, except beside a live preview or a recording, so live video is never resized by an animation.
  const liveVideo = mode !== 'review';
  const sidebarSlide = useSidebarSlide(sidebarVisible, sidebarOverlay, liveVideo);
  const sidebarElement = sidebarSlide.present && <div className="app-sidebar-slot" data-state={sidebarSlide.phase} inert={!sidebarVisible || undefined}><Sidebar platform={os} showCollapse={os === 'macos'} utilities={null} onSearch={openSearch}
    sections={projects} sessions={sessions} activeId={draft ? undefined : session?.id} locked={locked} loading={loading}
    onCollapse={sidebar.hide} onNew={prepare} onOpen={id => void openSession(id)}
    onRename={item => openDialog({ kind: 'renameRecording', id: item.id, value: item.name })}
    onRenameSection={item => openDialog({ kind: 'renameSection', id: item.id, value: item.name })}
    onCreateSection={sessionId => openDialog({ kind: 'section', sessionId, value: '' })} onNewInSection={prepare}
    onMove={moveSession} onReorder={reorderSections} onDeleteSection={item => void deleteSection(item)}
    onDeleteSession={item => { deletionFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setDialogError(''); setDeletion({ id: item.id, name: item.name }); }}/></div>;
  const titleBar = <TitleBar platform={os} sidebarVisible={sidebarVisible} onToggleSidebar={toggleSidebar}
    onOpenSettings={openSettings}/>;

  return <div ref={appRoot} className="app" data-platform={os} data-sidebar={compact ? undefined : !sidebarSlide.present ? 'hidden' : sidebarSlide.overlay ? 'overlay' : 'docked'}
    data-sidebar-motion={liveVideo ? 'instant' : 'slide'} data-compact={compact || undefined}>
    {compact ? <>
      <CompactDragStrip platform={os}/>
      <main ref={sheet} className="app-compact" tabIndex={-1} data-dialog-focus-fallback>{errorBanner}{dock}</main>
    </> : os === 'macos' ? <div className="app-body">
      {sidebarElement}
      <div className="app-main">{titleBar}{workspace}</div>
    </div> : <>
      {titleBar}
      <div className="app-body">{sidebarElement}{workspace}</div>
    </>}
    {sidebarOverlay && !compact && <div className="app-scrim" aria-hidden="true" onMouseDown={dismissOverlay}/>}

    <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} sessions={sessions} sections={projects} transcripts={searchTranscripts}
      onOpen={openResult} fallbackFocusRef={sheet}/>
    <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} fallbackFocusRef={sheet} theme={theme} onTheme={setTheme}
      setup={setup} installing={installing} onInstall={() => void install()} onCheckAgain={() => void backend.setup().then(setSetup).catch(reportFromSettings)}
      settings={settings} onSaveSettings={saveSettings} error={settingsOpen ? dialogError : undefined}/>
    <NameDialog state={dialog} busy={busy} error={dialog ? dialogError : ''} fallbackFocusRef={sheet}
      onChange={value => setDialog(current => current && { ...current, value })} onClose={() => setDialog(null)} onSubmit={event => void submitDialog(event)}/>
    <DeleteRecordingDialog target={deletion} busy={busy} error={deletion ? dialogError : ''} restoreFocusRef={deletionFocus} fallbackFocusRef={sheet}
      onClose={() => setDeletion(null)} onDelete={() => void deleteRecording()}/>
    <DiscardTakeDialog take={discarding?.index ?? null} busy={busy} error={discarding ? dialogError : ''} fallbackFocusRef={stageFocus}
      onClose={() => setDiscarding(null)} onDiscard={() => void discardTake()}/>
    {/* Always mounted, so screen readers announce each notice as it appears. */}
    <div className="app-toast-region" role="status">{notice && <div className="app-toast">{notice}</div>}</div>
  </div>;
}
