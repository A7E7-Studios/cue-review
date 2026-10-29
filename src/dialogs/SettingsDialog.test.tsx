import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { Settings, SetupStatus } from '../backend';
import type { WindowTheme } from '../chrome/windowApi';
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
    settings={settings} onSaveSettings={async next => { handlers.save(next); setSettings(await save(next)); }} error={error}/>;
}
const handlers = { close: vi.fn(), theme: vi.fn(), install: vi.fn(), checkAgain: vi.fn(), save: vi.fn() };

beforeEach(() => { document.documentElement.dataset.motion = 'reduced'; for (const handler of Object.values(handlers)) handler.mockReset(); });
afterEach(() => { delete document.documentElement.dataset.motion; vi.unstubAllGlobals(); });

const field = () => screen.getByRole('textbox', { name: 'Vocabulary' });
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
      ['New recording', fresh, `${modifier} N`],
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
    expect(screen.getByText('Capture and playback').parentElement).toHaveTextContent('Available');
    expect(screen.getByText('Transcription').parentElement).toHaveTextContent('Setup needed');
    expect(screen.getByText('USB devices').parentElement).toHaveTextContent('Optional setup');
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
    expect(screen.getByText('Transcription').parentElement).toHaveTextContent('Available');
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
          onInstall={() => {}} onCheckAgain={() => {}} settings={{ vocabulary: 'Figtree' }} onSaveSettings={async () => {}}/></>;
    }
    render(<Reopen/>);
    await user.type(field(), ', Nadia');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(field()).toHaveValue('Figtree');
  });
});
