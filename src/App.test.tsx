import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { AppProps } from './App';
import type { Project, RecordingStatus, Session, SetupStatus, Transcript } from './backend';
import { NAMES, RETIRED_NAMES } from './workspace/types';

const mocks = vi.hoisted(() => ({
  backend: {
    projects: vi.fn(), sessions: vi.fn(), session: vi.fn(), transcript: vi.fn(), markers: vi.fn(), addMarker: vi.fn(), setup: vi.fn(), status: vi.fn(),
    sources: vi.fn(), microphones: vi.fn(), preview: vi.fn(), stopPreview: vi.fn(), createProject: vi.fn(), renameProject: vi.fn(), renameSession: vi.fn(),
    moveSession: vi.fn(), reorderProjects: vi.fn(), deleteProject: vi.fn(), deleteSession: vi.fn(), start: vi.fn(), stop: vi.fn(), recordMore: vi.fn(),
    handoff: vi.fn(), openFolder: vi.fn(), mute: vi.fn(), retry: vi.fn(), installTranscription: vi.fn(), settings: vi.fn(), saveSettings: vi.fn(),
  },
  windowApi: {
    minimize: vi.fn(), toggleMaximize: vi.fn(), isMaximized: vi.fn(), onResized: vi.fn(), close: vi.fn(), startDragging: vi.fn(),
    setSize: vi.fn(), setMinSize: vi.fn(), setAlwaysOnTop: vi.fn(), innerSize: vi.fn(), scaleFactor: vi.fn(), setTheme: vi.fn(),
  },
}));
vi.mock('./backend', () => ({ backend: mocks.backend, videoUrl: (path: string) => `asset://${path}` }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('./chrome/windowApi', async importOriginal => ({ ...await importOriginal<typeof import('./chrome/windowApi')>(), windowApi: mocks.windowApi }));

let projects: Project[];
let sessions: Session[];
let status: RecordingStatus;
let setup: SetupStatus;
let transcript: Transcript;
const backend = mocks.backend;
const windowApi = mocks.windowApi;
const timestamp = '2026-10-27T10:42:00Z';
const newSession = (id = 's1'): Session => ({ id, projectId: 'p1', name: 'Review Alpha', createdAt: timestamp, durationMs: 10000, status: 'ready', videoPath: 'C:/recordings/video.mp4', sourceId: 'display1', microphoneId: 'mic1' });
const readySetup: SetupStatus = { ready: true, issues: [], modelReady: true, dependencies: ['ffmpeg', 'ffprobe', 'whisper-cli', 'whisper-vad-speech-segments', 'adb', 'scrcpy'].map(name => ({ name, available: true })) };

beforeEach(() => {
  vi.clearAllMocks();
  window.innerWidth = 1280;
  projects = [{ id: 'p1', name: 'Project Alpha', createdAt: timestamp }]; sessions = [newSession()]; status = { state: 'idle' }; setup = { ...readySetup };
  transcript = { segments: [{ id: 'line1', text: 'Look here', startMs: 1000, endMs: 4000, words: [{ text: 'Look', startMs: 1000, endMs: 1800 }, { text: 'here', startMs: 2500, endMs: 3500 }] }] };
  backend.projects.mockImplementation(async () => projects.map(item => ({ ...item })));
  backend.sessions.mockImplementation(async (projectId?: string | null) => sessions.filter(item => !projectId || item.projectId === projectId).map(item => ({ ...item })));
  backend.session.mockImplementation(async (id: string) => structuredClone(sessions.find(item => item.id === id)!));
  backend.status.mockImplementation(async () => ({ ...status }));
  backend.setup.mockImplementation(async () => ({ ...setup }));
  backend.sources.mockResolvedValue([{ id: 'display1', name: 'Display 1', kind: 'display', available: true }, { id: 'quest1', name: 'Quest USB', kind: 'quest', available: true }]);
  backend.microphones.mockResolvedValue([{ id: 'mic1', name: 'Studio microphone' }, { id: 'mic2', name: 'Headset microphone' }]);
  backend.preview.mockImplementation(async (_source: string, id: string) => ({ id, url: 'http://127.0.0.1:9999/live' }));
  backend.stopPreview.mockResolvedValue(undefined);
  backend.transcript.mockImplementation(async () => structuredClone(transcript));
  backend.markers.mockResolvedValue([{ id: 'm1', timeMs: 1000, label: 'Legacy marker' }]);
  backend.createProject.mockImplementation(async (name: string) => { const project = { id: 'p2', name, createdAt: timestamp }; projects.push(project); return project; });
  backend.renameProject.mockImplementation(async (id: string, name: string) => { projects = projects.map(item => item.id === id ? { ...item, name } : item); });
  backend.renameSession.mockImplementation(async (id: string, name: string) => { sessions = sessions.map(item => item.id === id ? { ...item, name } : item); });
  backend.moveSession.mockImplementation(async (id: string, projectId: string | null) => { sessions = sessions.map(item => item.id === id ? { ...item, projectId } : item); return sessions.find(item => item.id === id)!; });
  backend.reorderProjects.mockImplementation(async (ids: string[]) => { projects = ids.map(id => projects.find(item => item.id === id)!); });
  backend.deleteProject.mockImplementation(async (id: string) => { projects = projects.filter(item => item.id !== id); sessions = sessions.map(item => item.projectId === id ? { ...item, projectId: null } : item); });
  backend.deleteSession.mockImplementation(async (id: string) => { sessions = sessions.filter(item => item.id !== id); });
  backend.start.mockImplementation(async (projectId: string | null) => { const session = { ...newSession('s2'), projectId, name: 'New recording', autoTitle: true, status: 'recording' as const }; sessions.push(session); status = { state: 'recording', sessionId: 's2', elapsedMs: 3000, audioLevel: .4 }; return session; });
  backend.stop.mockImplementation(async () => { const next = { ...sessions.find(item => item.id === 's2')!, status: 'processing' as const }; sessions = sessions.map(item => item.id === next.id ? next : item); status = { state: 'processing', sessionId: next.id }; return next; });
  backend.recordMore.mockRejectedValue('Record more is not set up in this test.');
  backend.handoff.mockResolvedValue('Review local session s1. Transcript and frame instructions.');
  backend.openFolder.mockResolvedValue(undefined); backend.mute.mockResolvedValue(undefined); backend.retry.mockResolvedValue(undefined); backend.installTranscription.mockResolvedValue(undefined);
  backend.settings.mockResolvedValue({});
  backend.saveSettings.mockImplementation(async (next: object) => ({ ...next }));
  for (const name of ['minimize', 'toggleMaximize', 'close', 'startDragging', 'setSize', 'setMinSize', 'setAlwaysOnTop', 'setTheme'] as const) windowApi[name].mockResolvedValue(undefined);
  windowApi.isMaximized.mockResolvedValue(false);
  windowApi.onResized.mockResolvedValue(() => {});
  windowApi.innerSize.mockResolvedValue({ width: 1280, height: 820 });
  windowApi.scaleFactor.mockResolvedValue(1);
});

type TestUser = ReturnType<typeof userEvent.setup>;
async function ready(props: AppProps = { platform: 'windows' }) {
  const user = userEvent.setup(); render(<App {...props}/>);
  await waitFor(() => expect(screen.getByRole('button', { name: NAMES.record })).toBeEnabled());
  return user;
}
const sidebar = () => within(screen.getByRole('complementary', { name: NAMES.recordings }));
const transcriptPane = () => within(screen.getByRole('region', { name: NAMES.transcript }));
async function open(user: TestUser, name: string | RegExp = /Review Alpha/) {
  await user.click(sidebar().getByRole('button', { name }));
}
async function review(props?: AppProps) {
  const user = await ready(props);
  await open(user);
  await screen.findByRole('button', { name: 'Seek to here at 0:02' });
  return user;
}
async function poll() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 760)); }); }
async function chooseMicrophone(user: TestUser, id: string) {
  const name = id === 'mic2' ? 'Headset microphone' : id === 'mic1' ? 'Studio microphone' : NAMES.noMicrophone;
  await user.click(within(screen.getByRole('group', { name: NAMES.microphoneOptions })).getByRole('button', { name }));
}
async function chooseSource(user: TestUser, name: string) {
  await user.click(within(screen.getByRole('group', { name: NAMES.captureSources })).getByRole('button', { name }));
}
/** A session whose take 2 is recording, as record_more returns it. */
function takeTwo(session: Session, takeStatus: 'recording' | 'swapping' | 'ready' = 'recording'): Session {
  return { ...session, status: takeStatus === 'ready' ? 'ready' : takeStatus === 'recording' ? 'recording' : 'processing', takes: [
    { index: 1, offsetMs: 0, durationMs: 10000, status: 'ready', folder: '.', systemAudio: false, microphoneId: 'mic1' },
    { index: 2, offsetMs: 10000, durationMs: takeStatus === 'recording' ? 0 : 10000, status: takeStatus, folder: 'takes/2', systemAudio: false, microphoneId: 'mic1' },
  ], durationMs: takeStatus === 'ready' ? 20000 : 10000 };
}

