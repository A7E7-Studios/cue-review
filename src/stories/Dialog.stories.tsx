import { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { backend } from '../backend';
import type { Settings as AppSettings, Language, SetupStatus } from '../backend';
import type { WindowTheme } from '../chrome/windowApi';
import { SettingsDialog } from '../dialogs/SettingsDialog';
import { Dialog } from '../ui/Dialog';
import { configureLanguageModel, configureScenario } from './backend.fixture';

type Props = { busy: boolean; error: boolean; destructive: boolean; initiallyOpen: boolean };
function DialogExample({ busy, error, destructive, initiallyOpen }: Props) {
  const [open, setOpen] = useState(initiallyOpen);
  const [value, setValue] = useState('Library selection and details');
  const [saved, setSaved] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  return <div className="workshop-dialog-launcher">
    <button ref={launcher} className="primary" onClick={() => { setSaved(false); setOpen(true); }}>Open dialog</button>
    <p>Open and close this real application dialog to compare motion and focus behavior. Use Tab, Shift+Tab and Escape.</p>
    {saved && <p role="status">Sample changes saved.</p>}
    <Dialog open={open} onClose={() => setOpen(false)} busy={busy} title={destructive ? 'Delete recording?' : 'Recording name'} role={destructive ? 'alertdialog' : 'dialog'}
      description={destructive ? <>Permanently delete <strong>Library selection and details</strong> and all its files? This cannot be undone.</> : undefined}
      restoreFocusRef={launcher} initialFocusRef={destructive ? cancel : input} closeLabel="Close dialog"
      onSubmit={destructive ? undefined : event => { event.preventDefault(); if (!busy) { setSaved(true); setOpen(false); } }}>
      {!destructive && <label className="workshop-dialog-label">Name<input ref={input} value={value} disabled={busy} onChange={event => setValue(event.target.value)}/></label>}
      {error && <p className="dialog-error" role="alert">The recording could not be updated. Its original files are unchanged.</p>}
      <div className="dialog-actions"><button ref={cancel} type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button><button className={destructive ? 'danger-button' : 'primary'} disabled={busy} type={destructive ? 'button' : 'submit'} onClick={destructive ? () => setOpen(false) : undefined}>{busy ? 'Saving…' : destructive ? 'Delete recording' : 'Save'}</button></div>
    </Dialog>
  </div>;
}
type SettingsProps = { scenario?: 'fresh' | 'setup'; desktop?: boolean; installing?: boolean; error?: string; vocabulary?: string; language?: Language; model?: Parameters<typeof configureLanguageModel>[1] };
// The real Settings dialog over the workshop backend: saving, setup checks,
// installation and the language model's download change only in-memory fixtures.
function SettingsExample({ scenario = 'fresh', desktop = true, installing: startInstalling = false, error, vocabulary, language, model }: SettingsProps) {
  useState(() => { configureScenario(scenario); if (model) configureLanguageModel(language, model); return true; });
  const [open, setOpen] = useState(true);
  const [theme, setTheme] = useState<WindowTheme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [installing, setInstalling] = useState(startInstalling);
  const [problem, setProblem] = useState(error ?? '');
  const launcher = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (desktop) void backend.setup().then(setSetup);
    void backend.settings().then(current => vocabulary === undefined ? current : backend.saveSettings({ ...current, vocabulary })).then(setSettings);
  }, [desktop, vocabulary]);
  const install = async () => {
    setInstalling(true); setProblem('');
    try { await new Promise(resolve => setTimeout(resolve, 1500)); await backend.installTranscription(); setSetup(await backend.setup()); }
    catch (failure) { setProblem(String(failure)); }
    finally { setInstalling(false); }
  };
  return <div className="workshop-dialog-launcher">
    <button ref={launcher} className="primary" onClick={() => setOpen(true)}>Open settings</button>
    <p>Appearance changes this workshop page. Language and vocabulary save to an in-memory sample; validation matches the desktop app, and a new language's model downloads in a few seconds.</p>
    {settings && <p role="note">Saved vocabulary: {settings.vocabulary ?? 'none'}</p>}
    <SettingsDialog open={open} onClose={() => setOpen(false)} fallbackFocusRef={launcher}
      theme={theme} onTheme={next => { setTheme(next); document.documentElement.dataset.theme = next; }}
      setup={setup} installing={installing} onInstall={() => void install()} onCheckAgain={() => void backend.setup().then(setSetup)}
      onPollLanguageModel={async () => { if (!desktop) return; const model = await backend.languageModel(); setSetup(current => current && { ...current, languageModel: model ?? undefined }); }}
      onDownloadLanguageModel={backend.downloadLanguageModel}
      settings={settings} onSaveSettings={async next => setSettings(await backend.saveSettings(next))} error={problem}/>
  </div>;
}

