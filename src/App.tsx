import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { backend, videoUrl } from './backend';
import type { Project, RecordingStatus, Session, Settings, SetupStatus, Transcript } from './backend';
import { CompactDragStrip, TitleBar } from './chrome/TitleBar';
import { platform as detectPlatform } from './chrome/windowApi';
import type { Platform } from './chrome/windowApi';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { Icon } from './icons';
import { errorMessage, seekTime } from './review';
import { Sidebar } from './Sidebar';
import { CaptureControls } from './workspace/CaptureControls';
import { captureEmptyState, MediaStage, reviewEmptyState } from './workspace/MediaStage';
import type { MediaStageViewProps } from './workspace/MediaStage';
import { PlaybackBar } from './workspace/PlaybackBar';
import { RecordingDock } from './workspace/RecordingDock';
import { SessionHeader } from './workspace/SessionHeader';
import { TranscriptPane } from './workspace/TranscriptPane';
import { NAMES } from './workspace/types';
import type { CaptureMenu, MediaEmptyState, WorkspaceMode } from './workspace/types';
import { DeleteRecordingDialog, NameDialog } from './app/dialogs';
import type { NameDialogState } from './app/dialogs';
import { liveTake, recordingTranscript, releaseMedia, sessionVideoUrl, takeInFlight, takeMarks, takeSwapping } from './app/media';
import { MICROPHONE_UNAVAILABLE, useCaptureDevices } from './app/useCaptureDevices';
import { useCompactWindow } from './app/useCompactWindow';
import { usePreviewStream } from './app/usePreviewStream';
import { useShortcuts } from './app/useShortcuts';
import { useSidebarLayout } from './app/useSidebarLayout';
import { useTheme } from './app/useTheme';

const EMPTY_TRANSCRIPT: Transcript = { segments: [] };
const SPEEDS = [1, 1.5, 2, 0.75];
const STARTING_TAKE: MediaEmptyState = { title: 'Starting the next take…' };
type Playback = { id: string; time: number; playing: boolean };
const inProgress = (item: Session) => item.status === 'recording' || item.status === 'processing';
const settled = (item: Session) => item.status === 'ready' || item.status === 'error';

export interface AppProps {
  /** Window chrome and shortcut labels follow this platform; detected from the user agent when omitted. */
  platform?: Platform;
}