describe('keyboard interaction', () => {
  it('pauses an exclusive camera preview during startup and recording, then restores it after a failed start', async () => {
    backend.sources.mockResolvedValue([{ id: 'v4l2:/dev/video0', name: 'USB camera', kind: 'camera', available: true }]);
    let rejectStart!: (error: Error) => void;
    backend.start.mockImplementationOnce(() => new Promise((_, reject) => { rejectStart = reject; }));
    const user = await ready(); await screen.findByRole('img', { name: 'Live preview of USB camera' });
    const id = backend.preview.mock.calls[0][1];
    await user.click(screen.getByRole('button', { name: NAMES.record }));
    await screen.findByRole('heading', { name: 'Camera preview paused' });
    await waitFor(() => expect(backend.stopPreview).toHaveBeenCalledWith(id));
    expect(backend.preview).toHaveBeenCalledTimes(1);
    await act(async () => rejectStart(new Error('Camera failed to start')));
    await screen.findByRole('img', { name: 'Live preview of USB camera' });
    expect(backend.preview).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: NAMES.record }));
    await screen.findByRole('button', { name: NAMES.stop });
    expect(screen.getByRole('heading', { name: 'Camera preview paused' })).toBeInTheDocument();
    expect(backend.preview).toHaveBeenCalledTimes(2);
  });
  it('keeps one continuous preview through recording startup and stops it for review', async () => {
    const user = await ready(); await screen.findByRole('img', { name: 'Live preview of Display 1' });
    const id = backend.preview.mock.calls[0][1];
    await user.click(screen.getByRole('button', { name: NAMES.record })); await screen.findByRole('button', { name: NAMES.stop });
    expect(screen.getByRole('img', { name: 'Live preview of Display 1' })).toBeVisible();
    expect(screen.getByText('Live · Display 1')).toBeVisible();
    expect(backend.preview).toHaveBeenCalledTimes(1); expect(backend.stopPreview).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: NAMES.stop }));
    await waitFor(() => expect(backend.stopPreview).toHaveBeenCalledWith(id));
  });
  it('reconnects a failed stream when the current source is selected again', async () => {
    const user = await ready(); await screen.findByRole('img', { name: 'Live preview of Display 1' });
    act(() => backend.preview.mock.calls[0][2]('Preview disconnected'));
    await screen.findByText('Preview disconnected');
    await user.click(screen.getByRole('button', { name: 'Display 1' })); await chooseSource(user, 'Display 1');
    expect(await screen.findByRole('img', { name: 'Live preview of Display 1' })).toBeVisible();
    expect(backend.preview).toHaveBeenCalledTimes(2);
  });
  it('opens device choices directly, focuses the selected option, and restores focus on Escape', async () => {
    const user = await ready();
    const mic = screen.getByRole('button', { name: 'Studio microphone' });
    await user.click(mic);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: NAMES.microphoneOptions })).getByRole('button', { name: 'Studio microphone' })).toHaveFocus();
    await user.keyboard('{Escape}'); expect(mic).toHaveFocus();
    expect(screen.queryByRole('group', { name: NAMES.microphoneOptions })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Display 1' }));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await chooseSource(user, 'Quest USB');
    expect(screen.queryByRole('group', { name: NAMES.captureSources })).not.toBeInTheDocument();
    await user.click(mic); await chooseMicrophone(user, '');
    expect(screen.queryByRole('group', { name: NAMES.microphoneOptions })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: NAMES.record })); await screen.findByRole('button', { name: NAMES.stop });
    expect(backend.start).toHaveBeenCalledWith(null, null, 'quest1', null, false, false);
  });
  it('lets Space activate a focused button without also toggling playback', async () => {
    const user = await ready();
    screen.getByRole('button', { name: NAMES.record }).focus();
    await user.keyboard(' ');
    expect(await screen.findByRole('button', { name: NAMES.stop })).toBeEnabled();
    expect(backend.start).toHaveBeenCalledTimes(1);
  });
  it('scopes recording shortcuts outside naming and settings dialogs while allowing Escape', async () => {
    const user = await ready();
    await user.click(screen.getByRole('button', { name: NAMES.newSection }));
    screen.getByRole('button', { name: NAMES.cancel }).focus();
    await user.keyboard('{Control>}r{/Control}{Control>}n{/Control}');
    expect(backend.start).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: NAMES.newSection })).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: NAMES.settings }));
    screen.getByRole('button', { name: NAMES.closeSettings }).focus();
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.start).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: NAMES.settingsDialog })).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.keyboard('{Control>}r{/Control}');
    expect(await screen.findByRole('button', { name: NAMES.stop })).toBeEnabled();
    expect(backend.start).toHaveBeenCalledTimes(1);
  });
  it('records and stops a draft with Ctrl+R', async () => {
    const user = await ready();
    await user.keyboard('{Control>}r{/Control}');
    expect(await screen.findByRole('button', { name: NAMES.stop })).toBeEnabled();
    expect(backend.start).toHaveBeenCalledWith(null, null, 'display1', 'mic1', false, false);
    await user.keyboard('{Control>}r{/Control}');
    await transcriptPane().findByText('Processing');
    expect(backend.stop).toHaveBeenCalledOnce();
    // Processing: Ctrl+R neither records more nor starts another recording.
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.recordMore).not.toHaveBeenCalled(); expect(backend.start).toHaveBeenCalledOnce();
  });
  it('means Record more in review and Stop while that take records', async () => {
    backend.recordMore.mockImplementation(async (id: string) => { sessions = sessions.map(item => item.id === id ? takeTwo(item) : item); status = { state: 'recording', sessionId: id, elapsedMs: 0, takeIndex: 2, takeOffsetMs: 10000 }; return takeTwo(newSession(id)); });
    backend.stop.mockImplementation(async () => { const next = takeTwo(newSession(), 'swapping'); sessions = [next]; status = { state: 'processing', sessionId: 's1', takeIndex: 2, takeOffsetMs: 10000 }; return next; });
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const user = await review();
    await user.keyboard('{Control>}r{/Control}');
    expect(await screen.findByRole('timer', { name: NAMES.takeTimer(2) })).toBeVisible();
    expect(backend.recordMore).toHaveBeenCalledWith('s1', 'mic1', false, false);
    await user.keyboard('{Control>}r{/Control}');
    await transcriptPane().findByText('Processing');
    expect(backend.stop).toHaveBeenCalledOnce(); expect(backend.start).not.toHaveBeenCalled();
  });
  it('starts a new recording with Ctrl+N, except while recording', async () => {
    const user = await review();
    await user.keyboard('{Control>}n{/Control}');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(NAMES.newRecording);
    expect(document.querySelector('video')).toBeNull();
    await user.click(screen.getByRole('button', { name: NAMES.record })); await screen.findByRole('button', { name: NAMES.stop });
    await user.keyboard('{Control>}n{/Control}');
    expect(screen.getByRole('button', { name: NAMES.stop })).toBeEnabled();
    expect(screen.getByRole('timer', { name: NAMES.takeTimer(1) })).toBeVisible();
  });
  it('uses ⌘ on macOS, where Ctrl does nothing', async () => {
    const user = await ready({ platform: 'macos' });
    expect(screen.getByRole('button', { name: NAMES.newRecording })).toHaveAttribute('aria-keyshortcuts', 'Meta+N');
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.start).not.toHaveBeenCalled();
    await user.keyboard('{Meta>}r{/Meta}');
    expect(await screen.findByRole('button', { name: NAMES.stop })).toBeEnabled();
    expect(backend.start).toHaveBeenCalledOnce();
  });
  it('ignores shortcuts in editable fields and open pickers, and never turns a modifier combination into a bare key', async () => {
    const user = await ready();
    screen.getByRole('searchbox', { name: NAMES.searchRecordings }).focus();
    await user.keyboard('{Control>}r{/Control}{Control>}n{/Control}');
    await user.click(screen.getByRole('button', { name: 'Display 1' }));
    expect(screen.getByRole('group', { name: NAMES.captureSources })).toBeVisible();
    fireEvent.keyDown(window, { key: 'r', ctrlKey: true });
    await user.keyboard('{Escape}');
    await user.keyboard('{Control>}{Shift>}r{/Shift}{/Control}{Alt>}r{/Alt}');
    expect(backend.start).not.toHaveBeenCalled();
    await open(user); await screen.findByRole('button', { name: 'Seek to here at 0:02' });
    const media = document.querySelector('video')!;
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('{Control>} {/Control}{Control>}{ArrowRight}{/Control}{Alt>}{ArrowRight}{/Alt}');
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(media.currentTime).toBe(0);
  });
  it('plays with Space and seeks five seconds with the arrow keys in review', async () => {
    await review();
    const media = document.querySelector('video')!;
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(media.currentTime).toBe(5);
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(media.currentTime).toBe(0);
  });
  it('focuses search with Ctrl+K, filters the sidebar by name and clears it with Escape', async () => {
    sessions = [newSession(), { ...newSession('s2'), projectId: null, name: 'Quest navigation' }];
    const user = await ready();
    const field = screen.getByRole('searchbox', { name: NAMES.searchRecordings });
    await user.keyboard('{Control>}k{/Control}');
    expect(field).toHaveFocus();
    await user.type(field, 'quest');
    expect(sidebar().queryByRole('button', { name: 'Review Alpha' })).not.toBeInTheDocument();
    expect(sidebar().getByRole('button', { name: 'Quest navigation' })).toBeVisible();
    await user.type(field, 'zebra');
    expect(sidebar().getByText(NAMES.noMatches)).toBeVisible();
    await user.keyboard('{Escape}');
    expect(field).toHaveValue('');
    expect(sidebar().getByRole('button', { name: 'Review Alpha' })).toBeVisible();
    expect(backend.start).not.toHaveBeenCalled();
  });
});