const meta = {
  title: 'Dialog/Editing', component: DialogExample,
  args: { busy: false, error: false, destructive: false, initiallyOpen: true },
  render: args => <DialogExample key={`${args.initiallyOpen}-${args.destructive}`} {...args}/>,
} satisfies Meta<typeof DialogExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Rename: Story = {};
export const Busy: Story = { args: { busy: true } };
export const Error: Story = { args: { error: true } };
export const DeleteRecording: Story = { args: { destructive: true } };
export const OpenCloseMotion: Story = { args: { initiallyOpen: false } };
export const KeyboardFocus: Story = {
  args: { initiallyOpen: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const trigger = canvas.getByRole('button', { name: 'Open dialog' });
    await userEvent.click(trigger);
    await waitFor(() => expect(page.getByRole('textbox', { name: 'Name' })).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(page.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(trigger).toHaveFocus();
  },
};

const settingsStory = (props: SettingsProps = {}): Story => ({
  parameters: { controls: { disable: true } },
  render: () => <SettingsExample {...props}/>,
});
export const Settings: Story = settingsStory();
export const SettingsSetupNeeded: Story = settingsStory({ scenario: 'setup' });
export const SettingsInstalling: Story = settingsStory({ scenario: 'setup', installing: true });
export const SettingsInstallFailed: Story = settingsStory({ scenario: 'setup', error: 'Download failed. Check your connection and retry.' });
export const SettingsWithVocabulary: Story = settingsStory({ vocabulary: 'CueReview, Tauri, Figtree, Nadia Okafor, Quest 3' });
export const SettingsOutsideDesktop: Story = settingsStory({ desktop: false });
export const SettingsModelReady: Story = settingsStory({ language: 'en', model: { state: 'ready', receivedBytes: 0 } });
export const SettingsModelDownloading: Story = settingsStory({ language: 'de', model: { state: 'downloading', receivedBytes: 212_000_000 } });
export const SettingsModelFailed: Story = settingsStory({ language: 'en', model: { state: 'failed', receivedBytes: 0, error: 'The download was cut off.' } });
export const SettingsModelMissing: Story = settingsStory({ language: 'en', model: { state: 'missing', receivedBytes: 0 } });
/** Before transcription is installed: no download to start, and installing fetches the model. */
export const SettingsModelBeforeInstall: Story = settingsStory({ scenario: 'setup', language: 'de', model: { state: 'missing', receivedBytes: 0 } });
export const SettingsVocabularyValidation: Story = {
  ...settingsStory(),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const field = await page.findByRole('textbox', { name: 'Vocabulary' });
    await waitFor(() => expect(field).toBeEnabled());
    await userEvent.type(field, 'Café');
    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    await expect(page.getByRole('alert')).toHaveTextContent('Remove “é” (U+00E9).');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(field);
    await userEvent.type(field, ' CueReview,{Enter}Tauri ,  Nadia   Okafor');
    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    await expect(await page.findByRole('status')).toHaveTextContent('Vocabulary saved');
    await expect(field).toHaveValue('CueReview, Tauri, Nadia Okafor');
    await expect(page.getByRole('note')).toHaveTextContent('Saved vocabulary: CueReview, Tauri, Nadia Okafor');
  },
};
