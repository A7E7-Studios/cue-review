import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import App from './App';
import type { AppProps } from './App';
import type { CaptureSource, Microphone, Project, RecordingStatus, Session, SetupStatus, Transcript } from './backend';
import { WINDOW_CLOSED } from './stories/fixtures';
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
    setSize: vi.fn(), setMinSize: vi.fn(), setAlwaysOnTop: vi.fn(), innerSize: vi.fn(), scaleFactor: vi.fn(), setTheme: vi.fn(), setBackgroundColor: vi.fn(),
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
const newSession = (id = 's1'): Session => ({ id, projectId: 'p1', name: 'Review Alpha', createdAt: timestamp, durationMs: 10000, status: 'ready', videoPath: 'C:/recordings/video.mp4', folderPath: 'C:/recordings', sourceId: 'display1', microphoneId: 'mic1' });
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
  for (const name of ['minimize', 'toggleMaximize', 'close', 'startDragging', 'setSize', 'setMinSize', 'setAlwaysOnTop', 'setTheme', 'setBackgroundColor'] as const) windowApi[name].mockResolvedValue(undefined);
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
/** Like ready(), for a runtime that is busy transcribing: the app opens that recording itself. */
async function loaded(props: AppProps = { platform: 'windows' }) {
  const user = userEvent.setup(); render(<App {...props}/>);
  await waitFor(() => expect(backend.microphones).toHaveBeenCalled());
  await sidebar().findByRole('button', { name: /Review Alpha/ });
  return user;
}
const sidebar = () => within(screen.getByRole('complementary', { name: NAMES.recordings }));
/** New section lives in the sidebar's own menu: right-click empty space in the list. */
const newSection = async (user: ReturnType<typeof userEvent.setup>) => {
  fireEvent.contextMenu(document.querySelector('.recording-list')!);
  await user.click(screen.getByRole('menuitem', { name: NAMES.newSection }));
};
const transcriptPane = () => within(screen.getByRole('region', { name: NAMES.transcript }));
/** A text field beside the app, for the shortcuts and menus that leave text fields alone. */
function textField() {
  const field = document.body.appendChild(document.createElement('input'));
  field.type = 'search';
  onTestFinished(() => field.remove());
  return field;
}
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
/** Asserts that the latest call of each mock happened in this order. */
function expectCallOrder(...calls: { mock: { invocationCallOrder: number[] } }[]) {
  const order = calls.map(item => item.mock.invocationCallOrder.at(-1) ?? -1);
  expect(order.every(value => value > 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
}
/** Dispatches a keydown and reports whether the webview's default action (a reload for Ctrl+R or F5) was prevented. */
function press(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}
async function chooseMicrophone(user: TestUser, id: string) {
  const name = id === 'mic2' ? 'Headset microphone' : id === 'mic1' ? 'Studio microphone' : NAMES.noMicrophone;
  await user.click(within(screen.getByRole('group', { name: NAMES.microphoneOptions })).getByRole('button', { name }));
}
async function chooseSource(user: TestUser, name: string) {
  await user.click(within(screen.getByRole('group', { name: NAMES.captureSources })).getByRole('button', { name }));
}
/** A session whose take 2 is recording, as record_more returns it; once ready, take 2 has its own video (format 2). */
function takeTwo(session: Session, takeStatus: 'recording' | 'finalizing' | 'ready' = 'recording'): Session {
  const ready = takeStatus === 'ready';
  return { ...session, status: ready ? 'ready' : takeStatus === 'recording' ? 'recording' : 'processing', takes: [
    { index: 1, offsetMs: 0, durationMs: 10000, status: 'ready', folder: '.', systemAudio: false, microphoneId: 'mic1' },
    { index: 2, offsetMs: 10000, durationMs: takeStatus === 'recording' ? 0 : 10000, status: takeStatus, folder: 'takes/2', systemAudio: false, microphoneId: 'mic1' },
  ], durationMs: ready ? 20000 : 10000, ...ready && { formatVersion: 2, videos: [{ take: 1, startMs: 0, durationMs: 10000 }, { take: 2, startMs: 10000, durationMs: 10000 }] } };
}
/** record_more's mock: take 2 of the session starts recording. */
const recordTakeTwo = async (id: string) => {
  const next = takeTwo(sessions.find(item => item.id === id)!);
  sessions = sessions.map(item => item.id === id ? next : item);
  status = { state: 'recording', sessionId: id, elapsedMs: 0, takeIndex: 2, takeOffsetMs: 10000 };
  return structuredClone(next);
};
const figma = { id: 'window:42', name: 'Design review — Figma', kind: 'window' as const, available: true };

describe('capture source priority and macos cameras', () => {
  const camera: CaptureSource = { id: 'avfoundation:0', name: 'FaceTime HD Camera', kind: 'camera', available: true };
  const display: CaptureSource = { id: 'avfoundation:1', name: 'Capture screen 0', kind: 'display', available: true };
  const previewOf = (name: string) => screen.findByRole('img', { name: `Live preview of ${name}` });

  it('lists displays windows and devices before cameras', async () => {
    const discovery: CaptureSource[] = [
      camera,
      { id: 'screen2', name: 'Second discovered display', kind: 'display', available: true },
      { id: 'quest', name: 'Quest headset', kind: 'quest', available: true },
      { id: 'window', name: 'Review window', kind: 'window', available: true },
      { id: 'android', name: 'Android phone', kind: 'android', available: true },
      display,
      { id: 'camera2', name: 'External camera', kind: 'camera', available: true },
    ];
    backend.sources.mockResolvedValue(Object.freeze(discovery));
    const user = await ready({ platform: 'macos' });
    await previewOf('Second discovered display');
    await user.click(screen.getByRole('button', { name: 'Second discovered display' }));
    const options = within(screen.getByRole('group', { name: NAMES.captureSources })).getAllByRole('button');
    expect(options.map(option => option.textContent)).toEqual([
      'Second discovered display', 'Capture screen 0', 'Review window', 'Quest headset', 'Android phone', 'FaceTime HD Camera', 'External camera',
    ]);
    expect(discovery[0]).toBe(camera);
  });

  it('initially selects a display before a camera', async () => {
    backend.sources.mockResolvedValue([camera, display]);
    const user = await ready({ platform: 'macos' });
    await previewOf(display.name);
    expect(backend.preview.mock.calls[0][0]).toBe(display.id);
    await user.click(screen.getByRole('button', { name: display.name }));
    await chooseSource(user, camera.name);
    expect(await previewOf(camera.name)).toBeVisible();
  });

  it('skips unavailable sources when selecting the initial source', async () => {
    backend.sources.mockResolvedValue([
      camera,
      { ...display, available: false },
      { id: 'window', name: 'Closed window', kind: 'window', available: false },
      { id: 'phone', name: 'Android phone', kind: 'android', available: true },
    ]);
    await ready({ platform: 'macos' });
    await previewOf('Android phone');
    expect(backend.preview.mock.calls[0][0]).toBe('phone');
  });

  it('selects a camera when no higher priority source is available', async () => {
    backend.sources.mockResolvedValue([
      { ...camera, id: 'disconnected-camera', name: 'Disconnected camera', available: false },
      { ...display, available: false }, camera,
    ]);
    await ready({ platform: 'macos' });
    expect(await previewOf(camera.name)).toBeVisible();
    expect(backend.preview.mock.calls[0][0]).toBe(camera.id);
  });

  it.each([{ sources: [] }, { sources: [{ ...display, available: false }, { ...camera, available: false }] }])('does not select an unavailable initial source', async ({ sources }) => {
    backend.sources.mockResolvedValue(sources);
    render(<App platform="macos"/>);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Choose source' })).toBeVisible();
    expect(screen.getByRole('button', { name: NAMES.record })).toBeDisabled();
    expect(backend.preview).not.toHaveBeenCalled();
    expect(backend.start).not.toHaveBeenCalled();
  });

  it('keeps an explicit camera selection when a display appears', async () => {
    backend.sources.mockResolvedValue([{ id: 'phone', name: 'Android phone', kind: 'android', available: true }, camera]);
    const user = await ready({ platform: 'macos' });
    await user.click(screen.getByRole('button', { name: 'Android phone' }));
    await chooseSource(user, camera.name);
    await previewOf(camera.name);
    backend.sources.mockResolvedValue([camera, display]);
    await user.click(screen.getByRole('button', { name: camera.name }));
    await user.click(screen.getByRole('button', { name: NAMES.refreshCaptureDevices }));
    const options = within(screen.getByRole('group', { name: NAMES.captureSources }));
    await options.findByRole('button', { name: display.name });
    expect(options.getAllByRole('button').map(option => option.textContent)).toEqual([display.name, camera.name]);
    expect(options.getByRole('button', { name: camera.name })).toHaveAttribute('aria-pressed', 'true');
    expect(options.getByRole('button', { name: display.name })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('img', { name: `Live preview of ${camera.name}` })).toBeVisible();
    expect(backend.preview.mock.calls.at(-1)![0]).toBe(camera.id);
    expect(backend.preview.mock.calls.map(call => call[0])).not.toContain(display.id);
  });

  it('preserves a missing camera as an unavailable selection', async () => {
    backend.sources.mockResolvedValue([camera, display]);
    const user = await ready({ platform: 'macos' });
    await user.click(screen.getByRole('button', { name: display.name }));
    await chooseSource(user, camera.name);
    await previewOf(camera.name);
    backend.sources.mockResolvedValue([display]);
    await user.click(screen.getByRole('button', { name: camera.name }));
    await user.click(screen.getByRole('button', { name: NAMES.refreshCaptureDevices }));
    const missing = await screen.findByRole('button', { name: NAMES.unavailableSource('Previously selected source') });
    expect(missing).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Capture source unavailable' })).toBeVisible();
    expect(screen.getByRole('button', { name: NAMES.record })).toBeDisabled();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(backend.preview.mock.calls.map(call => call[0])).toEqual([display.id, camera.id]);
  });

  it('starts a macos camera recording from its preview', async () => {
    backend.sources.mockResolvedValue([display, camera]);
    backend.start.mockImplementationOnce(async (_project: string | null, _name: string | null, sourceId: string) => {
      const session = { ...newSession('s2'), name: 'Camera review', sourceId, status: 'recording' as const };
      sessions.push(session); status = { state: 'recording', sessionId: 's2', elapsedMs: 3000 };
      return session;
    });
    backend.stop.mockImplementationOnce(async () => {
      const next = { ...sessions.find(item => item.id === 's2')!, status: 'ready' as const };
      sessions = sessions.map(item => item.id === next.id ? next : item); status = { state: 'idle' };
      return next;
    });
    const user = await ready({ platform: 'macos' });
    await user.click(screen.getByRole('button', { name: display.name }));
    await chooseSource(user, camera.name);
    await previewOf(camera.name);
    const previewId = backend.preview.mock.calls.at(-1)![1];
    await user.click(screen.getByRole('button', { name: NAMES.record }));
    await screen.findByRole('button', { name: NAMES.stop });
    expect(backend.start).toHaveBeenCalledWith(null, null, camera.id, 'mic1', false, false);
    expect(screen.getByRole('img', { name: `Live preview of ${camera.name}` })).toBeVisible();
    await user.click(screen.getByRole('button', { name: NAMES.stop }));
    await screen.findByRole('button', { name: NAMES.play });
    expect(document.querySelector('video')).toHaveAttribute('src', 'asset://C:/recordings/video.mp4');
    expect(backend.stopPreview).toHaveBeenCalledWith(previewId);
  });

  it.each(['preview', 'recording'] as const)('shows actionable macos camera startup errors for %s', async phase => {
    const message = 'Camera access is blocked. Allow camera access in macOS System Settings, then retry.';
    backend.sources.mockResolvedValue([display, camera]);
    if (phase === 'preview') backend.preview.mockImplementation(async (sourceId: string, id: string) => {
      if (sourceId === camera.id) throw new Error(message);
      return { id, url: 'http://127.0.0.1:9999/live' };
    });
    else backend.start.mockRejectedValueOnce(message);
    const user = await ready({ platform: 'macos' });
    await user.click(screen.getByRole('button', { name: display.name }));
    await chooseSource(user, camera.name);
    if (phase === 'recording') {
      await previewOf(camera.name);
      await user.click(screen.getByRole('button', { name: NAMES.record }));
    }
    expect(await screen.findByText(message)).toBeVisible();
    if (phase === 'preview') {
      expect(screen.getByRole('heading', { name: 'Preview unavailable' })).toBeVisible();
      expect(screen.getByRole('button', { name: NAMES.retryPreview })).toBeVisible();
    }
    expect(screen.queryByRole('heading', { name: 'Loading preview…' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: camera.name }));
    await chooseSource(user, display.name);
    expect(await previewOf(display.name)).toBeVisible();
  });

  it('retries a blocked camera preview after access is restored', async () => {
    const message = 'Camera access is blocked. Allow camera access in macOS System Settings, then retry.';
    backend.sources.mockResolvedValue([camera]);
    backend.preview.mockRejectedValueOnce(message);
    const user = await ready({ platform: 'macos' });
    await screen.findByText(message);
    await user.click(screen.getByRole('button', { name: NAMES.retryPreview }));
    expect(await previewOf(camera.name)).toBeVisible();
    await user.click(screen.getByRole('button', { name: NAMES.record }));
    await screen.findByRole('button', { name: NAMES.stop });
    expect(backend.start).toHaveBeenCalledWith(null, null, camera.id, 'mic1', false, false);
  });
});

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
    await newSection(user);
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
    backend.stop.mockImplementation(async () => { const next = takeTwo(newSession(), 'finalizing'); sessions = [next]; status = { state: 'processing', sessionId: 's1', takeIndex: 2, takeOffsetMs: 10000 }; return next; });
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const user = await review();
    await user.keyboard('{Control>}r{/Control}');
    expect(await screen.findByRole('timer', { name: NAMES.takeTimer(2) })).toBeVisible();
    expect(backend.recordMore).toHaveBeenCalledWith('s1', 'display1', 'mic1', false, false);
    await user.keyboard('{Control>}r{/Control}');
    await transcriptPane().findByText('Processing');
    expect(backend.stop).toHaveBeenCalledOnce(); expect(backend.start).not.toHaveBeenCalled();
  });
  it('a mute from the dock ends with its take', async () => {
    backend.recordMore.mockImplementation(async (id: string) => { sessions = sessions.map(item => item.id === id ? takeTwo(item) : item); status = { state: 'recording', sessionId: id, elapsedMs: 0, takeIndex: 2, takeOffsetMs: 10000 }; return takeTwo(newSession(id)); });
    backend.stop.mockImplementation(async () => { const next = takeTwo(newSession(), 'ready'); sessions = [next]; status = { state: 'idle' }; return next; });
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const user = await review();
    await user.keyboard('{Control>}r{/Control}');
    await screen.findByRole('timer', { name: NAMES.takeTimer(2) });
    const mute = screen.getByRole('button', { name: NAMES.muteMicrophone });
    // The dock names the microphone it records.
    expect(mute).toHaveAccessibleDescription('Studio microphone');
    await user.click(mute);
    await waitFor(() => expect(screen.getByRole('button', { name: NAMES.muteMicrophone })).toHaveAttribute('aria-pressed', 'true'));
    expect(backend.mute).toHaveBeenLastCalledWith(true);
    await user.keyboard('{Control>}r{/Control}');
    await waitFor(() => expect(backend.stop).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: NAMES.recordMore })).toBeEnabled());
    await user.keyboard('{Control>}r{/Control}');
    await waitFor(() => expect(backend.recordMore).toHaveBeenCalledTimes(2));
    expect(backend.recordMore).toHaveBeenLastCalledWith('s1', 'display1', 'mic1', false, false);
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
    expect(screen.getByRole('button', { name: NAMES.newSession })).toHaveAttribute('aria-keyshortcuts', 'Meta+N');
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.start).not.toHaveBeenCalled();
    await user.keyboard('{Meta>}r{/Meta}');
    expect(await screen.findByRole('button', { name: NAMES.stop })).toBeEnabled();
    expect(backend.start).toHaveBeenCalledOnce();
  });
  it('ignores shortcuts in editable fields and open pickers, and never turns a modifier combination into a bare key', async () => {
    const user = await ready();
    textField().focus();
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
  it('opens search from the sidebar and with Ctrl+K', async () => {
    sessions = [newSession(), { ...newSession('s2'), projectId: null, name: 'Quest navigation', createdAt: '2026-10-28T10:00:00Z' }];
    const user = await ready();
    await user.click(sidebar().getByRole('button', { name: NAMES.search }));
    let dialog = screen.getByRole('dialog', { name: NAMES.search });
    const field = within(dialog).getByRole('combobox', { name: NAMES.searchRecordings });
    expect(field).toHaveFocus();
    // Before typing: the most recent recordings, newest first.
    expect(within(dialog).getAllByRole('option').map(option => option.textContent)).toEqual([expect.stringContaining('Quest navigation'), expect.stringContaining('Review Alpha')]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sidebar().getByRole('button', { name: NAMES.search })).toHaveFocus();
    // Ctrl+K from a text field too.
    textField().focus();
    await user.keyboard('{Control>}k{/Control}');
    dialog = await screen.findByRole('dialog', { name: NAMES.search });
    await user.type(within(dialog).getByRole('combobox'), 'here');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: /Review Alpha.*Look here.*0:01/ })).toBeVisible());
    expect(backend.start).not.toHaveBeenCalled();
  });
  it('opens a transcript line at its time', async () => {
    const user = await ready();
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: NAMES.search });
    await user.type(within(dialog).getByRole('combobox'), 'look');
    const line = await within(dialog).findByRole('option', { name: /Look here/ });
    await waitFor(() => expect(line).toHaveAttribute('aria-selected', 'true'));
    await user.keyboard('{Enter}');
    await screen.findByRole('button', { name: 'Seek to here at 0:02' });
    const media = document.querySelector('video')!;
    fireEvent.loadedMetadata(media);
    expect(media.currentTime).toBe(1);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });
  it('opens a line of the recording that is already open at its time', async () => {
    const user = await review();
    const media = document.querySelector('video')!;
    media.currentTime = 7;
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: NAMES.search });
    await user.type(within(dialog).getByRole('combobox'), 'look');
    await within(dialog).findByRole('option', { name: /Look here/ });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The same video: it seeks there at once, paused.
    expect(media.currentTime).toBe(1);
    expect(screen.getByRole('group', { name: NAMES.playback })).toHaveTextContent('0:01');
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });
  it('closes the narrow window\'s sidebar when a line of the open recording is chosen', async () => {
    window.innerWidth = 900;
    const user = await ready();
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    await open(user);
    await screen.findByRole('button', { name: 'Seek to here at 0:02' });
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    await user.click(sidebar().getByRole('button', { name: NAMES.search }));
    const dialog = await screen.findByRole('dialog', { name: NAMES.search });
    await user.type(within(dialog).getByRole('combobox'), 'look');
    await within(dialog).findByRole('option', { name: /Look here/ });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.querySelector('.app')).not.toHaveAttribute('data-sidebar', 'overlay'));
    expect(document.querySelector('video')!.currentTime).toBe(1);
  });
  it('opens a line of the shown recording at its time while another load runs', async () => {
    const user = await review();
    const media = document.querySelector('video')!;
    // The video has its metadata already; it does not load again for the same source.
    Object.defineProperty(media, 'readyState', { configurable: true, get: () => HTMLMediaElement.HAVE_METADATA });
    media.currentTime = 7;
    // The recording's row is clicked again: its load is in flight when the line is chosen.
    let finish!: () => void;
    backend.session.mockImplementationOnce((id: string) => new Promise(resolve => { finish = () => resolve(sessions.find(item => item.id === id)!); }));
    await user.click(sidebar().getByRole('button', { name: 'Review Alpha' }));
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: NAMES.search });
    await user.type(within(dialog).getByRole('combobox'), 'look');
    await within(dialog).findByRole('option', { name: /Look here/ });
    await user.keyboard('{Enter}');
    await act(async () => { finish(); });
    await waitFor(() => expect(media.currentTime).toBe(1));
    expect(screen.getByRole('group', { name: NAMES.playback })).toHaveTextContent('0:01');
  });
  it('applies only the latest of two lines chosen while loads run', async () => {
    transcript = { segments: [
      { id: 'line1', text: 'Look here', startMs: 1000, endMs: 2000, words: [{ text: 'Look', startMs: 1000, endMs: 1500 }, { text: 'here', startMs: 1500, endMs: 2000 }] },
      { id: 'line2', text: 'Look there', startMs: 3000, endMs: 4000, words: [] },
    ] };
    const user = await ready();
    await open(user);
    await screen.findByRole('button', { name: 'Seek to here at 0:01' });
    const media = document.querySelector('video')!;
    Object.defineProperty(media, 'readyState', { configurable: true, get: () => HTMLMediaElement.HAVE_METADATA });
    const pending: (() => void)[] = [];
    const slow = (id: string) => new Promise<Session>(resolve => { pending.push(() => resolve(sessions.find(item => item.id === id)!)); });
    backend.session.mockImplementationOnce(slow).mockImplementationOnce(slow).mockImplementationOnce(slow);
    // A load runs (the row clicked again) while two lines are chosen, one after the other.
    await user.click(sidebar().getByRole('button', { name: 'Review Alpha' }));
    for (const line of [/Look here/, /Look there/]) {
      await user.keyboard('{Control>}k{/Control}');
      const dialog = await screen.findByRole('dialog', { name: NAMES.search });
      await user.type(within(dialog).getByRole('combobox'), 'look');
      await user.click(await within(dialog).findByRole('option', { name: line }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }
    // The loads finish in order; only the last choice applies, and the clock agrees with the video.
    // A frame passes between them, as it would in the app.
    for (const finish of pending) await act(async () => { finish(); await new Promise(resolve => setTimeout(resolve, 50)); });
    await waitFor(() => expect(media.currentTime).toBe(3));
    expect(screen.getByRole('group', { name: NAMES.playback })).toHaveTextContent('0:03');
  });
  it('says when a recording opened from search cannot be played', async () => {
    const user = await ready();
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: NAMES.search });
    await user.type(within(dialog).getByRole('combobox'), 'look');
    await within(dialog).findByRole('option', { name: /Look here/ });
    await user.keyboard('{Enter}');
    await screen.findByRole('button', { name: 'Seek to here at 0:02' });
    fireEvent.error(document.querySelector('video')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be played');
  });
  it('drops a search result\'s time when its load fails', async () => {
    const user = await review();
    const media = document.querySelector('video')!;
    Object.defineProperty(media, 'readyState', { configurable: true, get: () => HTMLMediaElement.HAVE_METADATA });
    media.currentTime = 7;
    // A load runs (the row clicked again), then the result's own load fails.
    let finish!: () => void;
    backend.session.mockImplementationOnce((id: string) => new Promise(resolve => { finish = () => resolve(sessions.find(item => item.id === id)!); }));
    await user.click(sidebar().getByRole('button', { name: 'Review Alpha' }));
    backend.session.mockRejectedValueOnce('The recording is busy.');
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: NAMES.search });
    await user.type(within(dialog).getByRole('combobox'), 'look');
    await within(dialog).findByRole('option', { name: /Look here/ });
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('The recording is busy.');
    await act(async () => { finish(); });
    // A later update of the same recording (a rename) does not jump to the stale line.
    await user.click(screen.getByRole('button', { name: NAMES.recordingOptions }));
    await user.click(screen.getByRole('menuitem', { name: NAMES.rename }));
    const field = await screen.findByLabelText(NAMES.nameField);
    await waitFor(() => expect(field).toHaveFocus());
    fireEvent.change(field, { target: { value: 'Renamed' } });
    await user.click(screen.getByRole('button', { name: NAMES.save }));
    await waitFor(() => expect(backend.renameSession).toHaveBeenCalledWith('s1', 'Renamed'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(media.currentTime).toBe(7);
  });
  it('searches each transcript as it is when search opens', async () => {
    const user = await ready();
    await user.keyboard('{Control>}k{/Control}');
    let dialog = await screen.findByRole('dialog', { name: NAMES.search });
    await user.type(within(dialog).getByRole('combobox'), 'look');
    await within(dialog).findByRole('option', { name: /Look here/ });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The transcript changes (a retry, or `cue transcribe`) while the recording's status and length stay.
    transcript = { segments: [{ id: 'line1', text: 'Watch there', startMs: 1000, endMs: 4000, words: [] }] };
    await user.keyboard('{Control>}k{/Control}');
    dialog = await screen.findByRole('dialog', { name: NAMES.search });
    await user.type(within(dialog).getByRole('combobox'), 'watch');
    expect(await within(dialog).findByRole('option', { name: /Watch there/ })).toBeVisible();
  });
  it('does not open search while recording', async () => {
    const user = await ready();
    await user.keyboard('{Control>}r{/Control}');
    expect(await screen.findByRole('button', { name: NAMES.stop })).toBeEnabled();
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(sidebar().getByRole('button', { name: NAMES.search })).toBeDisabled();
  });
  it('brings the transcript back for Ctrl+F in focus', async () => {
    const user = await review();
    await user.click(screen.getByRole('button', { name: NAMES.focusVideo }));
    expect(document.querySelector('.cr-transcript-column')).not.toBeInTheDocument();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('{Control>}f{/Control}');
    const field = await transcriptPane().findByRole('searchbox', { name: NAMES.findInTranscript });
    await waitFor(() => expect(field).toHaveFocus());
    expect(screen.getByRole('button', { name: NAMES.focusVideo })).toHaveAttribute('aria-pressed', 'false');
  });
  it('finds in the transcript with Ctrl+F', async () => {
    const user = await review();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('{Control>}f{/Control}');
    const field = transcriptPane().getByRole('searchbox', { name: NAMES.findInTranscript });
    await waitFor(() => expect(field).toHaveFocus());
    await user.type(field, 'look');
    expect(transcriptPane().getByRole('status')).toHaveTextContent('1 of 1');
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
    // Escape closes the submenu first, then the recording's menu.
    await user.keyboard('{Escape}'); expect(screen.getByRole('menuitem', { name: NAMES.moveToSection })).toHaveFocus();
    expect(screen.queryByRole('menu', { name: NAMES.moveToSection })).not.toBeInTheDocument();
    await user.keyboard('{Escape}'); expect(row).toHaveFocus();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it('cancels the webview menu across the workspace and keeps it in text fields', async () => {
    await review();
    // fireEvent returns false when a handler cancelled the event, which is what keeps the webview's menu away.
    expect(fireEvent.contextMenu(screen.getByRole('region', { name: NAMES.recordingVideo }))).toBe(false);
    expect(fireEvent.contextMenu(screen.getByRole('button', { name: NAMES.settings }))).toBe(false);
    expect(fireEvent.contextMenu(document.body)).toBe(false);
    expect(fireEvent.contextMenu(textField())).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it('creates a section directly from a recording menu and moves only that recording', async () => {
    const user = await review();
    await user.click(screen.getByRole('button', { name: NAMES.recordingOptions }));
    await user.click(screen.getByRole('menuitem', { name: NAMES.moveToSection }));
    await user.click(screen.getByRole('menuitem', { name: NAMES.newSectionItem }));
    await user.type(screen.getByLabelText(NAMES.nameField), 'New category'); await user.click(screen.getByRole('button', { name: NAMES.save }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: NAMES.section('New category') })).getByRole('button', { name: 'Review Alpha' })).toBeEnabled());
    expect(backend.moveSession).toHaveBeenCalledWith('s1', 'p2');
  });
  it('files a session started from a section heading in that section', async () => {
    const user = await review();
    await user.click(sidebar().getByRole('button', { name: NAMES.newSessionInSection('Project Alpha') }));
    expect(await screen.findByRole('heading', { name: NAMES.newRecording })).toBeVisible();
    await user.keyboard('{Control>}r{/Control}');
    expect(await screen.findByRole('button', { name: NAMES.stop })).toBeEnabled();
    expect(backend.start).toHaveBeenCalledWith('p1', null, 'display1', 'mic1', false, false);
  });
  it('starts a plain new session in Recents after one started from a section', async () => {
    const user = await review();
    await user.click(sidebar().getByRole('button', { name: NAMES.newSessionInSection('Project Alpha') }));
    await user.click(sidebar().getByRole('button', { name: NAMES.newSession }));
    await user.keyboard('{Control>}r{/Control}');
    expect(await screen.findByRole('button', { name: NAMES.stop })).toBeEnabled();
    expect(backend.start).toHaveBeenCalledWith(null, null, 'display1', 'mic1', false, false);
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
    // Windows keeps the toggle in the title bar only; the sidebar has no second Hide sidebar button.
    expect(sidebar().queryByRole('button', { name: NAMES.hideSidebar })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: NAMES.hideSidebar }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    expect(sidebar().getByRole('button', { name: 'Review Alpha' })).toBeVisible();
    expect(screen.queryByRole('button', { name: RETIRED_NAMES.useDarkTheme })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RETIRED_NAMES.useLightTheme })).not.toBeInTheDocument();
  });
  it('sets the theme in Settings → Appearance and keeps it for the next launch', async () => {
    // The ground tokens (Vitest loads no CSS); the native window takes the ground's color too.
    const tokens = document.createElement('style');
    tokens.textContent = ":root { --color-ground: #ECEEF2; } :root[data-theme='dark'] { --color-ground: #121215; }";
    document.head.append(tokens);
    onTestFinished(() => tokens.remove());
    const user = await ready();
    expect(windowApi.setTheme).toHaveBeenLastCalledWith('light');
    expect(windowApi.setBackgroundColor).toHaveBeenLastCalledWith('#ECEEF2');
    await user.click(screen.getByRole('button', { name: NAMES.settings }));
    await user.selectOptions(screen.getByLabelText(NAMES.appearance), 'dark');
    await waitFor(() => expect(windowApi.setTheme).toHaveBeenLastCalledWith('dark'));
    expect(windowApi.setBackgroundColor).toHaveBeenLastCalledWith('#121215');
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
    await newSection(user);
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

describe('playback controls', () => {
  it('plays at the speed chosen from the list', async () => {
    const user = await review();
    await user.click(screen.getByRole('button', { name: NAMES.playbackSpeed(1) }));
    await user.click(screen.getByRole('menuitemradio', { name: '1.5×' }));
    expect(document.querySelector('video')!.playbackRate).toBe(1.5);
    expect(screen.getByRole('button', { name: NAMES.playbackSpeed(1.5) })).toHaveFocus();
  });
  it('keeps the chosen speed for the next recording and the next start', async () => {
    const user = await review();
    await user.click(screen.getByRole('button', { name: NAMES.playbackSpeed(1) }));
    await user.click(screen.getByRole('menuitemradio', { name: '1.75×' }));
    expect(localStorage.getItem('cuereview.playbackSpeed')).toBe('1.75');
    cleanup();
    await review();
    expect(screen.getByRole('button', { name: NAMES.playbackSpeed(1.75) })).toBeVisible();
    // The rate applies when the video loads (a browser resets it on each load).
    fireEvent.loadedMetadata(document.querySelector('video')!);
    expect(document.querySelector('video')!.playbackRate).toBe(1.75);
  });
  it('hides the sidebar and the transcript in focus', async () => {
    const user = await review();
    const focus = screen.getByRole('button', { name: NAMES.focusVideo });
    await user.click(focus);
    await waitFor(() => expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument());
    expect(document.querySelector('.cr-transcript-column')).not.toBeInTheDocument();
    expect(focus).toHaveAttribute('aria-pressed', 'true');
  });
  it('ends focus when the sidebar is shown or the workspace leaves review', async () => {
    const user = await review();
    const focus = screen.getByRole('button', { name: NAMES.focusVideo });
    await user.click(focus);
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    expect(await screen.findByRole('complementary', { name: NAMES.recordings })).toBeVisible();
    expect(document.querySelector('.cr-transcript-column')).toBeInTheDocument();
    expect(focus).toHaveAttribute('aria-pressed', 'false');
    await user.click(focus);
    await user.keyboard('{Control>}n{/Control}');
    expect(await screen.findByRole('complementary', { name: NAMES.recordings })).toBeVisible();
    expect(document.querySelector('.cr-transcript-column')).toBeInTheDocument();
  });
  it('keeps both sidebars hidden in focus when a narrow window widens', async () => {
    window.innerWidth = 900;
    const user = await ready();
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    await open(user);
    await screen.findByRole('button', { name: 'Seek to here at 0:02' });
    await user.click(screen.getByRole('button', { name: NAMES.focusVideo }));
    await act(async () => { window.innerWidth = 1280; window.dispatchEvent(new Event('resize')); });
    expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument();
    expect(document.querySelector('.cr-transcript-column')).not.toBeInTheDocument();
    // Leaving focus docks it again, as it was before focus.
    await user.click(screen.getByRole('button', { name: NAMES.focusVideo }));
    expect(await screen.findByRole('complementary', { name: NAMES.recordings })).toBeVisible();
    expect(document.querySelector('.app')).toHaveAttribute('data-sidebar', 'docked');
  });
  it('docks the sidebar when Show sidebar ends focus in a narrow window that widens', async () => {
    const user = await review();
    await act(async () => { window.innerWidth = 900; window.dispatchEvent(new Event('resize')); });
    await user.click(screen.getByRole('button', { name: NAMES.focusVideo }));
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    expect(document.querySelector('.app')).toHaveAttribute('data-sidebar', 'overlay');
    await act(async () => { window.innerWidth = 1280; window.dispatchEvent(new Event('resize')); });
    expect(await screen.findByRole('complementary', { name: NAMES.recordings })).toBeVisible();
    expect(document.querySelector('.app')).toHaveAttribute('data-sidebar', 'docked');
  });
  it('docks the sidebar again after focus even if the window narrowed meanwhile', async () => {
    const user = await review();
    await user.click(screen.getByRole('button', { name: NAMES.focusVideo }));
    await act(async () => { window.innerWidth = 900; window.dispatchEvent(new Event('resize')); });
    await user.click(screen.getByRole('button', { name: NAMES.focusVideo }));
    // No overlay over the sheet in the narrow window…
    expect(document.querySelector('.app')).not.toHaveAttribute('data-sidebar', 'overlay');
    // …and the sidebar is beside the sheet again once the window widens.
    await act(async () => { window.innerWidth = 1280; window.dispatchEvent(new Event('resize')); });
    expect(await screen.findByRole('complementary', { name: NAMES.recordings })).toBeVisible();
    expect(document.querySelector('.app')).toHaveAttribute('data-sidebar', 'docked');
  });
  it('restores both sidebars when focus ends', async () => {
    const user = await review();
    const focus = screen.getByRole('button', { name: NAMES.focusVideo });
    await user.click(focus);
    await user.click(focus);
    expect(await screen.findByRole('complementary', { name: NAMES.recordings })).toBeVisible();
    expect(document.querySelector('.cr-transcript-column')).toBeInTheDocument();
    expect(focus).toHaveAttribute('aria-pressed', 'false');
    // Escape ends focus too.
    await user.click(focus);
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('complementary', { name: NAMES.recordings })).toBeVisible();
    expect(document.querySelector('.cr-transcript-column')).toBeInTheDocument();
    // A sidebar the person had hidden stays hidden.
    await user.click(screen.getByRole('button', { name: NAMES.hideSidebar }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument());
    await user.click(focus); await user.click(focus);
    expect(document.querySelector('.cr-transcript-column')).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument();
    // Showing the sidebar while focused ends focus.
    await user.click(focus);
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    expect(await screen.findByRole('complementary', { name: NAMES.recordings })).toBeVisible();
    expect(document.querySelector('.cr-transcript-column')).toBeInTheDocument();
    expect(focus).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('layout', () => {
  it('auto-hides the sidebar below 1000px and shows it over the sheet until a recording opens', async () => {
    window.innerWidth = 900;
    const user = await ready();
    await waitFor(() => expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    expect(document.querySelector('.app')).toHaveAttribute('data-sidebar', 'overlay');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    await open(user);
    await screen.findByRole('button', { name: 'Seek to here at 0:02' });
    await waitFor(() => expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument());
    await act(async () => { window.innerWidth = 1280; window.dispatchEvent(new Event('resize')); });
    expect(document.querySelector('.app')).toHaveAttribute('data-sidebar', 'docked');
    expect(sidebar().getByRole('button', { name: 'Review Alpha' })).toBeVisible();
  });
  it('slides the sidebar out and in', async () => {
    const user = await review();
    const app = document.querySelector('.app');
    expect(app).toHaveAttribute('data-sidebar-motion', 'slide');
    // Opening the app does not slide.
    expect(document.querySelector('.app-sidebar-slot')).toHaveAttribute('data-state', 'open');
    await user.click(screen.getByRole('button', { name: NAMES.hideSidebar }));
    const slot = document.querySelector('.app-sidebar-slot');
    expect(slot).toHaveAttribute('data-state', 'exiting');
    expect(slot).toHaveAttribute('inert');
    expect(app).toHaveAttribute('data-sidebar', 'docked');
    await waitFor(() => expect(document.querySelector('.app-sidebar-slot')).not.toBeInTheDocument());
    expect(app).toHaveAttribute('data-sidebar', 'hidden');
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    await waitFor(() => expect(document.querySelector('.app-sidebar-slot')).toHaveAttribute('data-state', 'open'));
    expect(document.querySelector('.app-sidebar-slot')).not.toHaveAttribute('inert');
  });
  it('slides the sidebar over the sheet in a narrow window', async () => {
    window.innerWidth = 900;
    const user = await ready();
    // Opening a recording from the overlay hides it again.
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    await open(user);
    await screen.findByRole('button', { name: 'Seek to here at 0:02' });
    await waitFor(() => expect(document.querySelector('.app-sidebar-slot')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    expect(document.querySelector('.app-sidebar-slot')).toHaveAttribute('data-state', 'entering');
    await waitFor(() => expect(document.querySelector('.app-sidebar-slot')).toHaveAttribute('data-state', 'open'));
    expect(document.querySelector('.app')).toHaveAttribute('data-sidebar', 'overlay');
    await user.keyboard('{Escape}');
    expect(document.querySelector('.app-sidebar-slot')).toHaveAttribute('data-state', 'exiting');
    // It leaves over the sheet: the layout stays the overlay until it is gone.
    expect(document.querySelector('.app')).toHaveAttribute('data-sidebar', 'overlay');
    await waitFor(() => expect(document.querySelector('.app-sidebar-slot')).not.toBeInTheDocument());
  });
  it('hides the sidebar at once beside live video', async () => {
    // A new recording shows its source's live preview.
    const user = await ready();
    expect(document.querySelector('.app')).toHaveAttribute('data-sidebar-motion', 'instant');
    await user.click(screen.getByRole('button', { name: NAMES.hideSidebar }));
    expect(document.querySelector('.app-sidebar-slot')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    expect(document.querySelector('.app-sidebar-slot')).toHaveAttribute('data-state', 'open');
    // And while recording.
    await user.keyboard('{Control>}r{/Control}');
    expect(await screen.findByRole('button', { name: NAMES.stop })).toBeEnabled();
    expect(document.querySelector('.app')).toHaveAttribute('data-sidebar-motion', 'instant');
    await user.click(screen.getByRole('button', { name: NAMES.hideSidebar }));
    expect(document.querySelector('.app-sidebar-slot')).not.toBeInTheDocument();
  });
  it('hides the sidebar at once under reduced motion', async () => {
    document.documentElement.dataset.motion = 'reduced';
    try {
      const user = await review();
      await user.click(screen.getByRole('button', { name: NAMES.hideSidebar }));
      expect(document.querySelector('.app-sidebar-slot')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
      expect(document.querySelector('.app-sidebar-slot')).toHaveAttribute('data-state', 'open');
    } finally { delete document.documentElement.dataset.motion; }
  });
  it('puts the collapse control in the sidebar panel only on macOS, beside the toolbar', async () => {
    const user = await ready({ platform: 'macos' });
    expect(screen.getByRole('banner', { name: NAMES.toolbar })).toBeVisible();
    expect(screen.queryByRole('button', { name: NAMES.minimizeWindow })).not.toBeInTheDocument();
    await user.click(sidebar().getByRole('button', { name: NAMES.hideSidebar }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    expect(sidebar().getByRole('button', { name: 'Review Alpha' })).toBeVisible();
  });
  it('keeps native window controls on Linux', async () => {
    await ready({ platform: 'linux' });
    expect(screen.getByRole('banner', { name: NAMES.toolbar })).toBeVisible();
    expect(screen.queryByRole('button', { name: NAMES.closeWindow })).not.toBeInTheDocument();
    expect(sidebar().queryByRole('button', { name: NAMES.hideSidebar })).not.toBeInTheDocument();
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
    // The minimum size drops before the window shrinks (the old minimum would block it), then it floats.
    expectCallOrder(windowApi.setMinSize, windowApi.setSize, windowApi.setAlwaysOnTop);
    // The dock moves into the compact layout; focus follows from Compact to Expand.
    expect(screen.getByRole('button', { name: NAMES.expand })).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument());
    expect(screen.queryByRole('region', { name: NAMES.transcript })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('banner', { name: NAMES.titleBar })).toBeVisible();
    expect(screen.getByRole('button', { name: NAMES.stop })).toBeVisible();
    await user.click(screen.getByRole('button', { name: NAMES.expand })); await screen.findByRole('button', { name: NAMES.compact });
    expect(windowApi.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(windowApi.setSize).toHaveBeenLastCalledWith({ width: 1280, height: 820 });
    expect(windowApi.setMinSize).toHaveBeenLastCalledWith({ width: 640, height: 480 });
    // Restoring: it stops floating, grows back, and only then takes the full minimum size again.
    expectCallOrder(windowApi.setAlwaysOnTop, windowApi.setSize, windowApi.setMinSize);
    await user.click(screen.getByRole('button', { name: NAMES.compact })); await screen.findByRole('button', { name: NAMES.expand });
    await user.click(screen.getByRole('button', { name: NAMES.stop }));
    await waitFor(() => expect(windowApi.setAlwaysOnTop.mock.calls.map(call => call[0])).toEqual([true, false, true, false]));
    await waitFor(() => expect(windowApi.setMinSize).toHaveBeenLastCalledWith({ width: 640, height: 480 }));
    expectCallOrder(windowApi.setAlwaysOnTop, windowApi.setSize, windowApi.setMinSize);
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
    expect(liveWord).toHaveAttribute('aria-disabled', 'true');
    expect(liveWord).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('timer', { name: NAMES.takeTimer(1) })).toHaveTextContent('00:08');
    await user.click(liveWord);
    expect(screen.getByRole('button', { name: NAMES.stop })).toBeEnabled();
    expect(document.querySelector('video')).toBeNull();
    expect(backend.stop).not.toHaveBeenCalled();
    expect(backend.start).toHaveBeenCalledTimes(1);
    status = { ...status, elapsedMs: 16000, liveTranscript: { segments: [...liveTranscript.segments, { startMs: 12000, endMs: 14000, text: 'Next batch', words: [{ text: 'Next', startMs: 12000, endMs: 13000 }, { text: 'batch', startMs: 13000, endMs: 14000 }] }] } };
    await poll();
    expect(await screen.findByRole('button', { name: 'Seek to batch at 0:13' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: NAMES.stop })).toBeEnabled();
  });
  it('starts a new recording with the display and microphone chosen in the recording bar', async () => {
    backend.sources.mockResolvedValue([{ id: 'display1', name: 'Display 1', kind: 'display', available: true }, { id: 'display2', name: 'Display 2', kind: 'display', available: true }]);
    const user = await ready();
    const bar = within(screen.getByRole('group', { name: NAMES.recordingBar }));
    await user.click(bar.getByRole('button', { name: 'Display 1' }));
    await chooseSource(user, 'Display 2');
    await user.click(bar.getByRole('button', { name: 'Studio microphone' }));
    await chooseMicrophone(user, 'mic2');
    expect(bar.getByRole('button', { name: 'Display 2' })).toBeVisible();
    expect(bar.getByRole('button', { name: 'Headset microphone' })).toBeVisible();
    await user.click(bar.getByRole('button', { name: NAMES.record }));
    await screen.findByRole('button', { name: NAMES.stop });
    expect(backend.start).toHaveBeenCalledOnce();
    expect(backend.start).toHaveBeenCalledWith(null, null, 'display2', 'mic2', false, false);
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
  it('pauses the video before recording a take, shows it live, and plays the new take once processing ends', async () => {
    const user = await review();
    const media = document.querySelector('video')!;
    expect(media).toHaveAttribute('src', 'asset://C:/recordings/video.mp4');
    const pause = vi.mocked(HTMLMediaElement.prototype.pause); pause.mockClear();
    backend.recordMore.mockImplementationOnce(async (id: string) => {
      // No file is replaced, so the video stays loaded; it pauses, so its sound is not recorded.
      expect(pause.mock.contexts).toContain(media);
      expect(media).toHaveAttribute('src', 'asset://C:/recordings/video.mp4');
      return recordTakeTwo(id);
    });
    await user.click(screen.getByRole('button', { name: NAMES.recordMore }));
    expect(await screen.findByRole('timer', { name: NAMES.takeTimer(2) })).toHaveTextContent(/^00:00$/);
    expect(backend.recordMore).toHaveBeenCalledWith('s1', 'display1', 'mic1', false, false);
    // The stage shows the source live while the take records.
    expect(document.querySelector('video')).toBeNull();
    expect(screen.getByRole('button', { name: NAMES.copyForAgent })).toBeDisabled();
    expect(screen.getByRole('button', { name: NAMES.newSession })).toBeDisabled();
    // Sections cannot change while recording: the sidebar's menu opens with its items disabled.
    fireEvent.contextMenu(document.querySelector('.recording-list')!);
    expect(screen.getByRole('menuitem', { name: NAMES.newSection })).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Escape}');
    expect(transcriptPane().getByText('Take 2 · recording')).toBeVisible();
    expect(screen.queryByText(/Adding to this session/)).not.toBeInTheDocument();

    // The live tail of take 2 sits on the session timeline after the saved take 1.
    status = { ...status, elapsedMs: 3000, liveTranscript: { segments: [{ startMs: 11000, endMs: 12500, text: 'More words', words: [{ text: 'More', startMs: 11000, endMs: 11600 }, { text: 'words', startMs: 11600, endMs: 12500 }] }] } };
    await poll();
    expect(await screen.findByRole('button', { name: 'Seek to More at 0:11' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Seek to here at 0:02' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('timer', { name: NAMES.takeTimer(2) })).toHaveTextContent('00:03');

    // Stop returns while take 2's video is still being finished.
    backend.stop.mockImplementationOnce(async () => { const next = takeTwo(newSession(), 'finalizing'); sessions = [next]; status = { state: 'processing', sessionId: 's1', takeIndex: 2, takeOffsetMs: 10000 }; return next; });
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
    // Take 1's video loads as it was, with no version; the timeline runs over both takes.
    await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'asset://C:/recordings/video.mp4'));
    expect(screen.getByLabelText(NAMES.playbackPosition)).toHaveAttribute('max', '20000');
    expect(transcriptPane().getByText('Take 2 · 0:10')).toBeVisible();
    // A word of the new take plays the new take's own video.
    await user.click(screen.getByRole('button', { name: 'Seek to More at 0:11' }));
    expect(document.querySelector('video')).toHaveAttribute('src', 'asset://C:/recordings/takes/2/video.mp4');
    expect(screen.getByRole('button', { name: NAMES.recordMore })).toBeEnabled();
    expect(screen.getByRole('button', { name: NAMES.copyForAgent })).toBeEnabled();
  });
  it('keeps the recording loaded where it was when Record more fails', async () => {
    const user = await review();
    await user.click(screen.getByRole('button', { name: 'Seek to here at 0:02' }));
    const media = document.querySelector('video')!;
    backend.recordMore.mockRejectedValueOnce('Record more needs a playable recording.');
    await user.click(screen.getByRole('button', { name: NAMES.recordMore }));
    expect(await within(screen.getByRole('group', { name: NAMES.recordingBar })).findByRole('alert')).toHaveTextContent('Record more needs a playable recording.');
    expect(document.querySelector('video')).toBe(media);
    expect(media).toHaveAttribute('src', 'asset://C:/recordings/video.mp4');
    expect(media.currentTime).toBe(2.5);
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
  it('keeps Record more off while the bar\'s source is unavailable, and says why under the bar', async () => {
    backend.sources.mockResolvedValue([{ id: 'display1', name: 'Display 1', kind: 'display', available: true }, { id: 'quest-offline', name: 'Quest disconnected', kind: 'quest', available: false, detail: 'Reconnect the USB cable and authorize USB debugging on the headset, then refresh.' }]);
    const user = await review();
    const bar = within(screen.getByRole('group', { name: NAMES.recordingBar }));
    await user.click(bar.getByRole('button', { name: 'Display 1' }));
    await chooseSource(user, NAMES.unavailableSource('Quest disconnected'));
    expect(bar.getByRole('button', { name: NAMES.recordMore })).toBeDisabled();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('{Control>}r{/Control}');
    expect(await bar.findByRole('alert')).toHaveTextContent('authorize USB debugging');
    expect(backend.recordMore).not.toHaveBeenCalled();
    expect(document.querySelector('video')).toHaveAttribute('src', 'asset://C:/recordings/video.mp4');
  });
  it('restores a take that is recording after a restart, with its own source and the saved takes before its live tail', async () => {
    const session = takeTwo(newSession());
    session.takes![1].sourceId = 'quest1';
    sessions = [session];
    status = { state: 'recording', sessionId: 's1', elapsedMs: 4000, takeIndex: 2, takeOffsetMs: 10000, liveTranscript: { segments: [{ startMs: 11000, endMs: 12000, text: 'Again', words: [{ text: 'Again', startMs: 11000, endMs: 12000 }] }] } };
    render(<App platform="windows"/>);
    expect(await screen.findByRole('timer', { name: NAMES.takeTimer(2) })).toHaveTextContent('00:04');
    expect(await screen.findByRole('button', { name: 'Seek to Again at 0:11' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Seek to here at 0:02' })).toHaveAttribute('aria-disabled', 'true');
    expect(transcriptPane().getByText('Take 2 · recording')).toBeVisible();
    expect(await within(screen.getByRole('group', { name: NAMES.recordingControls })).findByRole('button', { name: 'Quest USB' })).toBeDisabled();
  });
  it('records more from the bar under the playback controls, with the source and microphone chosen there', async () => {
    backend.sources.mockResolvedValue([{ id: 'display1', name: 'Display 1', kind: 'display', available: true }, figma]);
    backend.recordMore.mockImplementation(recordTakeTwo);
    // Recorded from Quest: opening it leaves the bar on the app's own choice.
    sessions = [{ ...newSession(), sourceId: 'quest1' }];
    const user = await review();
    // The playback row holds no Record more; the recording bar under it does.
    expect(within(screen.getByRole('group', { name: NAMES.playback })).queryByRole('button', { name: NAMES.recordMore })).not.toBeInTheDocument();
    const bar = within(screen.getByRole('group', { name: NAMES.recordingBar }));
    const source = bar.getByRole('button', { name: 'Display 1' });
    expect(source).not.toHaveAttribute('aria-disabled');
    // The source picker opens as in a new recording, with system audio beside the sources.
    await user.click(source);
    await chooseSource(user, figma.name);
    await user.click(bar.getByRole('button', { name: figma.name }));
    await user.click(screen.getByLabelText(NAMES.includeSystemAudio)); await user.keyboard('{Escape}');
    await user.click(bar.getByRole('button', { name: 'Studio microphone' }));
    await chooseMicrophone(user, 'mic2');
    await user.click(bar.getByRole('button', { name: NAMES.recordMore }));
    expect(await screen.findByRole('timer', { name: NAMES.takeTimer(2) })).toBeVisible();
    expect(backend.recordMore).toHaveBeenCalledWith('s1', 'window:42', 'mic2', true, false);
    // While the take records, the dock takes the bar's place and names the window it records.
    expect(screen.queryByRole('group', { name: NAMES.recordingBar })).not.toBeInTheDocument();
    const dock = within(screen.getByRole('group', { name: NAMES.recordingControls }));
    expect(dock.getByRole('button', { name: figma.name })).toBeDisabled();
  });
  it('shows a refusal under the recording bar, with another source or New recording as the way forward', async () => {
    backend.sources.mockResolvedValue([{ id: 'display1', name: 'Display 1', kind: 'display', available: true }, figma]);
    const user = await review();
    const bar = within(screen.getByRole('group', { name: NAMES.recordingBar }));
    await user.click(bar.getByRole('button', { name: 'Display 1' }));
    await chooseSource(user, figma.name);
    // The window closed after it was listed.
    backend.recordMore.mockRejectedValueOnce(WINDOW_CLOSED);
    await user.click(bar.getByRole('button', { name: NAMES.recordMore }));
    const message = await bar.findByRole('alert');
    expect(message).toHaveTextContent(WINDOW_CLOSED);
    // Under the bar only, not repeated in the workspace banner; Record more is described by it.
    expect(screen.getAllByRole('alert')).toEqual([message]);
    expect(bar.getByRole('button', { name: NAMES.recordMore })).toHaveAccessibleDescription(WINDOW_CLOSED);
    // The video stays playable.
    expect(document.querySelector('video')).toHaveAttribute('src', 'asset://C:/recordings/video.mp4');
    expect(screen.getByRole('button', { name: NAMES.play })).toBeEnabled();

    // Dismissing hides it; the next refusal brings it back.
    await user.click(within(message).getByRole('button', { name: NAMES.dismissError }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(bar.getByRole('button', { name: NAMES.recordMore })).toHaveAccessibleDescription('Record more (Ctrl+R): continue this session as a new take');
    backend.recordMore.mockRejectedValueOnce(WINDOW_CLOSED);
    await user.click(screen.getByRole('button', { name: NAMES.recordMore }));
    const again = await bar.findByRole('alert');

    // New recording opens a draft instead.
    await user.click(within(again).getByRole('button', { name: NAMES.newRecording }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(NAMES.newRecording);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: NAMES.record })).toHaveFocus();
    expect(backend.start).not.toHaveBeenCalled();
    // Coming back to the recording starts without the old message, and another source records more.
    await open(user); await screen.findByRole('button', { name: 'Seek to here at 0:02' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const reopened = within(screen.getByRole('group', { name: NAMES.recordingBar }));
    await user.click(reopened.getByRole('button', { name: figma.name }));
    await chooseSource(user, 'Display 1');
    backend.recordMore.mockImplementationOnce(recordTakeTwo);
    await user.click(reopened.getByRole('button', { name: NAMES.recordMore }));
    expect(await screen.findByRole('timer', { name: NAMES.takeTimer(2) })).toBeVisible();
    expect(backend.recordMore).toHaveBeenLastCalledWith('s1', 'display1', 'mic1', false, false);
  });
  it('keeps focus on Record more while its take starts and after a refusal', async () => {
    let refuse!: (reason: string) => void;
    backend.recordMore.mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject; }));
    const user = await review();
    const media = document.querySelector('video');
    const more = screen.getByRole('button', { name: NAMES.recordMore });
    more.focus(); await user.keyboard('{Enter}');
    // The video stays loaded meanwhile, and the pill is only busy: it stays focusable and ignores activation.
    expect(document.querySelector('video')).toBe(media);
    expect(more).toBeEnabled();
    expect(more).toHaveAttribute('aria-disabled', 'true');
    expect(more).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(backend.recordMore).toHaveBeenCalledOnce();
    await act(async () => refuse(WINDOW_CLOSED));
    expect(await within(screen.getByRole('group', { name: NAMES.recordingBar })).findByRole('alert')).toHaveTextContent(WINDOW_CLOSED);
    expect(more).not.toHaveAttribute('aria-disabled');
    expect(more).toHaveFocus();
    expect(more).toHaveAccessibleDescription(WINDOW_CLOSED);
    expect(document.querySelector('video')).toHaveAttribute('src', 'asset://C:/recordings/video.mp4');
  });
});

describe('take playback', () => {
  // Take 1 from a display and take 2 from a window, each in its own video.
  const twoTakes = () => {
    sessions = [takeTwo(newSession(), 'ready')];
    sessions[0].takes![1].sourceId = figma.id;
    transcript = { takes: [{ index: 1, startMs: 0 }, { index: 2, startMs: 10000 }], segments: [...transcript.segments, { id: 't2-line1', startMs: 11000, endMs: 12500, text: 'More words', words: [{ text: 'More', startMs: 11000, endMs: 11600 }, { text: 'words', startMs: 11600, endMs: 12500 }] }] };
  };
  const TAKE_ONE = 'asset://C:/recordings/video.mp4';
  const TAKE_TWO = 'asset://C:/recordings/takes/2/video.mp4';
  const position = () => screen.getByLabelText(NAMES.playbackPosition);
  /** jsdom media never plays: this says whether the element is paused, as a playing video would. */
  const setPaused = (media: HTMLMediaElement, paused: boolean) => Object.defineProperty(media, 'paused', { configurable: true, get: () => paused });
  /** The video reaches its end: it pauses as ended, then fires ended. */
  const finish = (media: HTMLMediaElement) => {
    Object.defineProperty(media, 'ended', { configurable: true, get: () => true });
    setPaused(media, true); fireEvent.pause(media); fireEvent.ended(media);
    Object.defineProperty(media, 'ended', { configurable: true, get: () => false });
  };

  it('plays on from one take\'s video into the next', async () => {
    twoTakes();
    const user = await review();
    const media = document.querySelector('video')!;
    expect(media).toHaveAttribute('src', TAKE_ONE);
    fireEvent.loadedMetadata(media);
    // The time and the scrubber run over the session, not take 1's video alone.
    expect(position()).toHaveAttribute('max', '20000');
    expect(screen.getByRole('group', { name: NAMES.playback })).toHaveTextContent('/ 0:20');
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    await user.click(screen.getByRole('button', { name: NAMES.play }));
    fireEvent.play(media); setPaused(media, false);
    media.currentTime = 9.5; fireEvent.timeUpdate(media);
    expect(position()).toHaveValue('9500');

    // Take 1's video ends: the same player loads take 2's and plays it from its start.
    play.mockClear();
    finish(media);
    expect(document.querySelector('video')).toBe(media);
    expect(media).toHaveAttribute('src', TAKE_TWO);
    expect(position()).toHaveValue('10000');
    media.currentTime = 7; fireEvent.loadedMetadata(media);
    expect(media.currentTime).toBe(0);
    expect(play.mock.contexts).toEqual([media]);
    fireEvent.play(media); setPaused(media, false);
    media.currentTime = 1.5; fireEvent.timeUpdate(media);
    expect(position()).toHaveValue('11500');
    expect(screen.getByRole('group', { name: NAMES.playback })).toHaveTextContent('0:11 / 0:20');
    expect(screen.getByRole('button', { name: 'Seek to More at 0:11' })).toHaveAttribute('aria-current', 'true');

    // The last take's end ends playback.
    finish(media);
    expect(media).toHaveAttribute('src', TAKE_TWO);
    expect(screen.getByRole('button', { name: NAMES.play })).toBeEnabled();
    expect(play.mock.calls).toHaveLength(1);

    // Paused at take 1's end by a seek, the next take shows without playing.
    fireEvent.change(position(), { target: { value: '9999' } });
    fireEvent.loadedMetadata(media);
    finish(media);
    expect(media).toHaveAttribute('src', TAKE_TWO);
    fireEvent.loadedMetadata(media);
    expect(play.mock.calls).toHaveLength(1);
  });
  it('seeks into another take\'s video from the scrubber and the transcript', async () => {
    twoTakes();
    const user = await review();
    const media = document.querySelector('video')!;
    fireEvent.loadedMetadata(media);
    // Playing take 1.
    fireEvent.play(media); setPaused(media, false);
    const play = vi.mocked(HTMLMediaElement.prototype.play); play.mockClear();

    // A word of take 2 loads take 2's video at that moment, and playback goes on.
    await user.click(screen.getByRole('button', { name: 'Seek to More at 0:11' }));
    expect(media).toHaveAttribute('src', TAKE_TWO);
    expect(position()).toHaveValue('11000');
    // Until it has loaded, the old video's time does not move the playhead.
    media.currentTime = 0; fireEvent.timeUpdate(media);
    expect(position()).toHaveValue('11000');
    fireEvent.loadedMetadata(media);
    expect(media.currentTime).toBe(1);
    expect(play).toHaveBeenCalledOnce();

    // Inside the loaded take, the scrubber moves its own video.
    fireEvent.change(position(), { target: { value: '12000' } });
    expect(media).toHaveAttribute('src', TAKE_TWO);
    expect(media.currentTime).toBe(2);

    // The scrubber back into take 1 shows take 1's video again, still playing.
    fireEvent.change(position(), { target: { value: '2500' } });
    expect(media).toHaveAttribute('src', TAKE_ONE);
    fireEvent.loadedMetadata(media);
    expect(media.currentTime).toBe(2.5);
    expect(position()).toHaveValue('2500');
    expect(play).toHaveBeenCalledTimes(2);

    // Pausing while another take's video loads keeps it paused once it is in.
    await user.click(screen.getByRole('button', { name: 'Seek to More at 0:11' }));
    expect(media).toHaveAttribute('src', TAKE_TWO);
    // A new source leaves the element paused, with no pause event.
    setPaused(media, true);
    await user.click(screen.getByRole('button', { name: NAMES.pause }));
    expect(screen.getByRole('button', { name: NAMES.play })).toBeEnabled();
    fireEvent.loadedMetadata(media);
    expect(play).toHaveBeenCalledTimes(2);
    fireEvent.change(position(), { target: { value: '2500' } });
    fireEvent.loadedMetadata(media);

    // Paused, a seek into take 2 shows that moment without playing.
    setPaused(media, true); fireEvent.pause(media);
    fireEvent.change(position(), { target: { value: '15000' } });
    expect(media).toHaveAttribute('src', TAKE_TWO);
    fireEvent.loadedMetadata(media);
    expect(media.currentTime).toBe(5);
    expect(play).toHaveBeenCalledTimes(2);
  });
  it('opens a search result in the take video its line falls in', async () => {
    twoTakes();
    const user = await ready();
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: NAMES.search });
    await user.type(within(dialog).getByRole('combobox'), 'more words');
    const line = await within(dialog).findByRole('option', { name: /More words/ });
    await waitFor(() => expect(line).toHaveAttribute('aria-selected', 'true'));
    await user.keyboard('{Enter}');
    await screen.findByRole('button', { name: 'Seek to More at 0:11' });
    const media = document.querySelector('video')!;
    // Take 1's video loads first; the line at 0:11 is in take 2's, shown paused at that moment.
    fireEvent.loadedMetadata(media);
    expect(media).toHaveAttribute('src', TAKE_TWO);
    fireEvent.loadedMetadata(media);
    expect(media.currentTime).toBe(1);
    expect(position()).toHaveValue('11000');
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
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
  it('keeps Retry off while another recording transcribes, because the runtime takes one job at a time', async () => {
    sessions = [{ ...newSession(), status: 'error', error: 'Speech model not found' }, { ...newSession('s2'), projectId: null, name: 'Second recording', status: 'processing' }];
    transcript = { segments: [], error: 'Speech model not found' };
    status = { state: 'processing', sessionId: 's2' };
    const user = await loaded(); await open(user);
    expect(await transcriptPane().findByText('Speech model not found')).toBeVisible();
    const retry = transcriptPane().getByRole('button', { name: NAMES.retryTranscription });
    expect(retry).toBeDisabled();
    await user.click(retry);
    expect(backend.retry).not.toHaveBeenCalled();
    // Once that job ends, Retry works again.
    sessions = sessions.map(item => item.id === 's2' ? { ...item, status: 'ready' } : item); status = { state: 'idle' };
    await poll();
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);
    expect(backend.retry).toHaveBeenCalledWith('s1');
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
    expect(image).toHaveAttribute('src', 'http://127.0.0.1:9999/quest?view=1');
    await act(async () => resolveOld({ id: 'old', url: 'http://127.0.0.1:9999/old' }));
    expect(image).toHaveAttribute('src', 'http://127.0.0.1:9999/quest?view=1');
  });
  it('reconnects a dropped preview image to the same stream, and Retry restarts a failed one', async () => {
    const user = await ready();
    await screen.findByRole('img', { name: 'Live preview of Display 1' });
    const image = () => screen.getByRole('img', { name: 'Live preview of Display 1' });
    expect(image()).toHaveAttribute('src', 'http://127.0.0.1:9999/live?view=1');
    const onDrop = backend.preview.mock.calls[0][3] as (view: string) => void;
    act(() => onDrop('1'));
    await waitFor(() => expect(image()).toHaveAttribute('src', 'http://127.0.0.1:9999/live?view=2'));
    expect(backend.preview).toHaveBeenCalledTimes(1);
    fireEvent.error(image());
    await waitFor(() => expect(image()).toHaveAttribute('src', 'http://127.0.0.1:9999/live?view=3'));
    act(() => backend.preview.mock.calls[0][2]('Preview stream ended. Reconnect the source and select it again.'));
    await screen.findByText('Preview stream ended. Reconnect the source and select it again.');
    await user.click(screen.getByRole('button', { name: NAMES.retryPreview }));
    expect(await screen.findByRole('img', { name: 'Live preview of Display 1' })).toHaveAttribute('src', 'http://127.0.0.1:9999/live?view=4');
    expect(backend.preview).toHaveBeenCalledTimes(2);
  });
  it('does not let an old session response replace a newly prepared recording', async () => {
    let resolveOld!: (value: Session) => void; backend.session.mockImplementationOnce(() => new Promise<Session>(resolve => { resolveOld = resolve; }));
    const user = await ready(); await open(user);
    await user.click(sidebar().getByRole('button', { name: NAMES.newSession }));
    await act(async () => resolveOld(newSession()));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(NAMES.newRecording);
    expect(screen.getByRole('button', { name: NAMES.record })).toBeEnabled();
  });
});

describe('reload keys, device readiness and request races', () => {
  it('never lets Ctrl+R or F5 reach the webview, in a field, a picker or a dialog, and records with the physical R key', async () => {
    const user = await ready();
    const search = textField();
    expect(press(search, { key: 'r', code: 'KeyR', ctrlKey: true })).toBe(true);
    expect(press(search, { key: 'F5', code: 'F5' })).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Display 1' }));
    const option = within(screen.getByRole('group', { name: NAMES.captureSources })).getByRole('button', { name: 'Display 1' });
    expect(press(option, { key: 'r', code: 'KeyR', ctrlKey: true })).toBe(true);
    expect(press(option, { key: 'F5', code: 'F5', ctrlKey: true })).toBe(true);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: NAMES.settings }));
    const close = screen.getByRole('button', { name: NAMES.closeSettings });
    expect(press(close, { key: 'r', code: 'KeyR', ctrlKey: true })).toBe(true);
    expect(press(close, { key: 'F5', code: 'F5' })).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(backend.start).not.toHaveBeenCalled();
    // A Russian layout types "к" on the R key; the shortcut still records and the reload is still swallowed.
    let prevented = false;
    act(() => { prevented = press(document.body, { key: 'к', code: 'KeyR', ctrlKey: true }); });
    expect(prevented).toBe(true);
    expect(await screen.findByRole('button', { name: NAMES.stop })).toBeEnabled();
    expect(backend.start).toHaveBeenCalledOnce();
  });

  it('keeps Record more off until devices have loaded, so a take never records without its microphone', async () => {
    let listMicrophones!: (value: Microphone[]) => void;
    backend.microphones.mockImplementationOnce(() => new Promise<Microphone[]>(resolve => { listMicrophones = resolve; }));
    backend.recordMore.mockImplementation(async (id: string) => { sessions = sessions.map(item => item.id === id ? takeTwo(item) : item); status = { state: 'recording', sessionId: id, elapsedMs: 0, takeIndex: 2, takeOffsetMs: 10000 }; return takeTwo(newSession(id)); });
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const user = userEvent.setup(); render(<App platform="windows"/>);
    await user.click(await sidebar().findByRole('button', { name: 'Review Alpha' }));
    await screen.findByRole('button', { name: 'Seek to here at 0:02' });
    const more = screen.getByRole('button', { name: NAMES.recordMore });
    expect(more).toBeDisabled();
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.recordMore).not.toHaveBeenCalled();
    await act(async () => listMicrophones([{ id: 'mic1', name: 'Studio microphone' }, { id: 'mic2', name: 'Headset microphone' }]));
    await waitFor(() => expect(more).toBeEnabled());
    await user.click(more);
    expect(await screen.findByRole('timer', { name: NAMES.takeTimer(2) })).toBeVisible();
    expect(backend.recordMore).toHaveBeenCalledWith('s1', 'display1', 'mic1', false, false);
  });

  it('attributes a background transcription to its own recording, not to the one that is open', async () => {
    const user = await ready();
    await user.click(screen.getByRole('button', { name: NAMES.record })); await screen.findByRole('button', { name: NAMES.stop });
    await user.click(screen.getByRole('button', { name: NAMES.stop })); await transcriptPane().findByText('Processing');
    expect(sidebar().getByRole('button', { name: 'New recording, processing' })).toBeVisible();
    await open(user);
    await screen.findByRole('button', { name: 'Seek to here at 0:02' });
    expect(transcriptPane().queryByText('Processing')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: NAMES.copyForAgent })).toBeEnabled();
    expect(within(screen.getByRole('heading', { level: 1 })).getByRole('button', { name: 'Review Alpha' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Finishing your recording' })).not.toBeInTheDocument();
    // The runtime still takes one job at a time, so a new capture waits for that transcription.
    expect(screen.getByRole('button', { name: NAMES.recordMore })).toBeDisabled();
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.recordMore).not.toHaveBeenCalled();
  });

  it('drops a poll response for a recording the user has already left', async () => {
    sessions = [{ ...newSession(), status: 'processing' }, { ...newSession('s2'), projectId: null, name: 'Second recording' }];
    status = { state: 'processing', sessionId: 's1' };
    const texts: Record<string, Transcript> = {
      s1: { segments: [{ startMs: 0, endMs: 1000, text: 'Alpha words', words: [{ text: 'Alpha', startMs: 0, endMs: 500 }, { text: 'words', startMs: 500, endMs: 1000 }] }] },
      s2: { segments: [{ startMs: 0, endMs: 1000, text: 'Beta words', words: [{ text: 'Beta', startMs: 0, endMs: 500 }, { text: 'words', startMs: 500, endMs: 1000 }] }] },
    };
    backend.transcript.mockImplementation(async (id: string) => structuredClone(texts[id]));
    const user = await loaded();
    await open(user);
    await transcriptPane().findByText('Processing');
    // The recording finishes, but the poll's read of it is held back...
    let releasePoll!: () => void; const pollGate = new Promise<void>(resolve => { releasePoll = resolve; });
    let releaseOpen!: () => void; const openGate = new Promise<void>(resolve => { releaseOpen = resolve; });
    sessions = sessions.map(item => item.id === 's1' ? { ...item, status: 'ready' } : item); status = { state: 'idle' };
    backend.session.mockReset();
    backend.session.mockImplementation(async (id: string) => { await (id === 's1' ? pollGate : openGate); return structuredClone(sessions.find(item => item.id === id)!); });
    await waitFor(() => expect(backend.session).toHaveBeenCalledWith('s1'), { timeout: 2000 });
    // ...while the user opens another recording. Both answers then arrive before React renders.
    await user.click(sidebar().getByRole('button', { name: 'Second recording' }));
    await act(async () => {
      releaseOpen();
      await new Promise(resolve => setTimeout(resolve, 0));
      releasePoll();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Second recording');
    expect(screen.getByRole('button', { name: 'Seek to Beta at 0:00' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Seek to Alpha at 0:00' })).not.toBeInTheDocument();
  });

  it('still shows a finished recording when its transcript cannot be read yet', async () => {
    sessions = [{ ...newSession(), status: 'processing' }]; status = { state: 'processing', sessionId: 's1' };
    const user = await loaded(); await open(user);
    await transcriptPane().findByText('Processing');
    sessions = [newSession()]; status = { state: 'idle' };
    backend.transcript.mockRejectedValue('The transcript is still being written.');
    await poll();
    expect(await screen.findByRole('alert')).toHaveTextContent('The transcript is still being written.');
    await waitFor(() => expect(transcriptPane().queryByText('Processing')).not.toBeInTheDocument());
    expect(document.querySelector('video')).toHaveAttribute('src', 'asset://C:/recordings/video.mp4');
    expect(screen.getByRole('button', { name: NAMES.recordMore })).toBeEnabled();
  });

  it('reports a failing poll once and polls less often until the backend answers', async () => {
    await ready();
    backend.status.mockRejectedValue('The recorder stopped answering.');
    const before = backend.status.mock.calls.length;
    await poll();
    expect(await screen.findByRole('alert')).toHaveTextContent('The recorder stopped answering.');
    fireEvent.click(screen.getByRole('button', { name: NAMES.dismissError }));
    await poll(); await poll();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // A poll every 700 ms would have asked three or four times by now; the back-off asks twice.
    expect(backend.status.mock.calls.length - before).toBeLessThanOrEqual(2);
  });
});

describe('dialogs, focus and announcements', () => {
  it('keeps a workspace error out of dialogs and shows a dialog failure inside the dialog', async () => {
    const user = await ready();
    backend.start.mockRejectedValueOnce('USB device disconnected.');
    await user.click(screen.getByRole('button', { name: NAMES.record }));
    expect(await screen.findByRole('alert')).toHaveTextContent('USB device disconnected.');
    await newSection(user);
    const dialog = screen.getByRole('dialog', { name: NAMES.newSection });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    backend.createProject.mockRejectedValueOnce('A section with that name already exists.');
    await user.type(screen.getByLabelText(NAMES.nameField), 'Beta'); await user.click(screen.getByRole('button', { name: NAMES.save }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A section with that name already exists.');
    await user.click(screen.getByRole('button', { name: NAMES.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('USB device disconnected.');
    await user.click(screen.getByRole('button', { name: NAMES.settings }));
    expect(screen.getByRole('dialog', { name: NAMES.settingsDialog })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('moves focus to the counterpart toggle when the macOS sidebar hides or shows', async () => {
    const user = await ready({ platform: 'macos' });
    sidebar().getByRole('button', { name: NAMES.hideSidebar }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: NAMES.showSidebar })).toHaveFocus());
    await user.keyboard('{Enter}');
    expect(sidebar().getByRole('button', { name: NAMES.hideSidebar })).toHaveFocus();
  });

  it('returns focus to the sidebar toggle when a recording opens from the narrow overlay', async () => {
    window.innerWidth = 900;
    const user = await ready();
    await user.click(screen.getByRole('button', { name: NAMES.showSidebar }));
    sidebar().getByRole('button', { name: 'Review Alpha' }).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('button', { name: 'Seek to here at 0:02' });
    await waitFor(() => expect(screen.queryByRole('complementary', { name: NAMES.recordings })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: NAMES.showSidebar })).toHaveFocus());
  });

  it('keeps focus on a control that is busy for a moment', async () => {
    let handoff!: (text: string) => void;
    backend.handoff.mockImplementationOnce(() => new Promise<string>(resolve => { handoff = resolve; }));
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const user = await review();
    const copy = screen.getByRole('button', { name: NAMES.copyForAgent });
    copy.focus(); await user.keyboard('{Enter}');
    expect(copy).toHaveAttribute('aria-disabled', 'true');
    expect(copy).toHaveFocus();
    expect(screen.getByRole('button', { name: NAMES.recordMore })).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Enter}');
    expect(backend.handoff).toHaveBeenCalledOnce();
    await act(async () => handoff('Handoff text'));
    expect(copy).not.toHaveAttribute('aria-disabled');
    expect(copy).toHaveFocus();
  });

  it('moves focus from Record to Stop, and into the workspace once Stop has gone', async () => {
    let started!: () => void;
    const original = backend.start.getMockImplementation()!;
    backend.start.mockImplementationOnce((...args: unknown[]) => new Promise(resolve => { started = () => resolve(original(...args)); }));
    const user = await ready();
    const record = screen.getByRole('button', { name: NAMES.record });
    record.focus(); await user.keyboard('{Enter}');
    expect(record).toHaveAttribute('aria-disabled', 'true');
    expect(record).toHaveFocus();
    await act(async () => started());
    const stop = await screen.findByRole('button', { name: NAMES.stop });
    expect(stop).toHaveFocus();
    await user.keyboard('{Enter}');
    await transcriptPane().findByText('Processing');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('announces notices through a live region that is always mounted', async () => {
    const user = await review();
    const region = document.querySelector('.app-toast-region')!;
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toBeEmptyDOMElement();
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await user.click(screen.getByRole('button', { name: NAMES.copyForAgent }));
    await waitFor(() => expect(region).toHaveTextContent('Agent instructions copied'));
    expect(document.querySelector('.app-toast-region')).toBe(region);
  });
});