describe('project and session workflows', () => {
  it('lets a first-time user record immediately without a project or a name', async () => {
    projects = []; sessions = [];
    const user = await ready();
    expect(await screen.findByRole('img', { name: 'Live preview of Display 1' })).toBeVisible();
    expect(screen.queryByRole('textbox', { name: NAMES.nameField })).not.toBeInTheDocument();
    expect(screen.queryByText('Ready when you are')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: NAMES.copyForAgent })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: NAMES.record }));
    await screen.findByRole('button', { name: NAMES.stop });
    expect(backend.start).toHaveBeenCalledWith(null, null, 'display1', 'mic1', false, false);
  });
  it('shows sections and newest-first ungrouped Recents together without duplicate rows or tabs', async () => {
    sessions = [newSession(), { ...newSession('s2'), projectId: null, name: 'Older recent' }, { ...newSession('s3'), projectId: null, name: 'Newest recent', createdAt: '2026-10-28T10:00:00Z' }];
    await ready();
    expect(within(screen.getByRole('region', { name: NAMES.section('Project Alpha') })).getByRole('button', { name: 'Review Alpha' })).toBeVisible();
    const recents = within(screen.getByRole('region', { name: NAMES.recents }));
    expect(recents.queryByRole('button', { name: 'Review Alpha' })).not.toBeInTheDocument();
    expect(recents.getAllByRole('button', { name: /recent$/ }).map(item => item.textContent)).toEqual(['Newest recent', 'Older recent']);
    expect(screen.queryByRole('button', { name: 'Projects' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
  it('moves an existing recording through its menu without changing playback or transcript', async () => {
    sessions = [{ ...newSession(), projectId: null }];
    const user = await review();
    await user.click(screen.getByRole('button', { name: 'Seek to here at 0:02' }));
    const media = document.querySelector('video');
    await user.click(screen.getByRole('button', { name: NAMES.recordingOptions }));
    await user.click(screen.getByRole('menuitem', { name: NAMES.moveToSection }));
    await user.click(screen.getByRole('menuitem', { name: 'Project Alpha' }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: NAMES.section('Project Alpha') })).getByRole('button', { name: 'Review Alpha' })).toBeEnabled());
    expect(backend.moveSession).toHaveBeenLastCalledWith('s1', 'p1');
    expect(document.querySelector('video')).toBe(media); expect(media?.currentTime).toBe(2.5);
    await user.click(screen.getByRole('button', { name: NAMES.recordingOptions }));
    await user.click(screen.getByRole('menuitem', { name: NAMES.moveToSection }));
    await user.click(screen.getByRole('menuitem', { name: NAMES.recents }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: NAMES.recents })).getByRole('button', { name: 'Review Alpha' })).toBeEnabled());
    expect(backend.moveSession).toHaveBeenLastCalledWith('s1', null);
    expect(screen.getByRole('button', { name: 'Seek to here at 0:02' })).toBeVisible();
  });
  it('drags into a collapsed section and back to Recents while keeping the current recording open', async () => {
    sessions = [newSession(), { ...newSession('s2'), projectId: null, name: 'Another recording' }];
    const user = await review();
    await user.click(screen.getByRole('button', { name: 'Project Alpha' }));
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(screen.getByRole('button', { name: 'Another recording' }), { dataTransfer });
    const section = screen.getByRole('region', { name: NAMES.section('Project Alpha') });
    fireEvent.dragOver(section, { dataTransfer }); expect(section).toHaveClass('drop-target');
    fireEvent.drop(section, { dataTransfer });
    await waitFor(() => expect(within(section).getByRole('button', { name: 'Another recording' })).toBeEnabled());
    expect(backend.moveSession).toHaveBeenLastCalledWith('s2', 'p1');
    expect(screen.getByRole('button', { name: 'Project Alpha' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Review Alpha');
    fireEvent.dragStart(screen.getByRole('button', { name: 'Another recording' }), { dataTransfer });
    fireEvent.drop(screen.getByRole('region', { name: NAMES.recents }), { dataTransfer });
    await waitFor(() => expect(within(screen.getByRole('region', { name: NAMES.recents })).getByRole('button', { name: 'Another recording' })).toBeEnabled());
    expect(backend.moveSession).toHaveBeenLastCalledWith('s2', null);
  });
  it('preserves the source section when moving fails and ignores external drags', async () => {
    const user = await review();
    const recents = screen.getByRole('region', { name: NAMES.recents });
    fireEvent.drop(recents, { dataTransfer: { getData: () => 's1' } });
    expect(backend.moveSession).not.toHaveBeenCalled();
    backend.moveSession.mockRejectedValueOnce('Unable to update recording.');
    await user.click(screen.getByRole('button', { name: NAMES.recordingOptions }));
    await user.click(screen.getByRole('menuitem', { name: NAMES.moveToSection }));
    await user.click(screen.getByRole('menuitem', { name: NAMES.recents }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to update recording');
    expect(within(screen.getByRole('region', { name: NAMES.section('Project Alpha') })).getByRole('button', { name: 'Review Alpha' })).toBeVisible();
  });
  it('supports right-click and keyboard move menus without invoking recording shortcuts', async () => {
    const user = await review();
    const row = sidebar().getByRole('button', { name: 'Review Alpha' });
    fireEvent.contextMenu(row);
    expect(screen.getByRole('menuitem', { name: NAMES.moveToSection })).toHaveFocus();
    await user.keyboard('{Control>}r{/Control}'); expect(backend.start).not.toHaveBeenCalled(); expect(backend.recordMore).not.toHaveBeenCalled();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('menuitem', { name: NAMES.recents })).toHaveFocus();
    await user.keyboard('{Escape}'); expect(row).toHaveFocus();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it('creates a section directly from a recording menu and moves only that recording', async () => {
    const user = await review();
    await user.click(screen.getByRole('button', { name: NAMES.recordingOptions }));
    await user.click(screen.getByRole('menuitem', { name: NAMES.moveToSection }));
    await user.click(screen.getByRole('menuitem', { name: NAMES.newSection }));
    await user.type(screen.getByLabelText(NAMES.nameField), 'New category'); await user.click(screen.getByRole('button', { name: NAMES.save }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: NAMES.section('New category') })).getByRole('button', { name: 'Review Alpha' })).toBeEnabled());
    expect(backend.moveSession).toHaveBeenCalledWith('s1', 'p2');
  });
  it('remembers collapsed sections and keeps orphaned recordings reachable', async () => {
    localStorage.setItem('cuereview.closedSections', '["p1"]');
    sessions.push({ ...newSession('s2'), projectId: 'missing', name: 'Orphaned recording' });
    const user = await ready();
    expect(screen.getByRole('button', { name: 'Project Alpha' })).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar().queryByRole('button', { name: 'Review Alpha' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: NAMES.recents })).getByRole('button', { name: 'Orphaned recording' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Project Alpha' }));
    expect(JSON.parse(localStorage.getItem('cuereview.closedSections')!)).toEqual([]);
  });
  it('prevents moving recordings that are still processing', async () => {
    sessions = [{ ...newSession(), status: 'processing' }]; await ready();
    expect(screen.getByRole('button', { name: NAMES.recordingOptions })).toBeDisabled();
    const row = sidebar().getByRole('button', { name: /Review Alpha/ });
    expect(row).toHaveAttribute('draggable', 'false');
    fireEvent.contextMenu(row); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it('hides and shows the sidebar from the title bar, with no theme toggle outside Settings', async () => {
    const user = await ready();
    expect(screen.queryByRole('button', { name: NAMES.collapseSidebar })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: NAMES.hideSidebar }));
    expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    expect(sidebar().getByRole('button', { name: 'Review Alpha' })).toBeVisible();
    expect(screen.queryByRole('button', { name: RETIRED_NAMES.useDarkTheme })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RETIRED_NAMES.useLightTheme })).not.toBeInTheDocument();
  });
  it('sets the theme in Settings → Appearance and keeps it for the next launch', async () => {
    const user = await ready();
    expect(windowApi.setTheme).toHaveBeenLastCalledWith('light');
    await user.click(screen.getByRole('button', { name: NAMES.settings }));
    await user.selectOptions(screen.getByLabelText(NAMES.appearance), 'dark');
    await waitFor(() => expect(windowApi.setTheme).toHaveBeenLastCalledWith('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('cuereview.theme')).toBe('dark');
    cleanup(); windowApi.setTheme.mockClear(); delete document.documentElement.dataset.theme;
    render(<App platform="windows"/>);
    await waitFor(() => expect(windowApi.setTheme).toHaveBeenCalledWith('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(windowApi.setTheme).not.toHaveBeenCalledWith('light');
  });
  it('creates and renames a section without changing the fresh recording category', async () => {
    const user = await ready();
    await user.click(screen.getByRole('button', { name: NAMES.newSection }));
    await user.type(screen.getByLabelText(NAMES.nameField), 'Beta product'); await user.click(screen.getByRole('button', { name: NAMES.save }));
    await screen.findByRole('button', { name: 'Beta product' });
    expect(backend.createProject).toHaveBeenCalledWith('Beta product');
    await user.click(screen.getByRole('button', { name: NAMES.sectionOptions('Beta product') })); await user.click(screen.getByRole('menuitem', { name: NAMES.rename }));
    await user.clear(screen.getByLabelText(NAMES.nameField)); await user.type(screen.getByLabelText(NAMES.nameField), 'Beta review'); await user.click(screen.getByRole('button', { name: NAMES.save }));
    await screen.findByRole('button', { name: NAMES.sectionOptions('Beta review') });
    expect(backend.renameProject).toHaveBeenCalledWith('p2', 'Beta review');
    await user.click(screen.getByRole('button', { name: NAMES.record })); await screen.findByRole('button', { name: NAMES.stop });
    expect(backend.start).toHaveBeenCalledWith(null, null, 'display1', 'mic1', false, false);
  });
  it('loads and renames an existing session without losing its transcript', async () => {
    const user = await review();
    await user.click(within(screen.getByRole('heading', { level: 1 })).getByRole('button', { name: 'Review Alpha' }));
    await user.clear(screen.getByLabelText(NAMES.nameField)); await user.type(screen.getByLabelText(NAMES.nameField), 'Playback regression'); await user.click(screen.getByRole('button', { name: NAMES.save }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Playback regression'));
    expect(backend.renameSession).toHaveBeenCalledWith('s1', 'Playback regression');
    expect(screen.getByRole('button', { name: 'Seek to here at 0:02' })).toBeVisible();
  });
  it('refreshes the sidebar and the open title when the window regains focus, picking up a CLI rename', async () => {
    await review();
    sessions = sessions.map(item => ({ ...item, name: 'Renamed from the CLI' }));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(await sidebar().findByRole('button', { name: 'Renamed from the CLI' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Renamed from the CLI');
    expect(screen.getByRole('button', { name: 'Seek to here at 0:02' })).toBeVisible();
  });
});

describe('layout', () => {
  it('auto-hides the sidebar below 1000px and shows it over the sheet until a recording opens', async () => {
    window.innerWidth = 900;
    const user = await ready();
    expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    expect(document.querySelector('.app')).toHaveAttribute('data-sidebar', 'overlay');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    await open(user);
    await screen.findByRole('button', { name: 'Seek to here at 0:02' });
    expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument();
    await act(async () => { window.innerWidth = 1280; window.dispatchEvent(new Event('resize')); });
    expect(document.querySelector('.app')).toHaveAttribute('data-sidebar', 'docked');
    expect(sidebar().getByRole('button', { name: 'Review Alpha' })).toBeVisible();
  });
  it('shows the sidebar when a search starts while it is hidden', async () => {
    window.innerWidth = 900;
    const user = await ready();
    await user.type(screen.getByRole('searchbox', { name: NAMES.searchRecordings }), 'alpha');
    expect(sidebar().getByRole('button', { name: 'Review Alpha' })).toBeVisible();
  });
  it('puts the collapse control in the sidebar panel only on macOS, beside the toolbar', async () => {
    const user = await ready({ platform: 'macos' });
    expect(screen.getByRole('banner', { name: NAMES.toolbar })).toBeVisible();
    expect(screen.queryByRole('button', { name: NAMES.minimizeWindow })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: NAMES.collapseSidebar }));
    expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    expect(sidebar().getByRole('button', { name: 'Review Alpha' })).toBeVisible();
  });
  it('keeps native window controls on Linux', async () => {
    await ready({ platform: 'linux' });
    expect(screen.getByRole('banner', { name: NAMES.toolbar })).toBeVisible();
    expect(screen.queryByRole('button', { name: NAMES.closeWindow })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: NAMES.collapseSidebar })).not.toBeInTheDocument();
  });
  it('calls the window API from the Windows title bar controls', async () => {
    const user = await ready();
    expect(screen.getByRole('banner', { name: NAMES.titleBar })).toBeVisible();
    await user.click(screen.getByRole('button', { name: NAMES.minimizeWindow })); expect(windowApi.minimize).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: NAMES.maximizeWindow })); expect(windowApi.toggleMaximize).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: NAMES.closeWindow })); expect(windowApi.close).toHaveBeenCalledOnce();
  });
});

