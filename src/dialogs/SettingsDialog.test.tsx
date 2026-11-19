import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { ReactElement } from 'react';
import type { LanguageModel, Settings, SetupStatus, SpeechDevice } from '../backend';
import type { WindowTheme } from '../chrome/windowApi';
import { SPEECH_LANGUAGES } from '../stories/fixtures';
import { estimateTokens, FONT_CREDIT, normalizeVocabulary, SettingsDialog } from './SettingsDialog';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));

const tools = ['ffmpeg', 'ffprobe', 'whisper-cli', 'whisper-vad-speech-segments', 'adb', 'scrcpy'];
const ready: SetupStatus = { ready: true, issues: [], modelReady: true, dependencies: tools.map(name => ({ name, available: true, path: `C:\\tools\\${name}.exe` })) };

type HarnessProps = { initial?: Settings | null; setup?: SetupStatus | null; installing?: boolean; error?: string; save?: (settings: Settings) => Promise<Settings> };
function Harness({ initial = {}, setup = ready, installing = false, error, save = async settings => settings }: HarnessProps) {
  const [settings, setSettings] = useState<Settings | null>(initial);
  const [theme, setTheme] = useState<WindowTheme>('light');
  return <SettingsDialog open onClose={handlers.close} theme={theme} onTheme={next => { handlers.theme(next); setTheme(next); }}
    setup={setup} installing={installing} onInstall={handlers.install} onCheckAgain={handlers.checkAgain}
    onPollLanguageModels={() => handlers.poll()} onDownloadLanguageModels={async () => { await handlers.download(); }}
    onPollSpeechDevice={() => handlers.pollDevice()} onTestSpeechDevices={async () => { await handlers.test(); }} languages={SPEECH_LANGUAGES}
    settings={settings} onSaveSettings={async next => { handlers.save(next); setSettings(await save(next)); }} error={error}/>;
}
const handlers = { close: vi.fn(), theme: vi.fn(), install: vi.fn(), checkAgain: vi.fn(), poll: vi.fn(), download: vi.fn(), save: vi.fn(), pollDevice: vi.fn(), test: vi.fn() };

beforeEach(() => {
  document.documentElement.dataset.motion = 'reduced';
  for (const handler of Object.values(handlers)) handler.mockReset();
  handlers.poll.mockResolvedValue(undefined);
  handlers.pollDevice.mockResolvedValue(undefined);
});
afterEach(() => { delete document.documentElement.dataset.motion; vi.unstubAllGlobals(); vi.useRealTimers(); });

const field = () => screen.getByRole('textbox', { name: 'Vocabulary' });
/** The Recording tools row of a capability, apart from the Transcription section's heading. */
const toolRow = (label: string) => within(screen.getByRole('region', { name: 'Recording tools' })).getByText(label).parentElement;
const TOTAL = { 'small.en': 487_614_201, small: 487_601_967, 'large-v3-turbo': 1_624_555_275 };
/** A model's state; ready and whole unless told otherwise. */
const model = (name: LanguageModel['model'], state: Partial<LanguageModel> = {}): LanguageModel => ({ model: name, state: 'ready', receivedBytes: TOTAL[name], totalBytes: TOTAL[name], ...state });
const withModels = (...models: LanguageModel[]): SetupStatus => ({ ...ready, languageModels: models });
/** Auto's two models, ready unless told otherwise. */
const auto = (english: Partial<LanguageModel> = {}, multilingual: Partial<LanguageModel> = {}) => withModels(model('small.en', english), model('small', multilingual));
const transcription = () => within(screen.getByRole('region', { name: 'Transcription' }));
const modelRow = (name: 'English' | 'Multilingual' | 'Large') => transcription().getByText(`${name} model`).parentElement;

const CARD = 'NVIDIA GeForce RTX 5090';
/** A graphics card fast enough for Large, transcribing; changed where told. */
const fastCard = (facts: Partial<SpeechDevice> = {}): SpeechDevice => ({ state: 'ready', kind: 'graphicsCard', name: CARD, card: { name: CARD, stopped: false }, largeOffered: true, largeSlow: false, largeInUse: false, measurable: true, ...facts });
const PROCESSOR: SpeechDevice = { state: 'ready', kind: 'processor', largeOffered: false, largeSlow: false, largeInUse: false, measurable: true };
const MEASURING: SpeechDevice = { state: 'measuring', kind: 'processor', largeOffered: false, largeSlow: false, largeInUse: false, measurable: true };
const STOPPED: SpeechDevice = { state: 'ready', kind: 'processor', card: { name: CARD, stopped: true }, largeOffered: true, largeSlow: false, largeInUse: false, measurable: true };
const NO_GRAPHICS_BUILD: SpeechDevice = { state: 'ready', kind: 'processor', largeOffered: false, largeSlow: false, largeInUse: false, measurable: false };
/** Auto's two models ready, unless other models are given, on the given device. */
const on = (speechDevice: SpeechDevice, setup: SetupStatus = auto()): SetupStatus => ({ ...setup, speechDevice });
/** Large chosen: the large model first, in the given state, then Auto's two ready. */
const withLarge = (large: Partial<LanguageModel> = {}) => withModels(model('large-v3-turbo', large), model('small.en'), model('small'));
/** The "Runs on" line: the fold's summary, or a plain line when there is nothing to unfold. */
const deviceLine = () => transcription().getByText('Runs on').parentElement!;
const fold = () => deviceLine().parentElement!;
const unfold = async (user: ReturnType<typeof userEvent.setup>) => { await user.click(deviceLine()); expect(fold()).toHaveAttribute('open'); };
const cardSwitch = () => screen.getByRole('switch', { name: 'Use the graphics card' });
async function enter(text: string) {
  const user = userEvent.setup();
  await user.clear(field());
  if (text) { await user.click(field()); await user.paste(text); }
  await user.click(screen.getByRole('button', { name: 'Save' }));
  return user;
}