export default function App({ platform: requested }: AppProps = {}) {
  const os = requested ?? detectPlatform();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const report = useCallback((problem: unknown) => { setError(errorMessage(problem)); }, []);
  const [theme, setTheme] = useTheme(report);
  const sidebar = useSidebarLayout();
  const { visible: sidebarVisible, overlay: sidebarOverlay, dismissOverlay, show: showSidebar } = sidebar;
  const { compact, toggleCompact, exitCompact } = useCompactWindow(report);
  const {
    sourceOptions, microphones, source, microphoneUnavailable, refreshDevices,
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
  const [search, setSearch] = useState('');
  /** Changing it remounts the <video>, for example to restore playback after a failed delete. */
  const [mediaRevision, setMediaRevision] = useState(0);
  /** The session whose video stays unloaded while a take records and is appended to video.mp4. */
  const [heldMedia, setHeldMedia] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [focusVideo, setFocusVideo] = useState(false);

  const video = useRef<HTMLVideoElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const deletionFocus = useRef<HTMLElement | null>(null);
  /** Set while the app itself unloads the video, so the resulting media events are not failures. */
  const releasing = useRef(false);
  const restorePlayback = useRef<Playback | null>(null);
  const selection = useRef(0);
  const actionEpoch = useRef(0);
  const runtimeState = useRef<RecordingStatus['state']>('idle');
  /** The last runtime error shown, so the poll does not bring back a dismissed one. */
  const runtimeError = useRef('');

  const recording = status.state === 'recording';
  const processing = session?.status === 'processing' || status.state === 'processing';
  const mode: WorkspaceMode = recording ? 'recording' : draft ? 'draft' : 'review';
  const locked = recording || busy;
  const previewPaused = sourceId.startsWith('v4l2:') && (recording || startingRecording);
  const { preview, previewError } = usePreviewStream(sourceId, (draft || recording) && !previewPaused && !!source?.available, previewRevision);
  const mediaHeld = !!session && (heldMedia === session.id || takeInFlight(session));
  const videoSrc = session && !draft && !mediaHeld ? sessionVideoUrl(session, videoUrl) : undefined;
  const canRecordMore = !!session && !draft && settled(session) && !!videoSrc;
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
    restorePlayback.current = null; setLoading(true); setCaptureMenu(null); setError(''); dismissOverlay();
    try {
      const next = await backend.session(id);
      const text = await backend.transcript(id);
      if (request !== selection.current) return;
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
    const subscription = listen<string>('close-blocked', event => setError(event.payload));
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
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const epoch = actionEpoch.current;
      try {
        const next = await backend.status();
        if (!alive || epoch !== actionEpoch.current) return;
        setStatus(next);
        const finished = runtimeState.current === 'processing' && next.state === 'idle';
        runtimeState.current = next.state;
        if (finished) await refreshProjects();
        if (!alive || epoch !== actionEpoch.current) return;
        if (next.error && next.error !== runtimeError.current) setError(next.error);
        runtimeError.current = next.error || '';
        if (session && inProgress(session) && next.state !== 'recording') {
          const fresh = await backend.session(session.id);
          if (!alive || epoch !== actionEpoch.current) return;
          if (settled(fresh)) {
            const text = await backend.transcript(fresh.id);
            if (!alive || epoch !== actionEpoch.current) return;
            setSession(fresh); setTranscript(text); setDuration(fresh.durationMs);
            setHeldMedia(current => current === fresh.id ? null : current);
            if (!finished) await refreshProjects();
          } else setSession(fresh);
        }
      } catch (problem) { if (alive) report(problem); }
      finally { polling = false; }
    };
    const timer = setInterval(poll, 700);
    return () => { alive = false; clearInterval(timer); };
  }, [session?.id, session?.status, refreshProjects, report]);

  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(timer); }, [notice]);
  // Compact mode exists only while recording.
  useEffect(() => { if (compact && !recording) void exitCompact(); }, [compact, recording, exitCompact]);

  const prepare = useCallback(() => {
    if (locked) return;
    selection.current++; restorePlayback.current = null; dismissOverlay();
    setLoading(false); setDraft(true); setSession(null); setTranscript(EMPTY_TRANSCRIPT); setPlaying(false); setTime(0); setCaptureMenu(null);
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
  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
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
    if (busy || processing || loading || recording) return;
    actionEpoch.current++; setBusy(true); setError(''); setCaptureMenu(null);
    try {
      if (!source?.available) throw new Error(source?.detail || 'Choose an available screen, window, or connected device first.');
      if (microphoneUnavailable) throw new Error(MICROPHONE_UNAVAILABLE);
      setStartingRecording(true);
      const next = await backend.start(null, null, sourceId, microphoneId || null, systemAudio, muted);
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
      setSession(next); setDraft(false);
      runtimeState.current = next.status === 'processing' ? 'processing' : 'idle';
      setStatus({ state: runtimeState.current }); setDuration(next.durationMs);
      if (settled(next)) {
        setTranscript(await backend.transcript(next.id));
        setHeldMedia(current => current === next.id ? null : current);
      }
      await refreshProjects();
    } catch (problem) { report(problem); }
    finally { setBusy(false); }
  };
  /** Continues the open recording as a new take on its own source (decision 10). */
  const recordMore = async () => {
    if (!session || !canRecordMore || busy || loading || recording || processing) return;
    if (microphoneUnavailable) { report(MICROPHONE_UNAVAILABLE); return; }
    actionEpoch.current++; setBusy(true); setError('');
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
      report(problem);
    } finally { releasing.current = false; setBusy(false); }
  };
  const recordCommand = () => { if (recording) void stop(); else if (draft) void start(); else void recordMore(); };

  const changeSearch = (value: string) => {
    setSearch(value);
    if (value.trim() && !sidebarVisible) showSidebar();
  };
  useShortcuts({
    platform: os,
    enabled: !dialog && !deletion && !settingsOpen && !captureMenu,
    onRecord: recordCommand,
    onNew: prepare,
    onTogglePlay: mode === 'review' && videoSrc ? () => void togglePlay() : undefined,
    onSeekBy: mode === 'review' ? delta => seek(time + delta) : undefined,
    search: searchRef,
    onClearSearch: () => setSearch(''),
    onEscape: sidebarOverlay ? dismissOverlay : undefined,
  });

  const changeMuted = async (next: boolean) => {
    try { await backend.mute(next); setMuted(next); } catch (problem) { report(problem); }
  };
  const submitDialog = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog) return;
    const name = dialog.value.trim();
    if (!name) return;
    setBusy(true); setError('');
    try {
      if (dialog.kind === 'section') {
        const next = await backend.createProject(name);
        setDialog(null);
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
    } catch (problem) { report(problem); }
    finally { setBusy(false); }
  };
  const copyHandoff = async () => {
    if (!session || recording || processing) return;
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
    setBusy(true); setError(''); selection.current++; actionEpoch.current++;
    // Windows holds the playing file open. Release it before deleting the folder.
    const playback = session?.id === item.id ? unloadVideo(item.id) : null;
    let deleted = false;
    try {
      await backend.deleteSession(item.id);
      deleted = true;
      setSessions(items => items.filter(entry => entry.id !== item.id));
      setDeletion(null);
      if (session?.id === item.id) {
        setSession(null); setDraft(true); setTranscript(EMPTY_TRANSCRIPT); setTime(0); setDuration(0); setPlaying(false); setLoading(false); setFocusVideo(false);
      }
      await refreshProjects();
      setNotice('Recording deleted');
    } catch (problem) {
      if (!deleted && playback) reloadVideo(playback);
      report(problem);
    } finally { releasing.current = false; setBusy(false); }
  };
  const retry = async () => {
    if (!session) return;
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
  const install = async () => {
    setInstalling(true); setError('');
    try { await backend.installTranscription(); setSetup(await backend.setup()); setNotice('Transcription tools installed'); }
    catch (problem) { report(problem); }
    finally { setInstalling(false); }
  };
  const openSettings = () => {
    setSettingsOpen(true);
    backend.settings().then(setSettings).catch(report);
  };
  const saveSettings = async (next: Settings) => { setSettings(await backend.saveSettings(next)); };

  // Workspace contents
  const marks = takeMarks(session, transcript);
  const shownTranscript = recording ? recordingTranscript(transcript, status) : { ...transcript, takes: marks };
  const transcriptError = mode === 'review' && !processing && (session?.status === 'error' || transcript.error)
    ? transcript.error || session?.error || 'The transcript could not be created.' : undefined;
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
    sourceName={source?.name || 'Capture source'} hasMicrophone={!!microphoneId && !microphoneUnavailable} muted={muted} onMuted={next => void changeMuted(next)}
    compact={compact} onToggleCompact={() => void toggleCompact()} stopDisabled={busy} onStop={() => void stop()}/>;
  const controls = mode === 'recording' ? dock
    : mode === 'draft' ? <CaptureControls platform={os} sources={sourceOptions} source={source} microphones={microphones} microphoneId={microphoneId}
        microphoneUnavailable={microphoneUnavailable} systemAudio={systemAudio} muted={muted} menu={captureMenu} onMenu={setCaptureMenu}
        onSelectSource={id => { setSourceId(id); setPreviewRevision(value => value + 1); }} onSelectMicrophone={setMicrophoneId}
        onSystemAudio={setSystemAudio} onMuted={setMuted}
        onRefreshSources={() => void refreshDevices().then(() => setPreviewRevision(value => value + 1)).catch(report)}
        onRefreshMicrophones={() => void refreshDevices().catch(report)}
        locked={locked} busy={busy} recordLabel={busy ? NAMES.pleaseWait : processing ? NAMES.transcribing : NAMES.record}
        recordDisabled={busy || processing || loading || !source?.available || microphoneUnavailable} onRecord={() => void start()}/>
      : <PlaybackBar platform={os} timeMs={time} durationMs={duration} segments={shownTranscript.segments} takes={marks} onSeek={seek}
          playing={playing} canPlay={!!videoSrc} onTogglePlay={() => void togglePlay()} speed={speed} onCycleSpeed={cycleSpeed}
          focused={focusVideo} onToggleFocus={() => setFocusVideo(value => !value)}
          recordMoreDisabled={!canRecordMore || busy || loading || processing} onRecordMore={() => void recordMore()}/>;

  const errorBanner = error && !dialog && !deletion && !settingsOpen && <div className="app-error" role="alert">
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
        renameDisabled={recording || processing || busy} onRename={() => session && setDialog({ kind: 'renameRecording', id: session.id, value: session.name })}
        onOpenFolder={() => session && void backend.openFolder(session.id).catch(report)}
        copyDisabled={recording || processing || busy} onCopyForAgent={() => void copyHandoff()}/>
      {errorBanner}
      {setupBanner}
      <MediaStage mode={mode} previewUrl={preview || undefined} sourceName={source?.name} previewError={previewError || undefined}
        videoSrc={videoSrc} videoKey={`${session?.id}:${mediaRevision}`} videoRef={video} videoProps={videoProps} empty={empty}
        focused={focusVideo && mode === 'review'}>
        {controls}
      </MediaStage>
    </div>
    {!(focusVideo && mode === 'review') && <div className="cr-transcript-column">
      <TranscriptPane mode={mode} transcript={shownTranscript} timeMs={recording ? (status.takeOffsetMs ?? 0) + (status.elapsedMs || 0) : time} onSeek={seek}
        status={recording ? 'recording' : processing ? 'processing' : undefined} liveTake={liveTake(status)}
        liveError={recording ? status.liveTranscript?.error : undefined} emptyMessage={emptyMessage}
        error={transcriptError} onRetry={() => void retry()} retryDisabled={busy}/>
    </div>}
  </main>;

  const sidebarElement = sidebarVisible && <Sidebar platform={os} showCollapse={os === 'macos'} filter={search} utilities={null}
    sections={projects} sessions={sessions} activeId={draft ? undefined : session?.id} locked={locked} loading={loading}
    onCollapse={sidebar.hide} onNew={prepare} onOpen={id => void openSession(id)}
    onRename={item => setDialog({ kind: 'renameRecording', id: item.id, value: item.name })}
    onRenameSection={item => setDialog({ kind: 'renameSection', id: item.id, value: item.name })}
    onCreateSection={sessionId => setDialog({ kind: 'section', sessionId, value: '' })}
    onMove={moveSession} onReorder={reorderSections} onDeleteSection={item => void deleteSection(item)}
    onDeleteSession={item => { deletionFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setError(''); setDeletion({ id: item.id, name: item.name }); }}/>;
  const titleBar = <TitleBar platform={os} sidebarVisible={sidebarVisible} onToggleSidebar={sidebar.toggle}
    search={search} onSearch={changeSearch} searchRef={searchRef} onOpenSettings={openSettings}/>;

  return <div className="app" data-platform={os} data-sidebar={compact ? undefined : sidebarOverlay ? 'overlay' : sidebarVisible ? 'docked' : 'hidden'} data-compact={compact || undefined}>
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

    <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} fallbackFocusRef={sheet} theme={theme} onTheme={setTheme}
      setup={setup} installing={installing} onInstall={() => void install()} onCheckAgain={() => void backend.setup().then(setSetup).catch(report)}
      settings={settings} onSaveSettings={saveSettings} error={settingsOpen ? error : undefined}/>
    <NameDialog state={dialog} busy={busy} error={dialog ? error : ''} fallbackFocusRef={sheet}
      onChange={value => setDialog(current => current && { ...current, value })} onClose={() => setDialog(null)} onSubmit={event => void submitDialog(event)}/>
    <DeleteRecordingDialog target={deletion} busy={busy} error={deletion ? error : ''} restoreFocusRef={deletionFocus} fallbackFocusRef={sheet}
      onClose={() => setDeletion(null)} onDelete={() => void deleteRecording()}/>
    {notice && <div className="app-toast" role="status">{notice}</div>}
  </div>;
}