describe('section ordering and deletion', () => {
  it('persists section dragging separately from recording moves and preserves playback', async () => {
    projects.push({ id: 'p2', name: 'Second section', createdAt: timestamp });
    const user = await review(); await user.click(screen.getByRole('button', { name: 'Seek to here at 0:02' }));
    const media = document.querySelector('video');
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(screen.getByRole('button', { name: 'Second section' }), { dataTransfer });
    const target = screen.getByRole('region', { name: NAMES.section('Project Alpha') });
    fireEvent.dragOver(target, { dataTransfer, clientY: -1 }); expect(target).toHaveClass('insert-before');
    fireEvent.drop(target, { dataTransfer, clientY: -1 });
    await waitFor(() => expect(backend.reorderProjects).toHaveBeenCalledWith(['p2', 'p1']));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Second section' })).toBeEnabled());
    expect([...document.querySelectorAll('[data-section-id]')].map(item => item.getAttribute('data-section-id'))).toEqual(['p2', 'p1']);
    expect(backend.moveSession).not.toHaveBeenCalled();
    expect(document.querySelector('video')).toBe(media); expect(media?.currentTime).toBe(2.5);
    fireEvent.dragStart(screen.getByRole('button', { name: 'Second section' }), { dataTransfer });
    fireEvent.drop(screen.getByRole('region', { name: NAMES.recents }), { dataTransfer });
    await waitFor(() => expect(backend.reorderProjects).toHaveBeenLastCalledWith(['p1', 'p2']));
  });
  it('offers keyboard section ordering and keeps the current order if saving fails', async () => {
    projects.push({ id: 'p2', name: 'Second section', createdAt: timestamp });
    const user = await ready();
    await user.click(screen.getByRole('button', { name: NAMES.sectionOptions('Project Alpha') }));
    expect(screen.getByRole('menuitem', { name: NAMES.moveUp })).toBeDisabled();
    backend.reorderProjects.mockRejectedValueOnce('Cannot save section order.');
    await user.click(screen.getByRole('menuitem', { name: NAMES.moveDown }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot save section order');
    expect([...document.querySelectorAll('[data-section-id]')].map(item => item.getAttribute('data-section-id'))).toEqual(['p1', 'p2']);
    await user.click(screen.getByRole('button', { name: NAMES.sectionOptions('Project Alpha') }));
    await user.click(screen.getByRole('menuitem', { name: NAMES.moveDown }));
    await waitFor(() => expect([...document.querySelectorAll('[data-section-id]')].map(item => item.getAttribute('data-section-id'))).toEqual(['p2', 'p1']));
  });
  it('deletes a section directly, returning every recording to Recents without deleting or resetting playback', async () => {
    sessions.push({ ...newSession('s2'), name: 'Another recording' });
    const user = await review(); await user.click(screen.getByRole('button', { name: 'Seek to here at 0:02' }));
    const media = document.querySelector('video');
    await user.click(screen.getByRole('button', { name: NAMES.sectionOptions('Project Alpha') }));
    await user.click(screen.getByRole('menuitem', { name: NAMES.deleteSectionItem }));
    await waitFor(() => expect(screen.queryByRole('region', { name: NAMES.section('Project Alpha') })).not.toBeInTheDocument());
    const recents = within(screen.getByRole('region', { name: NAMES.recents }));
    expect(recents.getByRole('button', { name: 'Review Alpha' })).toBeVisible(); expect(recents.getByRole('button', { name: 'Another recording' })).toBeVisible();
    expect(backend.deleteProject).toHaveBeenCalledWith('p1'); expect(backend.deleteSession).not.toHaveBeenCalled();
    expect(document.querySelector('video')).toBe(media); expect(media?.currentTime).toBe(2.5);
    expect(await screen.findByText('Section deleted. Recordings moved to Recents.')).toBeVisible();
  });
  it('refreshes membership after a partial section-delete failure without losing selected playback', async () => {
    sessions.push({ ...newSession('s2'), name: 'Another recording' });
    const user = await review(); const media = document.querySelector('video');
    backend.deleteProject.mockImplementationOnce(async () => { sessions = sessions.map(item => item.id === 's1' ? { ...item, projectId: null } : item); throw Error('Could not finish moving all recordings.'); });
    await user.click(screen.getByRole('button', { name: NAMES.sectionOptions('Project Alpha') }));
    await user.click(screen.getByRole('menuitem', { name: NAMES.deleteSectionItem }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not finish moving all recordings');
    await waitFor(() => expect(within(screen.getByRole('region', { name: NAMES.recents })).getByRole('button', { name: 'Review Alpha' })).toBeVisible());
    expect(within(screen.getByRole('region', { name: NAMES.section('Project Alpha') })).getByRole('button', { name: 'Another recording' })).toBeVisible();
    expect(document.querySelector('video')).toBe(media);
  });
  it('blocks deleting a section with an in-progress recording while allowing an unrelated section', async () => {
    projects.push({ id: 'p2', name: 'Empty section', createdAt: timestamp }); sessions = [{ ...newSession(), status: 'processing' }];
    const user = await ready(); await user.click(screen.getByRole('button', { name: NAMES.sectionOptions('Project Alpha') }));
    expect(screen.getByRole('menuitem', { name: NAMES.deleteSectionItem })).toBeDisabled();
    await user.keyboard('{Escape}'); await user.click(screen.getByRole('button', { name: NAMES.sectionOptions('Empty section') }));
    expect(screen.getByRole('menuitem', { name: NAMES.deleteSectionItem })).toBeEnabled();
  });
  it('names the recording in a permanent-delete confirmation and supports cancelling without touching files', async () => {
    const user = await review(); const media = document.querySelector('video');
    await user.click(screen.getByRole('button', { name: NAMES.recordingOptions })); await user.click(screen.getByRole('menuitem', { name: NAMES.deleteRecordingItem }));
    const confirmation = screen.getByRole('alertdialog', { name: NAMES.deleteRecordingDialog });
    expect(confirmation).toHaveTextContent('Review Alpha'); expect(confirmation).toHaveTextContent('all its files'); expect(confirmation).toHaveTextContent('cannot be undone');
    expect(confirmation).not.toHaveTextContent(/marker/i);
    expect(screen.getByRole('button', { name: NAMES.cancel })).toHaveFocus();
    await user.keyboard('{Control>}r{/Control}'); expect(backend.start).not.toHaveBeenCalled(); expect(backend.recordMore).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: NAMES.cancel }));
    expect(backend.deleteSession).not.toHaveBeenCalled(); expect(document.querySelector('video')).toBe(media);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: NAMES.recordingOptions })).toHaveFocus();
  });
  it('does not delete when Enter follows Escape while the confirmation is fading out', async () => {
    const user = await review();
    await user.click(screen.getByRole('button', { name: NAMES.recordingOptions })); await user.click(screen.getByRole('menuitem', { name: NAMES.deleteRecordingItem }));
    await user.tab(); expect(screen.getByRole('button', { name: NAMES.deleteRecording })).toHaveFocus();
    await user.keyboard('{Escape}{Enter}');
    expect(backend.deleteSession).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(backend.deleteSession).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: NAMES.recordingOptions })).toHaveFocus();
  });
  it('releases the selected media file before deleting and returns to a fresh recording', async () => {
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const user = await review(); const media = document.querySelector('video')!;
    backend.deleteSession.mockImplementationOnce(async (id: string) => { expect(media.hasAttribute('src')).toBe(false); expect(load).toHaveBeenCalled(); sessions = sessions.filter(item => item.id !== id); });
    await user.click(screen.getByRole('button', { name: NAMES.recordingOptions })); await user.click(screen.getByRole('menuitem', { name: NAMES.deleteRecordingItem })); await user.click(screen.getByRole('button', { name: NAMES.deleteRecording }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(NAMES.newRecording));
    expect(backend.deleteSession).toHaveBeenCalledWith('s1'); expect(document.querySelector('[data-session-id="s1"]')).toBeNull(); expect(document.querySelector('video')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('main')).toHaveFocus();
    expect(screen.getByText('Recording deleted')).toBeVisible();
  });
  it('restores the selected video and playback position if deletion fails', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const user = await review(); await user.click(screen.getByRole('button', { name: 'Seek to here at 0:02' })); const media = document.querySelector('video');
    backend.deleteSession.mockRejectedValueOnce('Recording files are still in use.');
    await user.click(screen.getByRole('button', { name: NAMES.recordingOptions })); await user.click(screen.getByRole('menuitem', { name: NAMES.deleteRecordingItem })); await user.click(screen.getByRole('button', { name: NAMES.deleteRecording }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Recording files are still in use');
    await waitFor(() => expect(document.querySelector('video')).not.toBe(media));
    const restored = document.querySelector('video')!; expect(restored).toHaveAttribute('src', 'asset://C:/recordings/video.mp4'); fireEvent.loadedMetadata(restored); expect(restored.currentTime).toBe(2.5);
    await user.click(screen.getByRole('button', { name: NAMES.cancel })); expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Review Alpha');
  });
  it('deletes an inactive recording without unloading the selected recording', async () => {
    sessions.push({ ...newSession('s2'), name: 'Another recording' });
    const user = await review(); const media = document.querySelector('video');
    await user.click(within(document.querySelector('[data-session-id="s2"]') as HTMLElement).getByRole('button', { name: NAMES.recordingOptions }));
    await user.click(screen.getByRole('menuitem', { name: NAMES.deleteRecordingItem })); await user.click(screen.getByRole('button', { name: NAMES.deleteRecording }));
    await waitFor(() => expect(document.querySelector('[data-session-id="s2"]')).toBeNull());
    expect(backend.deleteSession).toHaveBeenCalledWith('s2'); expect(document.querySelector('video')).toBe(media); expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Review Alpha');
  });
  it('preserves the deletion failure detail if a partially removed video cannot reload', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const user = await review(); const media = document.querySelector('video');
    backend.deleteSession.mockRejectedValueOnce('Some files were removed. Delete this recording again to finish.');
    await user.click(screen.getByRole('button', { name: NAMES.recordingOptions })); await user.click(screen.getByRole('menuitem', { name: NAMES.deleteRecordingItem })); await user.click(screen.getByRole('button', { name: NAMES.deleteRecording }));
    await waitFor(() => expect(document.querySelector('video')).not.toBe(media)); fireEvent.error(document.querySelector('video')!);
    expect(screen.getByRole('alert')).toHaveTextContent('Some files were removed');
    expect(screen.getByRole('button', { name: NAMES.deleteRecording })).toBeEnabled();
  });
});