describe('vocabulary rules', () => {
  it('normalizes terms like settings.rs', () => {
    expect(normalizeVocabulary('')).toEqual({ vocabulary: undefined });
    expect(normalizeVocabulary(' , \n\r\n\t,')).toEqual({ vocabulary: undefined });
    expect(normalizeVocabulary('  CueReview ,Tauri\r\nFigtree\n\nNadia   Okafor,\tQuest 3 ')).toEqual({ vocabulary: 'CueReview, Tauri, Figtree, Nadia Okafor, Quest 3' });
    expect(normalizeVocabulary('Tauri, tauri,TAURI, WebView2')).toEqual({ vocabulary: 'Tauri, WebView2' });
    expect(normalizeVocabulary('Quest\u00a03')).toEqual({ vocabulary: 'Quest 3' });
    expect(normalizeVocabulary('-mc 999, "quoted" term, C:\\path\\')).toEqual({ vocabulary: '-mc 999, "quoted" term, C:\\path\\' });
  });

  it('estimates tokens exactly as the backend does', () => {
    // The same cases and numbers as token_estimate_tracks_measured_whisper_counts.
    for (const [prompt, estimated] of [
      ['CueReview, Tauri, Figtree, Nadia, Quest', 16],
      ['Kubernetes, PostgreSQL, Grafana, Prometheus, Terraform', 23],
      ['Siobhan, Aoife, Niamh, Tadhg, Caoimhe, Saoirse, Oisin', 23],
      ['XQZ-9, k8s, i18n, a11y, OAuth2, JWT, gRPC, WASM, SIMD, AVX-512', 40],
      ['HTTP/2, TLS 1.3, IPv6, DNS-over-HTTPS, WebRTC, QUIC', 31],
      ['CueReview, Tauri, Figtree, Nadia, Quest, WebView2, scrcpy, ffmpeg, ffprobe, Whisper, Silero, Storybook, Vitest, Clippy, rustfmt, DTW, VAD, Recents, Record more, Copy for agent', 73],
    ] as const) expect(estimateTokens(prompt), prompt).toBe(estimated);
  });
});