describe('recording and processing', () => {
  it('updates background completion and automatic names in Recents once while another recording is open', async () => {
    const user = await ready();
    await user.click(screen.getByRole('button', { name: NAMES.record })); await screen.findByRole('button', { name: NAMES.stop });
    await user.click(screen.getByRole('button', { name: NAMES.stop })); await transcriptPane().findByText('Processing');
    await open(user);
    await screen.findByRole('button', { name: 'Seek to here at 0:02' });
    sessions = sessions.map(item => item.id === 's2' ? { ...item, name: 'Background transcript title', status: 'ready' } : item); status = { state: 'idle' };
    const before = backend.sessions.mock.calls.length;
    await poll();
    expect(await sidebar().findByRole('button', { name: /Background transcript title/ })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Review Alpha');
    expect(backend.sessions.mock.calls.length).toBe(before + 1);
    await poll(); expect(backend.sessions.mock.calls.length).toBe(before + 1);
  });
  it('preserves no microphone on refresh and describes the resulting video-only recording honestly', async () => {
    const user = await ready();
    await user.click(screen.getByRole('button', { name: 'Studio microphone' }));
    await chooseMicrophone(user, ''); await user.keyboard('{Escape}');
    expect(screen.getByText('No audio input is selected, so this recording will be video only.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Display 1' }));
    await user.click(screen.getByRole('button', { name: NAMES.refreshCaptureDevices }));
    await waitFor(() => expect(backend.microphones).toHaveBeenCalledTimes(2));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: NAMES.noMicrophone })).toBeVisible();
    await user.click(screen.getByRole('button', { name: NAMES.record })); await screen.findByRole('button', { name: NAMES.stop });
    expect(backend.start).toHaveBeenCalledWith(null, null, 'display1', null, false, false);
    expect(screen.getByText('No audio input was selected for this recording.')).toBeVisible();
    expect(screen.queryByRole('button', { name: NAMES.muteMicrophone })).not.toBeInTheDocument();
    expect(screen.queryByRole('meter', { name: NAMES.microphoneLevel })).not.toBeInTheDocument();
    expect(screen.queryByText('Listening… transcript updates in short batches.')).not.toBeInTheDocument();
  });
  it('preserves no microphone when restoring an active video-only recording before device enumeration', async () => {
    sessions = [{ ...newSession(), status: 'recording', microphoneId: undefined }]; status = { state: 'recording', sessionId: 's1', elapsedMs: 3000 };
    render(<App platform="windows"/>);
    await screen.findByRole('button', { name: NAMES.stop });
    await waitFor(() => expect(backend.microphones).toHaveBeenCalledTimes(1));
    expect(screen.getByText('No audio input was selected for this recording.')).toBeVisible();
    expect(screen.queryByRole('button', { name: NAMES.muteMicrophone })).not.toBeInTheDocument();
  });
  it('describes device-only audio as post-recording transcription', async () => {
    const user = await ready();
    await user.click(screen.getByRole('button', { name: 'Display 1' }));
    expect(screen.getByLabelText(NAMES.includeSystemAudio)).toBeVisible();
    await chooseSource(user, 'Quest USB');
    await user.click(screen.getByRole('button', { name: 'Quest USB' }));
    await user.click(screen.getByLabelText(NAMES.includeDeviceAudio)); await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Studio microphone' }));
    await chooseMicrophone(user, ''); await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: NAMES.record })); await screen.findByRole('button', { name: NAMES.stop });
    expect(screen.getByText('Device audio is transcribed after recording.')).toBeVisible();
    expect(backend.start).toHaveBeenCalledWith(null, null, 'quest1', null, true, false);
  });
  it('shows only the drag strip and the dock in compact mode, and clears always-on-top on both restore and stop', async () => {
    const user = await ready(); await user.click(screen.getByRole('button', { name: NAMES.record })); await screen.findByRole('button', { name: NAMES.stop });
    await user.click(screen.getByRole('button', { name: NAMES.compact })); await screen.findByRole('button', { name: NAMES.expand });
    expect(windowApi.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
    expect(windowApi.setSize).toHaveBeenLastCalledWith({ width: 520, height: 320 });
    expect(windowApi.setMinSize).toHaveBeenLastCalledWith({ width: 420, height: 250 });
    expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: NAMES.transcript })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('banner', { name: NAMES.titleBar })).toBeVisible();
    expect(screen.getByRole('button', { name: NAMES.stop })).toBeVisible();
    await user.click(screen.getByRole('button', { name: NAMES.expand })); await screen.findByRole('button', { name: NAMES.compact });
    expect(windowApi.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(windowApi.setSize).toHaveBeenLastCalledWith({ width: 1280, height: 820 });
    expect(windowApi.setMinSize).toHaveBeenLastCalledWith({ width: 640, height: 480 });
    await user.click(screen.getByRole('button', { name: NAMES.compact })); await screen.findByRole('button', { name: NAMES.expand });
    await user.click(screen.getByRole('button', { name: NAMES.stop }));
    await waitFor(() => expect(windowApi.setAlwaysOnTop.mock.calls.map(call => call[0])).toEqual([true, false, true, false]));
    expect(await screen.findByRole('region', { name: NAMES.transcript })).toBeVisible();
  });
  it('explains missing transcription setup while still showing the actual recording state', async () => {
    setup = { ready: false, issues: ['Local speech model is missing'], modelReady: false, dependencies: [] };
    const user = await ready();
    expect(screen.getByRole('button', { name: NAMES.reviewSetup })).toBeVisible();
    await user.click(screen.getByRole('button', { name: NAMES.record }));
    await screen.findByRole('button', { name: NAMES.stop });
    expect(screen.getByText('Transcription needs setup.')).toBeVisible();
    expect(screen.queryByRole('button', { name: NAMES.reviewSetup })).not.toBeInTheDocument();
    expect(screen.queryByText('Listening… transcript updates in short batches.')).not.toBeInTheDocument();
  });
  it('shows progressive transcript batches while preserving active capture when words are clicked', async () => {
    const user = await ready();
    await user.click(screen.getByRole('button', { name: NAMES.record }));
    await screen.findByRole('button', { name: NAMES.stop });
    expect(screen.getByText('Listening… transcript updates in short batches.')).toBeVisible();
    expect(transcriptPane().getByText('Recording')).toBeVisible();
    expect(screen.getByRole('button', { name: NAMES.copyForAgent })).toBeDisabled();
    const liveTranscript: Transcript = { segments: [{ ...transcript.segments[0], startMs: 7000, endMs: 9000, words: [{ text: 'Look', startMs: 7000, endMs: 7500 }, { text: 'here', startMs: 7500, endMs: 8500 }] }] };
    status = { state: 'recording', sessionId: 's2', elapsedMs: 8000, liveTranscript };
    await poll();
    const liveWord = await screen.findByRole('button', { name: 'Seek to here at 0:07' });
    expect(liveWord).toBeDisabled();
    expect(liveWord).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('timer', { name: NAMES.takeTimer(1) })).toHaveTextContent('00:08');
    await user.click(liveWord);
    expect(screen.getByRole('button', { name: NAMES.stop })).toBeEnabled();
    expect(document.querySelector('video')).toBeNull();
    expect(backend.stop).not.toHaveBeenCalled();
    expect(backend.start).toHaveBeenCalledTimes(1);
    status = { ...status, elapsedMs: 16000, liveTranscript: { segments: [...liveTranscript.segments, { startMs: 12000, endMs: 14000, text: 'Next batch', words: [{ text: 'Next', startMs: 12000, endMs: 13000 }, { text: 'batch', startMs: 13000, endMs: 14000 }] }] } };
    await poll();
    expect(await screen.findByRole('button', { name: 'Seek to batch at 0:13' })).toBeDisabled();
    expect(screen.getByRole('button', { name: NAMES.stop })).toBeEnabled();
  });
  it('passes selected USB source, selected microphone, system audio and mute independently, then loads the completed transcript', async () => {
    const user = await ready();
    await user.click(screen.getByRole('button', { name: 'Display 1' }));
    await chooseSource(user, 'Quest USB');
    await user.click(screen.getByRole('button', { name: 'Quest USB' }));
    await user.click(screen.getByLabelText(NAMES.includeDeviceAudio)); await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Studio microphone' }));
    await chooseMicrophone(user, 'mic2'); await user.click(screen.getByRole('button', { name: 'Headset microphone' })); await user.click(screen.getByLabelText(NAMES.muteMicrophone)); await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: NAMES.record }));
    await screen.findByRole('button', { name: NAMES.stop });
    expect(backend.start).toHaveBeenCalledWith(null, null, 'quest1', 'mic2', true, true);
    expect(screen.getByText('Listening… transcript updates in short batches.')).toBeVisible();
    const mute = screen.getByRole('button', { name: NAMES.muteMicrophone });
    expect(mute).toHaveAttribute('aria-pressed', 'true');
    await user.click(mute);
    expect(backend.mute).toHaveBeenCalledWith(false);
    expect(mute).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: NAMES.stop }));
    await transcriptPane().findByText('Processing');
    expect(screen.getByRole('button', { name: NAMES.recordMore })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'r', ctrlKey: true }); expect(backend.start).toHaveBeenCalledTimes(1); expect(backend.recordMore).not.toHaveBeenCalled();
    let completeTranscript!: (value: Transcript) => void;
    backend.transcript.mockImplementationOnce(() => new Promise<Transcript>(resolve => { completeTranscript = resolve; }));
    sessions = sessions.map(item => item.id === 's2' ? { ...item, name: 'Details panel does not update', status: 'ready' } : item); status = { state: 'idle' };
    await poll();
    await act(async () => completeTranscript(transcript));
    expect(await screen.findByRole('button', { name: 'Seek to here at 0:02' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Details panel does not update');
    expect(screen.getByRole('button', { name: NAMES.recordMore })).toBeEnabled();
    expect(transcriptPane().queryByText('Processing')).not.toBeInTheDocument();
    expect(backend.stop).toHaveBeenCalledTimes(1);
  });
  it('keeps a capture failure actionable and allows a second recording attempt', async () => {
    const user = await ready(); backend.start.mockRejectedValueOnce('USB device disconnected. Reconnect Quest and try again.');
    await user.click(screen.getByRole('button', { name: NAMES.record }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reconnect Quest');
    expect(screen.getByRole('button', { name: NAMES.record })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: NAMES.record }));
    expect(await screen.findByRole('button', { name: NAMES.stop })).toBeEnabled();
  });
  it('does not bring back a dismissed runtime error on the next poll', async () => {
    await ready();
    status = { state: 'idle', error: 'The microphone stopped responding.' };
    await poll();
    expect(await screen.findByRole('alert')).toHaveTextContent('The microphone stopped responding.');
    fireEvent.click(screen.getByRole('button', { name: NAMES.dismissError }));
    await poll();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    status = { state: 'idle', error: 'The display was disconnected.' };
    await poll();
    expect(await screen.findByRole('alert')).toHaveTextContent('The display was disconnected.');
  });
});

describe('record more', () => {
  it('unloads the video before recording a take, shows it live, and reloads the video with a cache-buster once processing ends', async () => {
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const user = await review();
    const media = document.querySelector('video')!;
    expect(media).toHaveAttribute('src', 'asset://C:/recordings/video.mp4');
    backend.recordMore.mockImplementationOnce(async (id: string) => {
      expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
      expect(media.hasAttribute('src')).toBe(false);
      expect(load).toHaveBeenCalled();
      sessions = sessions.map(item => item.id === id ? takeTwo(item) : item);
      status = { state: 'recording', sessionId: id, elapsedMs: 0, takeIndex: 2, takeOffsetMs: 10000 };
      return takeTwo(newSession(id));
    });
    await user.click(screen.getByRole('button', { name: NAMES.recordMore }));
    expect(await screen.findByRole('timer', { name: NAMES.takeTimer(2) })).toHaveTextContent('Take 2');
    expect(backend.recordMore).toHaveBeenCalledWith('s1', 'mic1', false, false);
    expect(document.querySelector('video')).toBeNull();
    expect(screen.getByRole('button', { name: NAMES.copyForAgent })).toBeDisabled();
    expect(screen.getByRole('button', { name: NAMES.newRecording })).toBeDisabled();
    expect(transcriptPane().getByText('Take 2 · recording')).toBeVisible();
    expect(screen.getByText('Adding to this session. Stop to process take 2 on this device.')).toBeVisible();

    // The live tail of take 2 sits on the session timeline after the saved take 1.
    status = { ...status, elapsedMs: 3000, liveTranscript: { segments: [{ startMs: 11000, endMs: 12500, text: 'More words', words: [{ text: 'More', startMs: 11000, endMs: 11600 }, { text: 'words', startMs: 11600, endMs: 12500 }] }] } };
    await poll();
    expect(await screen.findByRole('button', { name: 'Seek to More at 0:11' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Seek to here at 0:02' })).toBeDisabled();
    expect(screen.getByRole('timer', { name: NAMES.takeTimer(2) })).toHaveTextContent('00:03');

    // Stop returns while the take is still being appended to video.mp4.
    backend.stop.mockImplementationOnce(async () => { const next = takeTwo(newSession(), 'swapping'); sessions = [next]; status = { state: 'processing', sessionId: 's1', takeIndex: 2, takeOffsetMs: 10000 }; return next; });
    await user.click(screen.getByRole('button', { name: NAMES.stop }));
    await transcriptPane().findByText('Processing');
    expect(document.querySelector('video')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Finishing your recording' })).toBeVisible();
    expect(screen.getByRole('button', { name: NAMES.recordMore })).toBeDisabled();
    await poll();
    expect(document.querySelector('video')).toBeNull();

    sessions = [takeTwo(newSession(), 'ready')];
    transcript = { takes: [{ index: 1, startMs: 0 }, { index: 2, startMs: 10000 }], segments: [...transcript.segments, { id: 't2-line1', startMs: 11000, endMs: 12500, text: 'More words', words: [{ text: 'More', startMs: 11000, endMs: 11600 }, { text: 'words', startMs: 11600, endMs: 12500 }] }] };
    status = { state: 'idle' };
    await poll();
    await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'asset://C:/recordings/video.mp4?v=2-20000'));
    expect(transcriptPane().getByText('Take 2 · 0:10')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Seek to More at 0:11' })).toBeEnabled();
    expect(screen.getByRole('button', { name: NAMES.recordMore })).toBeEnabled();
    expect(screen.getByRole('button', { name: NAMES.copyForAgent })).toBeEnabled();
  });
  it('keeps the recording playable and restores playback when Record more fails', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const user = await review();
    await user.click(screen.getByRole('button', { name: 'Seek to here at 0:02' }));
    const media = document.querySelector('video');
    backend.recordMore.mockRejectedValueOnce('Record more needs a playable recording.');
    await user.click(screen.getByRole('button', { name: NAMES.recordMore }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Record more needs a playable recording.');
    await waitFor(() => expect(document.querySelector('video')).not.toBe(media));
    const restored = document.querySelector('video')!;
    expect(restored).toHaveAttribute('src', 'asset://C:/recordings/video.mp4');
    fireEvent.loadedMetadata(restored); expect(restored.currentTime).toBe(2.5);
    expect(screen.getByRole('button', { name: NAMES.recordMore })).toBeEnabled();
  });
  it('refuses Record more with an unavailable microphone and leaves the video loaded', async () => {
    const user = await ready();
    backend.microphones.mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: 'Display 1' }));
    await user.click(screen.getByRole('button', { name: NAMES.refreshCaptureDevices }));
    await screen.findByRole('button', { name: NAMES.microphoneUnavailable });
    await user.keyboard('{Escape}');
    await open(user); await screen.findByRole('button', { name: 'Seek to here at 0:02' });
    const media = document.querySelector('video');
    await user.click(screen.getByRole('button', { name: NAMES.recordMore }));
    expect(await screen.findByRole('alert')).toHaveTextContent('selected microphone is unavailable');
    expect(backend.recordMore).not.toHaveBeenCalled();
    expect(document.querySelector('video')).toBe(media);
    expect(media).toHaveAttribute('src', 'asset://C:/recordings/video.mp4');
  });
  it('restores a take that is recording after a restart, with the saved takes before its live tail', async () => {
    sessions = [takeTwo(newSession())];
    status = { state: 'recording', sessionId: 's1', elapsedMs: 4000, takeIndex: 2, takeOffsetMs: 10000, liveTranscript: { segments: [{ startMs: 11000, endMs: 12000, text: 'Again', words: [{ text: 'Again', startMs: 11000, endMs: 12000 }] }] } };
    render(<App platform="windows"/>);
    expect(await screen.findByRole('timer', { name: NAMES.takeTimer(2) })).toHaveTextContent('00:04');
    expect(await screen.findByRole('button', { name: 'Seek to Again at 0:11' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Seek to here at 0:02' })).toBeDisabled();
    expect(transcriptPane().getByText('Take 2 · recording')).toBeVisible();
  });
  it('does not load the video while a take is still being appended to it', async () => {
    sessions = [{ ...takeTwo(newSession(), 'swapping'), status: 'error', error: 'Take 2 is not on the timeline yet. Retry to finish it.' }];
    const user = await ready();
    await open(user);
    expect(await screen.findByRole('button', { name: NAMES.retryTranscription })).toBeEnabled();
    expect(document.querySelector('video')).toBeNull();
    expect(screen.getByRole('button', { name: NAMES.recordMore })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: NAMES.retryTranscription }));
    expect(backend.retry).toHaveBeenCalledWith('s1');
    sessions = [takeTwo(newSession(), 'ready')]; status = { state: 'idle' };
    await poll();
    await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'asset://C:/recordings/video.mp4?v=2-20000'));
  });
});