describe('SettingsDialog', () => {
  it('shows each validation problem inline and does not save', async () => {
    render(<Harness/>);
    const cases: [string, string][] = [
      ['Café, Tauri', 'The transcriber can only read plain ASCII letters, numbers and punctuation. Remove “é” (U+00E9).'],
      ['Tauri\u0007', 'Remove the control character U+0007 from the vocabulary.'],
      [Array.from({ length: 23 }, (_, index) => `t${index + 1}`).join(', '), 'Use at most 20 terms. This list has 23.'],
      [Array.from({ length: 7 }, (_, index) => `onboarding checkout dashboard ${index + 1}`).join(', '), 'Keep the vocabulary to 200 characters or fewer. This list has 229.'],
      ['XQZ-9, k8s, i18n, a11y, OAuth2, JWT, gRPC, WASM, SIMD, AVX-512, XQZ-8, k9s, i19n, a12y, OAuth3, JWS, gRPD, WASI, SIMT, AVX-256', "These terms need more room than the transcriber's prompt allows. Remove a few or use shorter ones."],
    ];
    for (const [text, problem] of cases) {
      await enter(text);
      expect(screen.getByRole('alert')).toHaveTextContent(problem);
      expect(field()).toHaveAttribute('aria-invalid', 'true');
      expect(field()).toHaveAccessibleDescription(`${problem} Names and terms the transcriber should expect, separated by commas.`);
      expect(field()).toHaveFocus();
    }
    expect(handlers.save).not.toHaveBeenCalled();
    await userEvent.setup().type(field(), 'x');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(field()).not.toHaveAttribute('aria-invalid');
  });

  it('saves the normalized vocabulary and clears it again', async () => {
    render(<Harness initial={{ vocabulary: 'Figtree' }}/>);
    expect(field()).toHaveValue('Figtree');
    expect(field()).toHaveAccessibleDescription('Names and terms the transcriber should expect, separated by commas.');
    await enter(' CueReview \n Tauri,, tauri ');
    expect(handlers.save).toHaveBeenLastCalledWith({ vocabulary: 'CueReview, Tauri' });
    expect(await screen.findByRole('status')).toHaveTextContent('Vocabulary saved');
    expect(field()).toHaveValue('CueReview, Tauri');
    // Focus stays on Save inside the modal.
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    await enter('');
    expect(handlers.save).toHaveBeenLastCalledWith({ vocabulary: undefined });
    expect(await screen.findByRole('status')).toHaveTextContent('Vocabulary cleared');
    expect(field()).toHaveValue('');
  });

  it('shows a rejected save inline and keeps the draft', async () => {
    render(<Harness save={() => Promise.reject('Settings could not be saved: access is denied.')}/>);
    await enter('CueReview');
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings could not be saved: access is denied.');
    expect(field()).toHaveValue('CueReview');
    expect(field()).toHaveFocus();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('saves once at a time and keeps focus while saving', async () => {
    let finish!: () => void;
    render(<Harness save={settings => new Promise(resolve => { finish = () => resolve(settings); })}/>);
    const user = await enter('Nadia');
    const button = screen.getByRole('button', { name: 'Saving…' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveFocus();
    expect(field()).toHaveAttribute('readonly');
    await user.click(button);
    expect(handlers.save).toHaveBeenCalledOnce();
    finish();
    expect(await screen.findByRole('status')).toHaveTextContent('Vocabulary saved');
    expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAttribute('aria-disabled');
    expect(field()).not.toHaveAttribute('readonly');
  });

  it('waits for settings to load before editing', () => {
    render(<Harness initial={null}/>);
    expect(field()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0', 'Ctrl+R', 'Ctrl+N', 'Ctrl+K', 'Control'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15', 'Ctrl+R', 'Ctrl+N', 'Ctrl+K', 'Control'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', '⌘R', '⌘N', '⌘K', 'Command'],
  ])('lists the shortcuts for %s', (userAgent, record, fresh, search, modifier) => {
    vi.stubGlobal('navigator', { userAgent });
    render(<Harness/>);
    const list = within(screen.getByRole('region', { name: 'Keyboard shortcuts' }));
    const rows = list.getAllByRole('term').map(term => [term.textContent, term.nextElementSibling?.querySelector('[aria-hidden]')?.textContent, term.nextElementSibling?.querySelector('.settings-sr-only')?.textContent]);
    expect(rows).toEqual([
      ['Record, stop or record more', record, `${modifier} R`],
      ['New session', fresh, `${modifier} N`],
      ['Search recordings', search, `${modifier} K`],
      ['Play or pause', 'Space', 'Space'],
      ['Seek back or forward 5 seconds', '←→', 'Left arrow or Right arrow'],
    ]);
    expect(screen.getByRole('dialog', { name: 'Settings' })).not.toHaveTextContent(/marker/i);
  });

  it('keeps the appearance, capability statuses and setup actions', async () => {
    const user = userEvent.setup();
    const missing: SetupStatus = { ready: false, issues: ['Local speech model is missing.'], modelReady: false, dependencies: ready.dependencies!.map(item => item.name === 'adb' ? { ...item, available: false, path: undefined, detail: 'Install Android platform tools' } : item) };
    const { rerender } = render(<Harness setup={missing}/>);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Appearance' }), 'dark');
    expect(handlers.theme).toHaveBeenCalledWith('dark');
    expect(toolRow('Capture and playback')).toHaveTextContent('Available');
    expect(toolRow('Transcription')).toHaveTextContent('Setup needed');
    expect(toolRow('USB devices')).toHaveTextContent('Optional setup');
    expect(screen.getByText('Local speech model is missing.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Install transcription' }));
    expect(handlers.install).toHaveBeenCalledOnce();
    await user.click(screen.getByText('Technical details'));
    expect(screen.getByText('Install Android platform tools')).toBeVisible();
    expect(screen.getByText('C:\\tools\\ffmpeg.exe')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(handlers.checkAgain).toHaveBeenCalledOnce();

    rerender(<Harness setup={missing} installing/>);
    expect(screen.getByRole('button', { name: 'Downloading speech tools…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Appearance' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Downloading the speech model and tools. This may take a few minutes.');
    // Settings must stay dismissible while installing, so a recording can be stopped.
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeEnabled();
    await user.keyboard('{Escape}');
    expect(handlers.close).toHaveBeenCalledOnce();

    rerender(<Harness setup={ready} error="Download failed. Check your connection and retry."/>);
    expect(screen.getByRole('alert')).toHaveTextContent('Check your connection');
    expect(toolRow('Transcription')).toHaveTextContent('Available');
    expect(screen.queryByRole('button', { name: 'Install transcription' })).not.toBeInTheDocument();
  });

  it('credits the bundled Figtree font and points at its shipped licence', () => {
    render(<Harness setup={null}/>);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveTextContent(FONT_CREDIT);
    expect(FONT_CREDIT).toMatch(/SIL Open Font License 1\.1/);
    expect(FONT_CREDIT).toContain('licenses/Figtree-OFL.txt');
  });
  it('explains that tools are only inspected in the desktop app', () => {
    render(<Harness setup={null}/>);
    expect(screen.getByText('Start the desktop app to inspect installed recording tools.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
    expect(field()).toBeEnabled();
  });

  it('restores the stored value when reopened', async () => {
    const user = userEvent.setup();
    function Reopen() {
      const [open, setOpen] = useState(true);
      return <><button onClick={() => setOpen(true)}>Open settings</button>
        <SettingsDialog open={open} onClose={() => setOpen(false)} theme="light" onTheme={() => {}} setup={ready} installing={false}
          onInstall={() => {}} onCheckAgain={() => {}} onPollLanguageModels={async () => {}} onDownloadLanguageModels={async () => {}}
          onPollSpeechDevice={async () => {}} onTestSpeechDevices={async () => {}} languages={SPEECH_LANGUAGES} settings={{ vocabulary: 'Figtree' }} onSaveSettings={async () => {}}/></>;
    }
    render(<Reopen/>);
    await user.type(field(), ', Nadia');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(field()).toHaveValue('Figtree');
  });

  it('shows the chosen language and its ready models', () => {
    const { unmount } = render(<Harness initial={{}} setup={auto()}/>);
    expect(screen.getByRole('heading', { name: 'Transcription' })).toBeVisible();
    // No saved language is Auto, which needs both models.
    expect(transcription().getByRole('combobox', { name: 'Language' })).toHaveValue('');
    expect(transcription().getByRole('combobox', { name: 'Language' })).toHaveDisplayValue('Auto');
    expect(modelRow('English')).toHaveTextContent('Ready');
    expect(modelRow('English')).toHaveAttribute('data-available');
    expect(modelRow('Multilingual')).toHaveTextContent('Ready');
    expect(modelRow('Multilingual')).toHaveAttribute('data-available');
    expect(transcription().getByText("Auto detects each take's language: English takes use the English model, every other language the multilingual one.")).toBeVisible();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    // The section comes directly before the vocabulary.
    expect(screen.getByRole('region', { name: 'Transcription' }).nextElementSibling).toContainElement(field());
    unmount();

    // A chosen language needs its own model only, and holds every take to it.
    const english = render(<Harness initial={{ language: 'en' }} setup={withModels(model('small.en'))}/>);
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveDisplayValue('English');
    expect(modelRow('English')).toHaveTextContent('Ready');
    expect(transcription().queryByText('Multilingual model')).not.toBeInTheDocument();
    expect(transcription().getByText('Every take is transcribed as English, whatever is spoken.')).toBeVisible();
    english.unmount();
    render(<Harness initial={{ language: 'pl' }} setup={withModels(model('small'))}/>);
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveDisplayValue('Polish');
    expect(modelRow('Multilingual')).toHaveTextContent('Ready');
    expect(transcription().queryByText('English model')).not.toBeInTheDocument();
    expect(transcription().getByText('Every take is transcribed as Polish, whatever is spoken.')).toBeVisible();
  });

  it('offers Auto first and every language the speech model knows', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ vocabulary: 'Figtree' }} setup={auto()}/>);
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Language' });
    const names = [...select.options].map(option => option.label);
    // Auto, then English and German, then the other 97 by English name in alphabetical order.
    expect(names).toHaveLength(100);
    expect(names.slice(0, 3)).toEqual(['Auto', 'English', 'German']);
    const rest = names.slice(3);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, 'en')));
    expect(rest.slice(0, 4)).toEqual(['Afrikaans', 'Albanian', 'Amharic', 'Arabic']);
    expect(new Set([...select.options].map(option => option.value))).toEqual(new Set(['', ...SPEECH_LANGUAGES.map(item => item.code)]));
    // The groups are drawn apart; the open list names what Auto does.
    expect(select.querySelectorAll('hr')).toHaveLength(2);
    expect(select.options[0]).toHaveAttribute('data-hint', 'detect each take');
    // Auto is shown as chosen until another is chosen; choosing saves at once, and Auto saves no language.
    expect(select).toHaveValue('');
    await user.selectOptions(select, 'nl');
    expect(handlers.save).toHaveBeenLastCalledWith({ vocabulary: 'Figtree', language: 'nl' });
    expect(select).toHaveDisplayValue('Dutch');
    await user.selectOptions(select, '');
    expect(handlers.save).toHaveBeenLastCalledWith({ vocabulary: 'Figtree', language: undefined });
    expect(select).toHaveValue('');
  });

  it('keeps a saved language the list does not name and shows no model row for a custom model', () => {
    render(<Harness initial={{ language: 'xx' }}/>);
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveValue('xx');
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveDisplayValue('xx');
    expect(transcription().queryByText(/model$/)).not.toBeInTheDocument();
    expect(transcription().queryByText(/transcribed/)).not.toBeInTheDocument();
  });

  it("shows the language model's download progress", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let reply!: () => void;
    handlers.poll.mockImplementation(() => new Promise<void>(resolve => { reply = resolve; }));
    const downloading = (receivedBytes: number) => withModels(model('small', { state: 'downloading', receivedBytes }));
    const { rerender, unmount } = render(<Harness initial={{ language: 'de' }} setup={downloading(212_000_000)}/>);
    expect(modelRow('Multilingual')).toHaveTextContent('Downloading · 212 of 488 MB');
    const bar = screen.getByRole('progressbar', { name: 'Multilingual model download' });
    expect(bar).toHaveAttribute('aria-valuenow', '212');
    expect(bar).toHaveAttribute('aria-valuemax', '488');
    expect(bar).toHaveAttribute('aria-valuetext', '212 of 488 MB');
    expect(transcription().getByText('Until it finishes, recordings are transcribed with the base model.')).toBeVisible();

    // The models' states are read about each second while one downloads, the next read only after the last reply.
    expect(handlers.poll).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(handlers.poll).toHaveBeenCalledOnce();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(handlers.poll).toHaveBeenCalledOnce();
    await act(async () => { reply(); });
    rerender(<Harness initial={{ language: 'de' }} setup={downloading(300_000_000)}/>);
    expect(modelRow('Multilingual')).toHaveTextContent('Downloading · 300 of 488 MB');
    act(() => { vi.advanceTimersByTime(999); });
    expect(handlers.poll).toHaveBeenCalledOnce();
    act(() => { vi.advanceTimersByTime(1); });
    expect(handlers.poll).toHaveBeenCalledTimes(2);

    // Once it is ready, the reading stops, even when the last reply arrives afterwards.
    rerender(<Harness initial={{ language: 'de' }} setup={withModels(model('small'))}/>);
    await act(async () => { reply(); });
    expect(modelRow('Multilingual')).toHaveTextContent('Ready');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(handlers.poll).toHaveBeenCalledTimes(2);

    // Under Auto, the multilingual model downloads while the English one is ready: only other languages wait on base.
    unmount();
    const second = render(<Harness initial={{}} setup={auto({}, { state: 'downloading', receivedBytes: 212_000_000 })}/>);
    expect(modelRow('English')).toHaveTextContent('Ready');
    expect(modelRow('Multilingual')).toHaveTextContent('Downloading · 212 of 488 MB');
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
    expect(transcription().getByText('Until it finishes, takes in other languages than English are transcribed with the base model.')).toBeVisible();
    expect(transcription().queryByText(/^Auto detects/)).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(handlers.poll).toHaveBeenCalledTimes(3);
    // The English one first, the multilingual one after it: everything waits on base until they finish.
    second.rerender(<Harness initial={{}} setup={auto({ state: 'downloading', receivedBytes: 100_000_000 }, { state: 'missing', receivedBytes: 0 })}/>);
    expect(modelRow('English')).toHaveTextContent('Downloading · 100 of 488 MB');
    expect(modelRow('Multilingual')).toHaveTextContent('Not downloaded yet');
    expect(transcription().getByText('Until they finish, recordings are transcribed with the base model.')).toBeVisible();
    expect(transcription().queryByRole('button')).not.toBeInTheDocument();
  });

  it('stops reading the downloading model when Settings closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let reply!: () => void;
    handlers.poll.mockImplementation(() => new Promise<void>(resolve => { reply = resolve; }));
    const downloading = auto({}, { state: 'downloading', receivedBytes: 212_000_000 });
    const dialog = (open: boolean) => <SettingsDialog open={open} onClose={() => {}} theme="light" onTheme={() => {}} setup={downloading} installing={false}
      onInstall={() => {}} onCheckAgain={() => {}} onPollLanguageModels={() => handlers.poll()} onDownloadLanguageModels={async () => {}}
      onPollSpeechDevice={async () => {}} onTestSpeechDevices={async () => {}} languages={[]} settings={{}} onSaveSettings={async () => {}}/>;
    const { rerender } = render(dialog(true));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(handlers.poll).toHaveBeenCalledOnce();
    rerender(dialog(false));
    await act(async () => { reply(); });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(handlers.poll).toHaveBeenCalledOnce();
  });

  it('offers to retry a failed model download', async () => {
    const user = userEvent.setup();
    const { rerender, unmount } = render(<Harness initial={{ language: 'en' }} setup={withModels(model('small.en', { state: 'failed', receivedBytes: 0, error: 'The download was cut off.' }))}/>);
    expect(modelRow('English')).toHaveTextContent('Download failed');
    expect(transcription().getByText('The download was cut off. Recordings are transcribed with the base model until it is installed.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(handlers.download).toHaveBeenCalledOnce();
    // The backend marks the download running before it returns: one read shows it and starts the polling.
    await waitFor(() => expect(handlers.poll).toHaveBeenCalledOnce());

    handlers.download.mockRejectedValueOnce('Open CueReview as a desktop app.');
    rerender(<Harness initial={{ language: 'en' }} setup={withModels(model('small.en', { state: 'failed', receivedBytes: 0 }))}/>);
    expect(transcription().getByText('The download did not finish. Recordings are transcribed with the base model until it is installed.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Open CueReview as a desktop app.');
    expect(handlers.poll).toHaveBeenCalledOnce();

    // Under Auto, the failed model's row says so and names the takes that stay on base; one Try again fetches what is missing.
    unmount();
    const second = render(<Harness initial={{}} setup={auto({}, { state: 'failed', receivedBytes: 0, error: 'The download was cut off.' })}/>);
    expect(modelRow('English')).toHaveTextContent('Ready');
    expect(modelRow('Multilingual')).toHaveTextContent('Download failed');
    expect(modelRow('Multilingual')!.nextElementSibling).toHaveTextContent('The download was cut off. Takes in other languages than English are transcribed with the base model until it is installed.');
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(handlers.download).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(handlers.poll).toHaveBeenCalledTimes(2));

    second.unmount();
    render(<Harness initial={{ language: 'en' }} setup={withModels(model('small.en', { state: 'missing', receivedBytes: 0 }))}/>);
    expect(modelRow('English')).toHaveTextContent('Not downloaded yet');
    expect(transcription().getByText('Recordings are transcribed with the base model until it is installed.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(handlers.download).toHaveBeenCalledTimes(4);
    await waitFor(() => expect(handlers.poll).toHaveBeenCalledTimes(3));
  });

  it('shows a rejected model download under the section', async () => {
    const user = userEvent.setup();
    const refusal = 'Install transcription first, then the language model downloads by itself.';
    handlers.download.mockRejectedValueOnce(refusal);
    render(<Harness initial={{ language: 'en' }} setup={withModels(model('small.en', { state: 'missing', receivedBytes: 0 }))}/>);
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(await transcription().findByRole('alert')).toHaveTextContent(refusal);
    expect(handlers.poll).not.toHaveBeenCalled();
    // Trying again clears it.
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(handlers.poll).toHaveBeenCalledOnce();
  });

  it('asks to install transcription before the language model downloads', async () => {
    const user = userEvent.setup();
    const beforeInstall = (state: Partial<LanguageModel>): SetupStatus => ({ ...withModels(model('small', state)), ready: false, modelReady: false, issues: ['Local speech model is missing.'] });
    const { rerender } = render(<Harness initial={{ language: 'de' }} setup={beforeInstall({ state: 'missing', receivedBytes: 0 })}/>);
    expect(modelRow('Multilingual')).toHaveTextContent('Not downloaded yet');
    expect(transcription().getByText('Install transcription first; this model then downloads by itself.')).toBeVisible();
    expect(transcription().queryByText(/base model/)).not.toBeInTheDocument();
    expect(transcription().queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install transcription' })).toBeVisible();

    rerender(<Harness initial={{ language: 'de' }} setup={beforeInstall({ state: 'failed', receivedBytes: 0, error: 'Hugging Face could not be reached.' })}/>);
    expect(transcription().getByText('Hugging Face could not be reached.')).toBeVisible();
    expect(transcription().getByText('Install transcription first; this model then downloads by itself.')).toBeVisible();
    expect(transcription().queryByText(/base model/)).not.toBeInTheDocument();
    expect(transcription().queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    // The language can still be chosen.
    const select = screen.getByRole('combobox', { name: 'Language' });
    expect(select).toBeEnabled();
    await user.selectOptions(select, 'en');
    expect(handlers.save).toHaveBeenLastCalledWith({ language: 'en' });
  });

  it('saves a chosen language at once and keeps the vocabulary', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ vocabulary: 'Figtree' }} setup={auto()}/>);
    await user.type(field(), ', Nadia');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'de');
    expect(handlers.save).toHaveBeenLastCalledWith({ vocabulary: 'Figtree', language: 'de' });
    await waitFor(() => expect(handlers.poll).toHaveBeenCalledOnce());
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveValue('de');
    // The unsaved vocabulary draft stays as typed.
    expect(field()).toHaveValue('Figtree, Nadia');
  });

  it('shows a rejected language choice and keeps the stored language', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ language: 'en' }} setup={withModels(model('small.en'))} save={() => Promise.reject('Settings could not be saved: access is denied.')}/>);
    const select = screen.getByRole('combobox', { name: 'Language' });
    await user.selectOptions(select, 'de');
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings could not be saved: access is denied.');
    expect(select).toHaveValue('en');
    expect(select).toHaveAccessibleDescription('Settings could not be saved: access is denied.');
    expect(handlers.poll).not.toHaveBeenCalled();
  });
});