describe('review handoff', () => {
  it('seeks and highlights an aligned word after leading silence instead of its coarse legacy interval', async () => {
    sessions = [{ ...newSession(), durationMs: 20000 }];
    transcript = { segments: [{ id: 'aligned', text: 'When', startMs: 0, endMs: 1300, words: [{ text: 'When', startMs: 0, endMs: 1300, seekMs: 10220 }] }] };
    const user = await ready(); await open(user);
    const word = await screen.findByRole('button', { name: 'Seek to When at 0:10' });
    expect(word).not.toHaveAttribute('aria-current');
    const media = document.querySelector('video')!;
    media.currentTime = .7; fireEvent.timeUpdate(media);
    expect(word).not.toHaveAttribute('aria-current');
    await user.click(screen.getByRole('button', { name: 'Seek to 0:10' }));
    expect(media.currentTime).toBe(10.22);
    expect(word).toHaveAttribute('aria-current', 'true');
    media.currentTime = 11; fireEvent.timeUpdate(media);
    expect(word).not.toHaveAttribute('aria-current');
    await user.click(word);
    expect(media.currentTime).toBe(10.22);
    expect(word).toHaveAttribute('aria-current', 'true');
  });
  it('seeks the real media time from a word and copies the backend handoff', async () => {
    const user = await review();
    await user.click(screen.getByRole('button', { name: 'Seek to here at 0:02' }));
    const media = document.querySelector('video')!;
    expect(media.currentTime).toBe(2.5); expect(screen.getByLabelText(NAMES.playbackPosition)).toHaveValue('2500');
    expect(screen.getByRole('button', { name: 'Seek to here at 0:02' })).toHaveAttribute('aria-current', 'true');
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await user.click(screen.getByRole('button', { name: NAMES.copyForAgent }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith('Review local session s1. Transcript and frame instructions.'));
    expect(await screen.findByText('Agent instructions copied')).toBeVisible();
    await user.click(screen.getByRole('button', { name: NAMES.openRecordingFolder })); expect(backend.openFolder).toHaveBeenCalledWith('s1');
  });
  it('has no marker controls, ignores M, and never reads or writes markers', async () => {
    const user = await review();
    expect(screen.queryByRole('button', { name: RETIRED_NAMES.addMarker })).not.toBeInTheDocument();
    expect(screen.queryByText('Markers')).not.toBeInTheDocument();
    expect(screen.queryByText('Legacy marker')).not.toBeInTheDocument();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('m');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: NAMES.settings }));
    expect(screen.getByRole('dialog', { name: NAMES.settingsDialog })).not.toHaveTextContent(/marker/i);
    expect(backend.markers).not.toHaveBeenCalled(); expect(backend.addMarker).not.toHaveBeenCalled();
  });
  it('does not request smooth transcript scrolling when reduced motion is selected', async () => {
    document.documentElement.dataset.motion = 'reduced';
    try {
      const user = await review(); vi.mocked(Element.prototype.scrollIntoView).mockClear();
      await user.click(screen.getByRole('button', { name: 'Seek to here at 0:02' }));
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'nearest' });
    } finally { delete document.documentElement.dataset.motion; }
  });
  it('retries a failed transcript and returns to usable review after processing', async () => {
    sessions = [{ ...newSession(), status: 'error', error: 'Speech model not found' }]; transcript = { segments: [], error: 'Speech model not found' };
    const user = await ready(); await open(user);
    expect(await transcriptPane().findByText('Speech model not found')).toBeVisible();
    await user.click(await screen.findByRole('button', { name: NAMES.retryTranscription }));
    expect(backend.retry).toHaveBeenCalledWith('s1');
    expect(await transcriptPane().findByText('Processing')).toBeVisible();
    expect(screen.getByRole('button', { name: NAMES.recordMore })).toBeDisabled();
    sessions = [newSession()]; transcript = { segments: [{ startMs: 0, endMs: 1000, text: 'Restored', words: [{ text: 'Restored', startMs: 0, endMs: 1000 }] }] }; status = { state: 'idle' };
    await poll(); expect(await screen.findByRole('button', { name: 'Seek to Restored at 0:00' })).toBeVisible();
  });
});

describe('local setup recovery and request races', () => {
  it.each(['mic2', ''])('preserves a vanished microphone, blocks recording, and allows explicit recovery with %s', async replacement => {
    const user = await ready();
    backend.microphones.mockResolvedValue([{ id: 'mic2', name: 'Headset microphone' }]);
    await user.click(screen.getByRole('button', { name: 'Display 1' }));
    await user.click(screen.getByRole('button', { name: NAMES.refreshCaptureDevices }));
    await screen.findByRole('button', { name: NAMES.microphoneUnavailable });
    expect(screen.getByRole('button', { name: NAMES.record })).toBeDisabled();
    expect(screen.queryByRole('button', { name: NAMES.noMicrophone })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.start).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('selected microphone is unavailable');
    await user.click(screen.getByRole('button', { name: NAMES.microphoneUnavailable }));
    expect(within(screen.getByRole('group', { name: NAMES.microphoneOptions })).getByRole('button', { name: NAMES.previousMicrophoneUnavailable })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Reconnect the selected microphone and refresh microphones, choose another input, or select No microphone.')).toBeVisible();
    await chooseMicrophone(user, replacement);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: NAMES.record })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: NAMES.record })); await screen.findByRole('button', { name: NAMES.stop });
    expect(backend.start).toHaveBeenCalledWith(null, null, 'display1', replacement || null, false, false);
  });
  it('keeps Stop available when a restored recording microphone is unavailable', async () => {
    sessions = [{ ...newSession(), status: 'recording' }]; status = { state: 'recording', sessionId: 's1', elapsedMs: 3000 };
    backend.microphones.mockResolvedValue([]);
    backend.stop.mockResolvedValue({ ...sessions[0], status: 'processing' });
    const user = userEvent.setup(); render(<App platform="windows"/>);
    await screen.findByRole('button', { name: NAMES.stop });
    await waitFor(() => expect(backend.microphones).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: NAMES.muteMicrophone })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: NAMES.stop })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: NAMES.stop }));
    expect(backend.stop).toHaveBeenCalledTimes(1);
  });
  it('removes the last preview frame when the stream reports a failure', async () => {
    await ready();
    expect(await screen.findByRole('img', { name: 'Live preview of Display 1' })).toBeVisible();
    act(() => backend.preview.mock.calls.at(-1)![2]('Preview connection lost. Reconnect the selected device.'));
    expect(await screen.findByText('Preview connection lost. Reconnect the selected device.', {}, { timeout: 2200 })).toBeVisible();
    expect(screen.queryByRole('img', { name: 'Live preview of Display 1' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Preview unavailable' })).toBeVisible();
  });
  it('allows selecting an offline device to read its recovery guidance without starting capture', async () => {
    backend.sources.mockResolvedValue([{ id: 'display1', name: 'Display 1', kind: 'display', available: true }, { id: 'quest-offline', name: 'Quest disconnected', kind: 'quest', available: false, detail: 'Reconnect the USB cable and authorize USB debugging on the headset, then refresh.' }]);
    const user = await ready(); await user.click(screen.getByRole('button', { name: 'Display 1' }));
    await chooseSource(user, NAMES.unavailableSource('Quest disconnected'));
    expect(screen.getByRole('button', { name: 'Quest disconnected' })).toBeVisible();
    expect(screen.getAllByText('Reconnect the USB cable and authorize USB debugging on the headset, then refresh.').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Capture source unavailable' })).toBeVisible();
    expect(screen.getByRole('button', { name: NAMES.record })).toBeDisabled();
    await user.keyboard('{Escape}');
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.start).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('authorize USB debugging');
  });
  it('keeps a vanished selected source unavailable instead of silently recording the first monitor', async () => {
    const user = await ready(); await user.click(screen.getByRole('button', { name: 'Display 1' }));
    await chooseSource(user, 'Quest USB');
    backend.sources.mockResolvedValue([{ id: 'display1', name: 'Display 1', kind: 'display', available: true }]);
    await user.click(screen.getByRole('button', { name: 'Quest USB' }));
    await user.click(screen.getByRole('button', { name: NAMES.refreshCaptureDevices }));
    await screen.findByRole('button', { name: NAMES.unavailableSource('Previously selected source') });
    expect(screen.getByRole('button', { name: NAMES.unavailableSource('Previously selected source') })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Capture source unavailable' })).toBeVisible();
    expect(screen.getByRole('button', { name: NAMES.record })).toBeDisabled();
    expect(screen.queryByRole('img', { name: 'Live preview of Display 1' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.start).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('Reconnect it and refresh');
  });
  it.each(['whisper-cli', 'whisper-vad-speech-segments'])('lets installation fail, retry, and recover when models exist but %s is absent', async dependency => {
    setup = { ready: false, issues: [`${dependency} is missing`], modelReady: true, dependencies: [{ name: dependency, available: false }] };
    backend.installTranscription.mockRejectedValueOnce('Download failed. Check your connection and retry.').mockImplementationOnce(async () => { setup = { ...readySetup }; });
    const user = await ready(); await user.click(screen.getByRole('button', { name: NAMES.reviewSetup }));
    await user.click(screen.getByRole('button', { name: NAMES.installTranscription }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection');
    await user.click(screen.getByRole('button', { name: NAMES.installTranscription }));
    await waitFor(() => expect(screen.getByText('Transcription').parentElement).toHaveTextContent('Available'));
    expect(screen.queryByRole('button', { name: NAMES.installTranscription })).not.toBeInTheDocument();
    expect(backend.installTranscription).toHaveBeenCalledTimes(2);
  });
  it('allows Settings to close during a background installation so an active recording remains controllable', async () => {
    setup = { ready: false, issues: ['Speech model missing'], modelReady: false, dependencies: readySetup.dependencies };
    let finishInstall!: () => void;
    backend.installTranscription.mockImplementationOnce(() => new Promise<void>(resolve => { finishInstall = () => { setup = { ...readySetup }; resolve(); }; }));
    const user = await ready(); await user.click(screen.getByRole('button', { name: NAMES.record })); await screen.findByRole('button', { name: NAMES.stop });
    await user.click(screen.getByRole('button', { name: NAMES.settings }));
    await user.click(screen.getByRole('button', { name: NAMES.installTranscription }));
    expect(screen.getByRole('button', { name: NAMES.downloadingSpeechTools })).toBeDisabled();
    expect(screen.getByRole('button', { name: NAMES.closeSettings })).toBeEnabled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: NAMES.settingsDialog })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: NAMES.stop })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: NAMES.stop })); expect(backend.stop).toHaveBeenCalledOnce();
    await act(async () => finishInstall());
    await user.click(screen.getByRole('button', { name: NAMES.settings }));
    expect(screen.getByText('Transcription').parentElement).toHaveTextContent('Available');
    expect(backend.installTranscription).toHaveBeenCalledOnce();
  });
  it('saves the vocabulary from Settings', async () => {
    backend.settings.mockResolvedValue({ vocabulary: 'Quest' });
    const user = await ready();
    await user.click(screen.getByRole('button', { name: NAMES.settings }));
    const field = screen.getByLabelText(NAMES.vocabulary);
    await waitFor(() => expect(field).toHaveValue('Quest'));
    await user.clear(field); await user.type(field, 'CueReview,  Tauri');
    await user.click(screen.getByRole('button', { name: NAMES.save }));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalledWith({ vocabulary: 'CueReview, Tauri' }));
    expect(await screen.findByText('Vocabulary saved')).toBeVisible();
    expect(field).toHaveValue('CueReview, Tauri');
  });
  it('ignores an old source preview that arrives after the user selects another source', async () => {
    let resolveOld!: (value: { id: string; url: string }) => void;
    backend.preview.mockImplementation((sourceId: string, id: string) => sourceId === 'display1' ? new Promise<{ id: string; url: string }>(resolve => { resolveOld = resolve; }) : Promise.resolve({ id, url: 'http://127.0.0.1:9999/quest' }));
    const user = await ready(); await user.click(screen.getByRole('button', { name: 'Display 1' })); await chooseSource(user, 'Quest USB');
    const image = await screen.findByRole('img', { name: 'Live preview of Quest USB' });
    expect(image).toHaveAttribute('src', 'http://127.0.0.1:9999/quest');
    await act(async () => resolveOld({ id: 'old', url: 'http://127.0.0.1:9999/old' }));
    expect(image).toHaveAttribute('src', 'http://127.0.0.1:9999/quest');
  });
  it('does not let an old session response replace a newly prepared recording', async () => {
    let resolveOld!: (value: Session) => void; backend.session.mockImplementationOnce(() => new Promise<Session>(resolve => { resolveOld = resolve; }));
    const user = await ready(); await open(user);
    await user.click(sidebar().getByRole('button', { name: NAMES.newRecording }));
    await act(async () => resolveOld(newSession()));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(NAMES.newRecording);
    expect(screen.getByRole('button', { name: NAMES.record })).toBeEnabled();
  });
});