describe('SettingsDialog: the graphics card', () => {
  it('names the device transcription runs on', async () => {
    const user = userEvent.setup();
    // A graphics card that transcribes: one folded line under the models, naming it.
    const { unmount } = render(<Harness setup={on(fastCard())}/>);
    expect(deviceLine()).toHaveTextContent(/^Runs on NVIDIA GeForce RTX 5090$/);
    expect(fold()).not.toHaveAttribute('open');
    expect(fold().previousElementSibling).toHaveTextContent(/^Auto detects/);
    expect(cardSwitch()).not.toBeVisible();
    expect(transcription().queryByText(/stopped/)).not.toBeInTheDocument();
    unmount();

    // The processor: the same line, and nothing about a card when it unfolds.
    const processor = render(<Harness setup={on(PROCESSOR)}/>);
    expect(deviceLine()).toHaveTextContent(/^Runs on the processor$/);
    await unfold(user);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(transcription().queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument();
    // While the devices are measured, the processor transcribes and the line says the card is being tested.
    processor.rerender(<Harness setup={on(MEASURING)}/>);
    expect(deviceLine()).toHaveTextContent(/^Runs on the processor · testing the graphics card…$/);
    processor.unmount();

    // A card that stopped: the line warns, its fold opens by itself and names the card.
    render(<Harness setup={on(STOPPED)}/>);
    expect(deviceLine()).toHaveTextContent(/^Runs on the processor · the graphics card stopped$/);
    expect(fold()).toHaveAttribute('open');
    expect(fold()).toHaveAttribute('data-warning');
    expect(transcription().getByText('The NVIDIA GeForce RTX 5090 stopped during a transcription, so the processor transcribes until it is tested again.')).toBeVisible();
    expect(cardSwitch()).toBeVisible();
    expect(screen.getByRole('button', { name: 'Test the graphics card again' })).toBeVisible();
    // A runtime without the graphics-card build (macOS, Linux): the processor, as a plain line with nothing to unfold.
    cleanupAndRender(<Harness setup={on(NO_GRAPHICS_BUILD)}/>);
    expect(deviceLine()).toHaveTextContent(/^Runs on the processor$/);
    expect(deviceLine().tagName).toBe('P');
    expect(transcription().queryByText('Runs on')!.closest('details')).toBeNull();
    // Without a device in the status there is no line.
    cleanupAndRender(<Harness setup={auto()}/>);
    expect(transcription().queryByText('Runs on')).not.toBeInTheDocument();
  });

  it('turns the graphics card off for transcription', async () => {
    const user = userEvent.setup();
    let reject = false;
    render(<Harness initial={{ vocabulary: 'Figtree', model: 'large' }} setup={on(fastCard({ largeInUse: true }), withLarge())}
      save={settings => reject ? Promise.reject('Settings could not be saved: access is denied.') : Promise.resolve(settings)}/>);
    await unfold(user);
    expect(cardSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(cardSwitch()).toHaveAccessibleDescription('Turn it off if a game or headset app stutters while you record.');

    // Off saves graphicsCard: false with the other choices, shows the processor at once and reads the device again.
    await user.click(cardSwitch());
    expect(handlers.save).toHaveBeenLastCalledWith({ vocabulary: 'Figtree', model: 'large', graphicsCard: false });
    expect(cardSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(deviceLine()).toHaveTextContent(/^Runs on the processor$/);
    await waitFor(() => expect(handlers.pollDevice).toHaveBeenCalledOnce());
    // Large waits for the card; the small models transcribe.
    expect(modelRow('Large')).toHaveTextContent('Needs the graphics card');
    expect(modelRow('Large')).not.toHaveAttribute('data-available');
    expect(transcription().getByText('With the graphics card off, the English and multilingual models transcribe.')).toBeVisible();
    expect(transcription().queryByText(/^Fallback/)).not.toBeInTheDocument();

    // On removes it again.
    await user.click(cardSwitch());
    expect(JSON.stringify(handlers.save.mock.lastCall![0])).toBe('{"vocabulary":"Figtree","model":"large"}');
    expect(deviceLine()).toHaveTextContent(/^Runs on NVIDIA GeForce RTX 5090$/);
    await waitFor(() => expect(handlers.pollDevice).toHaveBeenCalledTimes(2));

    // A refused save puts the switch back and says why.
    reject = true;
    await user.click(cardSwitch());
    expect(await within(fold()).findByRole('alert')).toHaveTextContent('Settings could not be saved: access is denied.');
    expect(cardSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(handlers.pollDevice).toHaveBeenCalledTimes(2);
  });

  it('asks for the graphics card to be tested again', async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    handlers.test.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const { rerender } = render(<Harness setup={on(STOPPED)}/>);
    const test = screen.getByRole('button', { name: 'Test the graphics card again' });
    await user.click(test);
    expect(handlers.test).toHaveBeenCalledOnce();
    // Inert while it starts and while the devices are measured: focus stays on it.
    expect(test).toHaveAttribute('aria-disabled', 'true');
    await user.click(test);
    expect(handlers.test).toHaveBeenCalledOnce();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let reply!: () => void;
    handlers.pollDevice.mockImplementation(() => new Promise<void>(resolve => { reply = resolve; }));
    rerender(<Harness setup={on({ ...MEASURING, card: STOPPED.card, largeOffered: true })}/>);
    await act(async () => { finish(); });
    expect(deviceLine()).toHaveTextContent(/^Runs on the processor · testing the graphics card…$/);
    expect(test).toHaveAttribute('aria-disabled', 'true');
    expect(test).toHaveFocus();

    // The device is read about each second while it is measured, the next read only after the last reply.
    expect(handlers.pollDevice).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(handlers.pollDevice).toHaveBeenCalledOnce();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(handlers.pollDevice).toHaveBeenCalledOnce();
    await act(async () => { reply(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(handlers.pollDevice).toHaveBeenCalledTimes(2);

    // The card measured fastest again: it transcribes, and the reading stops.
    rerender(<Harness setup={on(fastCard())}/>);
    await act(async () => { reply(); });
    expect(deviceLine()).toHaveTextContent(/^Runs on NVIDIA GeForce RTX 5090$/);
    expect(fold()).not.toHaveAttribute('data-warning');
    expect(screen.queryByRole('button', { name: 'Test the graphics card again' })).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(handlers.pollDevice).toHaveBeenCalledTimes(2);
    vi.useRealTimers();

    // Without a card that beat the processor, the fold offers the test too; a refusal shows in it.
    handlers.test.mockRejectedValueOnce('The graphics card is tested once the recording stops.');
    cleanupAndRender(<Harness setup={on(PROCESSOR)}/>);
    await unfold(user);
    await user.click(screen.getByRole('button', { name: 'Test the graphics card again' }));
    expect(await within(fold()).findByRole('alert')).toHaveTextContent('The graphics card is tested once the recording stops.');
    expect(screen.getByRole('button', { name: 'Test the graphics card again' })).not.toHaveAttribute('aria-disabled');

    // A runtime without the graphics-card build has nothing to test: no button, even for a stopped card.
    cleanupAndRender(<Harness setup={on({ ...STOPPED, measurable: false })}/>);
    expect(fold()).toHaveAttribute('open');
    expect(cardSwitch()).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Test the graphics card again' })).not.toBeInTheDocument();
    cleanupAndRender(<Harness setup={on(NO_GRAPHICS_BUILD)}/>);
    expect(screen.queryByRole('button', { name: 'Test the graphics card again' })).not.toBeInTheDocument();
  });

  it('offers the larger model on a fast graphics card', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness initial={{ vocabulary: 'Figtree' }} setup={on(fastCard())}/>);
    // The Model select sits under Language, Standard chosen, and the note names Large's download.
    const select = transcription().getByRole<HTMLSelectElement>('combobox', { name: 'Model' });
    expect(transcription().getByRole('combobox', { name: 'Language' }).parentElement!.nextElementSibling).toContainElement(select);
    expect([...select.options].map(option => option.label)).toEqual(['Standard', 'Large']);
    expect(select).toHaveDisplayValue('Standard');
    expect(transcription().getByText("Auto detects each take's language: English takes use the English model, every other language the multilingual one. Large reads every language more clearly on this graphics card; a 1.6 GB download.")).toBeVisible();

    // Choosing saves at once with the other choices; the backend starts the download, so the models are read.
    await user.selectOptions(select, 'large');
    expect(handlers.save).toHaveBeenLastCalledWith({ vocabulary: 'Figtree', model: 'large' });
    expect(select).toHaveDisplayValue('Large');
    await waitFor(() => expect(handlers.poll).toHaveBeenCalledOnce());
    await user.selectOptions(select, '');
    expect(JSON.stringify(handlers.save.mock.lastCall![0])).toBe('{"vocabulary":"Figtree"}');
    expect(select).toHaveDisplayValue('Standard');
    unmount();

    // Large downloaded but not yet tried on the card: it reads Ready, and the small models transcribe until it has been.
    const tried = render(<Harness initial={{ model: 'large' }} setup={on(fastCard(), withLarge())}/>);
    expect(modelRow('Large')).toHaveTextContent('Ready');
    expect(modelRow('Large')).toHaveAttribute('data-available');
    expect(transcription().getByText('Large is being tried on the graphics card; until then, the English and multilingual models transcribe.')).toBeVisible();
    expect(transcription().queryByText('The large model transcribes every language on the graphics card.')).not.toBeInTheDocument();
    expect(fold()).not.toContainElement(modelRow('English'));
    tried.unmount();

    // Large in use, as the backend says: its row first, and the small models in the fold as the fallback.
    const inUse = render(<Harness initial={{ model: 'large' }} setup={on(fastCard({ largeInUse: true }), withLarge())}/>);
    expect(transcription().getAllByText(/ model$/).map(item => item.textContent)).toEqual(['Large model', 'English model', 'Multilingual model']);
    expect(modelRow('Large')).toHaveTextContent('Ready');
    expect(modelRow('Large')).toHaveAttribute('data-available');
    expect(transcription().getByText('The large model transcribes every language on the graphics card.')).toBeVisible();
    expect(fold()).toContainElement(modelRow('English'));
    expect(modelRow('English')).not.toBeVisible();
    await unfold(user);
    expect(within(fold()).getByText('Fallback when the graphics card is off:')).toBeVisible();
    expect(modelRow('English')).toBeVisible();
    expect(modelRow('Multilingual')).toHaveTextContent('Ready');
    // Tried and did not keep up (slower than the processor, or too big beside a second track): said plainly, and the
    // small models stay in the list.
    inUse.rerender(<Harness initial={{ model: 'large' }} setup={on(fastCard({ largeSlow: true }), withLarge())}/>);
    expect(transcription().getByText('The large model did not keep up on this graphics card, so the English and multilingual models transcribe.')).toBeVisible();
    expect(transcription().queryByText(/being tried/)).not.toBeInTheDocument();
    expect(fold()).not.toContainElement(modelRow('English'));
    inUse.unmount();

    // A refused choice puts the select back and says why.
    render(<Harness setup={on(fastCard())} save={() => Promise.reject('Settings could not be saved: access is denied.')}/>);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'large');
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings could not be saved: access is denied.');
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveDisplayValue('Standard');
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveAccessibleDescription('Settings could not be saved: access is denied.');
  });

  it('does not offer the larger model without a fast graphics card', () => {
    for (const device of [PROCESSOR, MEASURING, fastCard({ largeOffered: false })]) {
      const { unmount } = render(<Harness setup={on(device)}/>);
      expect(transcription().queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument();
      expect(transcription().getByText("Auto detects each take's language: English takes use the English model, every other language the multilingual one.")).toBeVisible();
      expect(transcription().queryByText(/Large/)).not.toBeInTheDocument();
      unmount();
    }
    // A card faster than the processor but not enough for Large still transcribes.
    render(<Harness setup={on(fastCard({ largeOffered: false }))}/>);
    expect(deviceLine()).toHaveTextContent(/^Runs on NVIDIA GeForce RTX 5090$/);
  });

  it("shows the larger model's download progress", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const downloading = (receivedBytes: number) => on(fastCard(), withLarge({ state: 'downloading', receivedBytes }));
    const { rerender, unmount } = render(<Harness initial={{ model: 'large' }} setup={downloading(640_000_000)}/>);
    expect(transcription().getAllByText(/ model$/).map(item => item.textContent)).toEqual(['Large model', 'English model', 'Multilingual model']);
    expect(modelRow('Large')).toHaveTextContent('Downloading · 640 of 1,625 MB');
    const bar = screen.getByRole('progressbar', { name: 'Large model download' });
    expect(bar).toHaveAttribute('aria-valuenow', '640');
    expect(bar).toHaveAttribute('aria-valuemax', '1625');
    expect(bar).toHaveAttribute('aria-valuetext', '640 of 1,625 MB');
    expect(modelRow('English')).toHaveTextContent('Ready');
    expect(modelRow('Multilingual')).toHaveTextContent('Ready');
    expect(transcription().getByText('Until it finishes, the English and multilingual models transcribe.')).toBeVisible();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(handlers.poll).toHaveBeenCalledOnce();
    await act(async () => {});
    rerender(<Harness initial={{ model: 'large' }} setup={downloading(1_200_000_000)}/>);
    expect(modelRow('Large')).toHaveTextContent('Downloading · 1,200 of 1,625 MB');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(handlers.poll).toHaveBeenCalledTimes(2);
    expect(handlers.pollDevice).not.toHaveBeenCalled();
    // Once it is ready, the models are no longer read; the device is read at once, then each second while the
    // backend tries Large on the card, until it is in use.
    await act(async () => {});
    rerender(<Harness initial={{ model: 'large' }} setup={on(fastCard(), withLarge())}/>);
    expect(modelRow('Large')).toHaveTextContent('Ready');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(handlers.pollDevice).toHaveBeenCalledOnce();
    expect(transcription().getByText('Large is being tried on the graphics card; until then, the English and multilingual models transcribe.')).toBeVisible();
    await act(async () => {});
    act(() => { vi.advanceTimersByTime(1000); });
    expect(handlers.pollDevice).toHaveBeenCalledTimes(2);
    await act(async () => {});
    act(() => { vi.advanceTimersByTime(1000); });
    expect(handlers.pollDevice).toHaveBeenCalledTimes(3);
    await act(async () => {});
    rerender(<Harness initial={{ model: 'large' }} setup={on(fastCard({ largeInUse: true }), withLarge())}/>);
    expect(transcription().getByText('The large model transcribes every language on the graphics card.')).toBeVisible();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(handlers.poll).toHaveBeenCalledTimes(2);
    expect(handlers.pollDevice).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
    unmount();

    // A failed download says so as the other rows do, and one Try again fetches it; its end is a reason to read the device too.
    const user = userEvent.setup();
    const failed = render(<Harness initial={{ model: 'large' }} setup={downloading(640_000_000)}/>);
    failed.rerender(<Harness initial={{ model: 'large' }} setup={on(fastCard(), withLarge({ state: 'failed', receivedBytes: 0, error: 'The download was cut off.' }))}/>);
    expect(handlers.pollDevice).toHaveBeenCalledTimes(4);
    expect(modelRow('Large')).toHaveTextContent('Download failed');
    expect(modelRow('Large')!.nextElementSibling).toHaveTextContent('The download was cut off. The English and multilingual models transcribe until it is installed.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(handlers.download).toHaveBeenCalledOnce();
  });
});

/** Replaces whatever is rendered with `element`. */
function cleanupAndRender(element: ReactElement) {
  cleanup();
  return render(element);
}
