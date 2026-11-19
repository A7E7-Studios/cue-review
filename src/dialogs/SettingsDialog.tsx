import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { LanguageModel, Settings, SetupStatus, SpeechLanguage } from '../backend';
import { platform, shortcut } from '../chrome/windowApi';
import type { Platform, WindowTheme } from '../chrome/windowApi';
import { Icon } from '../icons';
import { Dialog } from '../ui/Dialog';
import { Switch } from '../ui/Switch';
import { NAMES } from '../workspace/types';
import type { SettingsDialogProps } from '../workspace/types';
import './SettingsDialog.css';

// The same limits and messages as src-tauri/src/settings.rs, which has the
// measurements behind them. The backend validates again when saving.
export const MAX_TERMS = 20;
export const MAX_CHARS = 200;
export const MAX_ESTIMATED_TOKENS = 75;

// Rust's `char::is_whitespace` (Unicode White_Space): pasted non-breaking spaces count as spaces.
const WHITE_SPACE = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
const SPACE = new RegExp(`[${String.fromCodePoint(...WHITE_SPACE)}]`);
const SPACES = new RegExp(`${SPACE.source}+`, 'g');
const isControl = (code: number) => code <= 0x1f || (code >= 0x7f && code <= 0x9f);
const codePoint = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

/** A rough Whisper token count, identical to `estimate_tokens` in settings.rs. */
export function estimateTokens(prompt: string): number {
  let total = 0;
  for (const piece of prompt.match(/[A-Za-z]+|[0-9]+|[^A-Za-z0-9\s]/g) ?? []) {
    if (/[A-Za-z]/.test(piece)) {
      // "HTTPServer" is HTTP + Server; "gRPC" is g + RPC.
      for (const part of piece.match(/[A-Z]{2,}(?![a-z])|[A-Z]?[a-z]+|[A-Z]/g) ?? []) {
        total += /^[A-Z]{2,}$/.test(part) ? Math.ceil(part.length / 2) : Math.ceil(part.length / 3);
      }
    } else if (/[0-9]/.test(piece)) total += Math.ceil(piece.length / 2);
    else total += 1;
  }
  return total;
}

export type VocabularyResult = { vocabulary: string | undefined } | { error: string };
/**
 * Terms separated by commas or new lines, trimmed and collapsed, without empty
 * or repeated terms, joined with ", ". `undefined` turns the prompt off.
 */
export function normalizeVocabulary(text: string): VocabularyResult {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (SPACE.test(character) || (code >= 0x21 && code <= 0x7e)) continue;
    return { error: isControl(code)
      ? `Remove the control character ${codePoint(code)} from the vocabulary.`
      : `The transcriber can only read plain ASCII letters, numbers and punctuation. Remove “${character}” (${codePoint(code)}).` };
  }
  const terms: string[] = [];
  for (const raw of text.split(/[,\n\r]/)) {
    const term = raw.split(SPACES).filter(Boolean).join(' ');
    if (term && !terms.some(seen => seen.toLowerCase() === term.toLowerCase())) terms.push(term);
  }
  if (!terms.length) return { vocabulary: undefined };
  if (terms.length > MAX_TERMS) return { error: `Use at most ${MAX_TERMS} terms. This list has ${terms.length}.` };
  const joined = terms.join(', ');
  if (joined.length > MAX_CHARS) return { error: `Keep the vocabulary to ${MAX_CHARS} characters or fewer. This list has ${joined.length}.` };
  if (estimateTokens(joined) > MAX_ESTIMATED_TOKENS) return { error: "These terms need more room than the transcriber's prompt allows. Remove a few or use shorter ones." };
  return { vocabulary: joined };
}

/** The bundled typeface's notice. The full licence ships in the app as public/licenses/Figtree-OFL.txt (dist/licenses). */
export const FONT_CREDIT = 'Figtree typeface © 2022 The Figtree Project Authors, used under the SIL Open Font License 1.1. The licence text is included with the app as licenses/Figtree-OFL.txt.';

const message = (problem: unknown) => typeof problem === 'string' ? problem : problem instanceof Error ? problem.message : String(problem);
const has = (setup: SetupStatus, names: string[]) => names.every(name => setup.dependencies?.some(item => item.name === name && item.available));

/** The Language select's value for Auto, which saves as an absent `language`. */
const AUTO = '';
/** English and German come right after Auto; every other language follows by name. */
const COMMON = [{ code: 'en', name: 'English' }, { code: 'de', name: 'German' }];
/**
 * The Language select's groups after Auto: English and German, then every other language the
 * speech model knows by its English name in alphabetical order. A saved code the list does not
 * know is kept in the last group under its code, so the select can still show it.
 */
export function languageGroups(languages: SpeechLanguage[], chosen?: string): SpeechLanguage[][] {
  const common = COMMON.map(item => languages.find(known => known.code === item.code) ?? item);
  const others = languages.filter(item => !COMMON.some(known => known.code === item.code));
  if (chosen && !common.some(item => item.code === chosen) && !others.some(item => item.code === chosen)) others.push({ code: chosen, name: chosen });
  return [common, others.sort((a, b) => a.name.localeCompare(b.name, 'en'))];
}
/** The large model, listed first among the models while Large is chosen. */
const LARGE = 'large-v3-turbo';
/** The Model select's values: Standard saves no `model`, Large saves `model: 'large'`. */
const STANDARD = '';
const LARGE_CHOICE = 'large';
/** The large model's file (`ggml-large-v3-turbo.bin` in deps.rs), named in the offer before Large is chosen. */
const LARGE_BYTES = 1_624_555_275;
const LARGE_OFFER = `Large reads every language more clearly on this graphics card; a ${(LARGE_BYTES / 1e9).toFixed(1)} GB download.`;
const CARD_HELP = 'Turn it off if a game or headset app stutters while you record.';
/** "English model" for small.en, "Multilingual model" for the multilingual small model, "Large model" for large-v3-turbo. */
export const modelName = (model: LanguageModel) => model.model === 'small.en' ? 'English model' : model.model === LARGE ? 'Large model' : 'Multilingual model';
const megabytes = (bytes: number) => Math.round(bytes / 1e6);
/** Megabytes as a row writes them, thousands separated: "488", "1,625". */
const mb = (bytes: number) => megabytes(bytes).toLocaleString('en-US');
const sentence = (text: string) => /[.!?]$/.test(text) ? text : `${text}.`;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const INSTALL_FIRST = 'Install transcription first; this model then downloads by itself.';
const AUTO_NOTE = "Auto detects each take's language: English takes use the English model, every other language the multilingual one.";
/** How long the dialog waits after one reply before it reads the downloading models or the measuring device again. */
const POLL_MS = 1000;

/** "the English and multilingual models transcribe" or "the multilingual model transcribes": the small models Large falls back on. */
function smallModelsTranscribe(models: LanguageModel[]): string {
  const names = models.map(model => model.model === 'small.en' ? 'English' : 'multilingual');
  if (!names.length) return 'the small models transcribe';
  return names.length > 1 ? `the ${names.join(' and ')} models transcribe` : `the ${names[0]} model transcribes`;
}

/** Calls `read` about each second while `active`: the next call waits for the last reply, so replies never pile up. */
function useEverySecond(active: boolean, read: () => Promise<unknown>) {
  const latest = useRef(read);
  useEffect(() => { latest.current = read; });
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer = 0;
    const next = () => { timer = window.setTimeout(() => void latest.current().then(() => { if (!stopped) next(); }), POLL_MS); };
    next();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [active]);
}

/**
 * Which takes base transcribes while some models are not ready: every recording under a fixed
 * language or with both models waiting, else under Auto the takes of the waiting model.
 */
function baseScope(auto: boolean, waiting: LanguageModel[]): string {
  if (!auto || waiting.length !== 1) return 'recordings';
  return waiting[0].model === 'small.en' ? 'English takes' : 'takes in other languages than English';
}

/** What a model row says on its right, e.g. "Downloading · 212 of 488 MB". */
export function modelState(model: LanguageModel): string {
  switch (model.state) {
    case 'ready': return 'Ready';
    case 'downloading': return model.totalBytes > 0 ? `Downloading · ${mb(model.receivedBytes)} of ${mb(model.totalBytes)} MB` : 'Downloading';
    case 'failed': return 'Download failed';
    default: return 'Not downloaded yet';
  }
}

interface ShortcutRow { action: string; keys: string[]; spoken: string }
/** Shortcut reference (decision 8): Ctrl on Windows and Linux, ⌘ on macOS. */
export function shortcutRows(os: Platform): ShortcutRow[] {
  const command = (key: string) => ({ keys: [shortcut(key, os).label], spoken: `${os === 'macos' ? 'Command' : 'Control'} ${key}` });
  return [
    { action: 'Record, stop or record more', ...command('R') },
    { action: 'New session', ...command('N') },
    { action: 'Search recordings', ...command('K') },
    { action: 'Play or pause', keys: ['Space'], spoken: 'Space' },
    { action: 'Seek back or forward 5 seconds', keys: ['←', '→'], spoken: 'Left arrow or Right arrow' },
  ];
}

/** Settings → Appearance, capability statuses, technical details, the transcription language, model, device and models, vocabulary and shortcuts (decision 14, C5). */
export function SettingsDialog({ open, onClose, fallbackFocusRef, theme, onTheme, setup, installing, onInstall, onCheckAgain, onPollLanguageModels, onDownloadLanguageModels, onPollSpeechDevice, onTestSpeechDevices, languages, settings, onSaveSettings, error }: SettingsDialogProps) {
  const stored = settings?.vocabulary ?? '';
  const [draft, setDraft] = useState(stored);
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  /** Confirmation for the last save, cleared by the next edit. */
  const [saved, setSaved] = useState('');
  const pending = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const ids = { help: useId(), problem: useId(), field: useId(), tools: useId(), transcription: useId(), languageProblem: useId(), modelProblem: useId(), shortcuts: useId() };
  const chosen = settings?.language ?? AUTO;
  /** Shown at once while the choice saves; the stored language again if saving fails. */
  const [language, setLanguage] = useState<string>(chosen);
  const [languageProblem, setLanguageProblem] = useState('');
  const storedModel = settings?.model === 'large' ? LARGE_CHOICE : STANDARD;
  /** The Model select, likewise shown at once and restored if saving fails. */
  const [modelChoice, setModelChoice] = useState(storedModel);
  const [modelProblem, setModelProblem] = useState('');
  const storedCardOn = settings?.graphicsCard !== false;
  /** The graphics-card switch, likewise. */
  const [cardOn, setCardOn] = useState(storedCardOn);
  /** A refused switch or test, shown in the device's fold. */
  const [deviceProblem, setDeviceProblem] = useState('');
  const [testing, setTesting] = useState(false);
  const [starting, setStarting] = useState(false);
  const pollModel = useRef(onPollLanguageModels);
  const pollDevice = useRef(onPollSpeechDevice);
  useEffect(() => { pollModel.current = onPollLanguageModels; pollDevice.current = onPollSpeechDevice; });
  /** One read of the models' states; a failed read only waits for the next. */
  const readModel = () => pollModel.current().catch(() => {});
  /** One read of the speech device, likewise. */
  const readDevice = () => pollDevice.current().catch(() => {});

  const device = setup?.speechDevice;
  const card = device?.card;
  const measuring = device?.state === 'measuring';
  /** The card stopped during a transcription: the line warns, and its fold opens by itself to say so. */
  const stopped = !!card?.stopped && !measuring;
  const [unfolded, setUnfolded] = useState(stopped);

  // Opening, loading or saving shows the stored value.
  useEffect(() => { setDraft(stored); setProblem(''); }, [stored, open]);
  useEffect(() => { setLanguage(chosen); }, [chosen, open]);
  useEffect(() => { setModelChoice(storedModel); }, [storedModel, open]);
  useEffect(() => { setCardOn(storedCardOn); }, [storedCardOn, open]);
  useEffect(() => { if (open) { setSaved(''); setLanguageProblem(''); setModelProblem(''); setDeviceProblem(''); setUnfolded(stopped); } }, [open]);
  useEffect(() => { if (stopped) setUnfolded(true); }, [stopped]);

  const models = setup?.languageModels ?? [];
  const large = models.find(model => model.model === LARGE);
  /** Transcription runs on the graphics card now; the switch counts at once, before the device is read again. */
  const onCard = cardOn && device?.kind === 'graphicsCard';
  /** Large transcribes now, as the backend decided once it tried Large on the card. */
  const largeInUse = onCard && !!device?.largeInUse && large?.state === 'ready';
  /**
   * Large is chosen, installed and offered, the switch is on and the card not stopped, and the backend has not yet
   * decided whether it keeps up: it tries Large on the card in a measurement, so this includes `measuring`.
   */
  const largeTrying = large?.state === 'ready' && !!device?.largeOffered && !device.largeInUse && !device.largeSlow && cardOn && !card?.stopped;

  // While a language model downloads, the states are read about each second so its progress moves;
  // while the devices are measured or Large is tried, the device is, so the line and the note follow.
  // Large that is not offered is never tried, so it is never waited for.
  useEverySecond(open && models.some(model => model.state === 'downloading'), readModel);
  useEverySecond(open && (measuring || largeTrying), readDevice);
  // A download that ends (downloading, then ready or failed) can change what the backend transcribes with: one read.
  const downloadingBefore = useRef<LanguageModel['model'][]>([]);
  useEffect(() => {
    const ended = downloadingBefore.current.some(name => { const state = models.find(model => model.model === name)?.state; return state === 'ready' || state === 'failed'; });
    downloadingBefore.current = models.filter(model => model.state === 'downloading').map(model => model.model);
    if (open && ended) void readDevice();
  }, [setup?.languageModels, open]);

  // Choosing saves at once and keeps the vocabulary as stored; Auto saves no language. The backend
  // has marked the language's models downloading by the time it returns, so one read starts the progress.
  const chooseLanguage = async (next: string) => {
    if (!settings) return;
    setLanguage(next); setLanguageProblem('');
    try { await onSaveSettings({ ...settings, language: next === AUTO ? undefined : next } satisfies Settings); void readModel(); }
    catch (failure) { setLanguage(chosen); setLanguageProblem(message(failure)); }
  };
  // Large starts its download the way a language does; Standard saves no model.
  const chooseModel = async (next: string) => {
    if (!settings) return;
    setModelChoice(next); setModelProblem('');
    try { await onSaveSettings({ ...settings, model: next === LARGE_CHOICE ? 'large' : undefined } satisfies Settings); void readModel(); }
    catch (failure) { setModelChoice(storedModel); setModelProblem(message(failure)); }
  };
  // Off saves `graphicsCard: false`, on removes it; one read of the device then shows where transcription runs.
  const switchCard = async (next: boolean) => {
    if (!settings) return;
    setCardOn(next); setDeviceProblem('');
    try { await onSaveSettings({ ...settings, graphicsCard: next ? undefined : false } satisfies Settings); void readDevice(); }
    catch (failure) { setCardOn(storedCardOn); setDeviceProblem(message(failure)); }
  };
  // The button stays focusable but inert while the devices are measured, so focus stays on it.
  const testDevices = async () => {
    if (testing || measuring) return;
    setTesting(true); setDeviceProblem('');
    try { await onTestSpeechDevices(); }
    catch (failure) { setDeviceProblem(message(failure)); }
    finally { setTesting(false); }
  };
  const download = async () => {
    if (starting) return;
    setStarting(true); setLanguageProblem('');
    try { await onDownloadLanguageModels(); void readModel(); }
    catch (failure) { setLanguageProblem(message(failure)); }
    finally { setStarting(false); }
  };

  // Nothing is disabled while saving, so focus never drops out of the modal.
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    const result = normalizeVocabulary(draft);
    if ('error' in result) { setProblem(result.error); setSaved(''); field.current?.focus(); return; }
    pending.current = true; setSaving(true); setProblem(''); setSaved('');
    try {
      await onSaveSettings({ ...settings, vocabulary: result.vocabulary } satisfies Settings);
      setDraft(result.vocabulary ?? '');
      setSaved(result.vocabulary ? 'Vocabulary saved' : 'Vocabulary cleared');
    } catch (failure) { setProblem(message(failure)); field.current?.focus(); }
    finally { pending.current = false; setSaving(false); }
  };

  const statuses = setup ? [
    { label: 'Capture and playback', available: has(setup, ['ffmpeg', 'ffprobe']), optional: false },
    { label: 'Transcription', available: !!setup.modelReady && has(setup, ['whisper-cli', 'whisper-vad-speech-segments']), optional: false },
    { label: 'USB devices', available: has(setup, ['adb', 'scrcpy']), optional: true },
  ] : [];
  const needsInstall = !!setup && (!setup.modelReady || !!setup.dependencies?.some(item => (item.name === 'whisper-cli' || item.name === 'whisper-vad-speech-segments') && !item.available));
  const os = platform();
  const auto = chosen === AUTO;
  const groups = languageGroups(languages, auto ? undefined : chosen);
  const named = groups.flat().find(item => item.code === chosen)?.name ?? chosen;
  const small = models.filter(model => model.model !== LARGE);
  const waiting = models.filter(model => model.state !== 'ready');
  const waitingSmall = small.filter(model => model.state !== 'ready');
  const failed = waiting.some(model => model.state === 'failed');
  const fetching = waiting.some(model => model.state === 'downloading');
  const scope = baseScope(auto, waitingSmall);
  const smallTranscribe = smallModelsTranscribe(small);

  /** The Model select: offered on a card fast enough for Large, and kept while Large is saved so Standard can be chosen again. */
  const modelOffered = !!device?.largeOffered || storedModel === LARGE_CHOICE;
  /** With Large in use, the small models move into the device's fold as the fallback. */
  const fallbackFolded = largeInUse && small.length > 0 && !waitingSmall.length;
  const rows = fallbackFolded ? models.filter(model => model.model === LARGE) : models;
  /**
   * The test is offered where the runtime can measure the devices and no card works: none measured faster, it
   * stopped, or the devices are being measured.
   */
  const offerTest = !!device?.measurable && (!card || stopped || measuring);
  /** The line unfolds only onto something; otherwise it is a plain line. */
  const foldHolds = stopped || !!card || fallbackFolded || offerTest || !!deviceProblem;

  /** The one note that ends the models: what transcribes, or what waits for a download. */
  const note = (() => {
    if (!waiting.length) {
      if (large) {
        if (largeInUse) return 'The large model transcribes every language on the graphics card.';
        if (device?.largeSlow && onCard) return `The large model did not keep up on this graphics card, so ${smallTranscribe}.`;
        if (largeTrying) return `Large is being tried on the graphics card; until then, ${smallTranscribe}.`;
        if (!cardOn) return `With the graphics card off, ${smallTranscribe}.`;
        if (stopped) return `With the graphics card stopped, ${smallTranscribe}.`;
        // On the card, neither in use, tried nor slow: the last measurement no longer offers Large.
        if (onCard) return `This graphics card is not fast enough for the large model, so ${smallTranscribe}.`;
        return `Without the graphics card, ${smallTranscribe}.`;
      }
      const fixed = auto ? AUTO_NOTE : `Every take is transcribed as ${named}, whatever is spoken.`;
      const offer = modelChoice === STANDARD && !!device?.largeOffered && !!card && !stopped && cardOn;
      return offer ? `${fixed} ${LARGE_OFFER}` : fixed;
    }
    // Without transcription installed there is no base model to fall back on, and the backend refuses the download.
    if (needsInstall) return fetching ? undefined : INSTALL_FIRST;
    if (failed) return undefined;
    if (waitingSmall.length) {
      const several = waitingSmall.length > 1;
      return fetching ? `Until ${several ? 'they finish' : 'it finishes'}, ${scope} are transcribed with the base model.`
        : `${capital(scope)} are transcribed with the base model until ${several ? 'they are' : 'it is'} installed.`;
    }
    // Only the large model waits: the small models transcribe meanwhile.
    return fetching ? `Until it finishes, ${smallTranscribe}.` : `${capital(smallTranscribe)} until it is installed.`;
  })();

  /** "Runs on NVIDIA GeForce RTX 5090", with what the measurement or a stopped card adds. */
  const deviceLine = device && <>
    {stopped && <Icon name="warning"/>}
    <span className="settings-device-label">Runs on</span> <span className="settings-device-name">{onCard ? device.name ?? card?.name : 'the processor'}</span>
    {measuring ? <span className="settings-device-label"> · testing the graphics card…</span>
      : stopped && <span className="settings-device-label"> · the graphics card stopped</span>}
  </>;

  const modelRow = (model: LanguageModel) => {
    /**
     * Large, installed and neither in use, being tried nor slow: it waits for the graphics card (switched off,
     * stopped, none measured faster) or, on the card, for one fast enough (no longer offered).
     */
    const idle = model.model === LARGE && model.state === 'ready' && !largeInUse && !largeTrying && !(device?.largeSlow && onCard);
    const ready = model.state === 'ready' && !idle;
    /** What transcribes until a failed model is installed. */
    const meanwhile = model.model === LARGE ? `${capital(smallTranscribe)} until it is installed.` : `${capital(scope)} are transcribed with the base model until it is installed.`;
    return <Fragment key={model.model}>
      <div className="settings-status" data-available={ready || undefined}>
        <span>{modelName(model)}</span>
        <span>{ready && <Icon name="check"/>}{idle ? onCard ? 'Needs a faster graphics card' : 'Needs the graphics card' : modelState(model)}</span>
      </div>
      {model.state === 'downloading' && <div className="settings-progress" role="progressbar" aria-label={NAMES.modelDownload(modelName(model))}
        aria-valuemin={0} aria-valuemax={model.totalBytes > 0 ? megabytes(model.totalBytes) : undefined}
        aria-valuenow={model.totalBytes > 0 ? Math.min(megabytes(model.receivedBytes), megabytes(model.totalBytes)) : undefined}
        aria-valuetext={model.totalBytes > 0 ? `${mb(model.receivedBytes)} of ${mb(model.totalBytes)} MB` : undefined}>
        <span style={{ width: `${model.totalBytes > 0 ? Math.min(100, model.receivedBytes / model.totalBytes * 100) : 0}%` }}/>
      </div>}
      {model.state === 'failed' && <p className="settings-issue">{sentence(model.error?.trim() || 'The download did not finish')}{needsInstall ? '' : ` ${meanwhile}`}</p>}
    </Fragment>;
  };

  return <Dialog open={open} onClose={onClose} title={NAMES.settingsDialog} className="settings-dialog" closeLabel={NAMES.closeSettings} fallbackFocusRef={fallbackFocusRef}>
    <div className="settings-row settings-appearance">
      <label htmlFor={`${ids.field}-theme`}>{NAMES.appearance}</label>
      <select id={`${ids.field}-theme`} value={theme} disabled={installing} onChange={event => onTheme(event.target.value as WindowTheme)}>
        <option value="light">Light</option><option value="dark">Dark</option>
      </select>
    </div>
    {error && <p className="dialog-error settings-error" role="alert">{error}</p>}

    <section className="settings-section" aria-labelledby={ids.tools}>
      <h3 id={ids.tools}>Recording tools</h3>
      {setup ? <>
        <div className="settings-statuses">{statuses.map(item => <div className="settings-status" data-available={item.available || undefined} key={item.label}>
          <span>{item.label}</span>
          <span><Icon name={item.available ? 'check' : 'warning'}/>{item.available ? 'Available' : item.optional ? 'Optional setup' : 'Setup needed'}</span>
        </div>)}</div>
        {setup.issues.map((issue, index) => <p className="settings-issue" key={index}>{issue}</p>)}
        {needsInstall && <button type="button" className="settings-pill settings-primary" disabled={installing} onClick={onInstall}>{installing ? NAMES.downloadingSpeechTools : NAMES.installTranscription}</button>}
        {installing && <p className="settings-note" role="status">Downloading the speech model and tools. This may take a few minutes.</p>}
        <div className="settings-tool-actions">
          <details className="settings-details"><summary>Technical details</summary>
            {setup.dependencies?.map(item => <div className="settings-dependency" data-available={item.available || undefined} key={item.name}><Icon name={item.available ? 'check' : 'warning'}/><div><strong>{item.name}</strong><small>{item.detail || item.path || (item.available ? 'Available' : 'Missing')}</small></div></div>)}
          </details>
          <button type="button" className="settings-pill" disabled={installing} onClick={onCheckAgain}><Icon name="refresh"/>{NAMES.checkAgain}</button>
        </div>
      </> : <p className="settings-note">Start the desktop app to inspect installed recording tools.</p>}
    </section>

    <section className="settings-section settings-transcription" aria-labelledby={ids.transcription}>
      <h3 id={ids.transcription}>Transcription</h3>
      <div className="settings-row">
        <label htmlFor={`${ids.field}-language`}>{NAMES.language}</label>
        <select id={`${ids.field}-language`} className="settings-language" value={language} disabled={!settings || installing}
          aria-describedby={languageProblem ? ids.languageProblem : undefined} onChange={event => void chooseLanguage(event.target.value)}>
          {/* The open list shows the hint beside Auto (SettingsDialog.css); the closed select reads "Auto" alone. */}
          <option value={AUTO} data-hint="detect each take">Auto</option>
          {groups.map((group, index) => <Fragment key={index}>
            <hr/>
            {group.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}
          </Fragment>)}
        </select>
      </div>
      {modelOffered && <div className="settings-row">
        <label htmlFor={`${ids.field}-model`}>{NAMES.model}</label>
        <select id={`${ids.field}-model`} value={modelChoice} disabled={!settings || installing}
          aria-describedby={modelProblem ? ids.modelProblem : undefined} onChange={event => void chooseModel(event.target.value)}>
          <option value={STANDARD}>Standard</option>
          <option value={LARGE_CHOICE}>Large</option>
        </select>
      </div>}
      {rows.map(modelRow)}
      {models.length > 0 && <>
        {note && <p className="settings-note">{note}</p>}
        {!needsInstall && waiting.length > 0 && !fetching && <div className="settings-actions">
          <button type="button" className="settings-pill" disabled={installing} aria-disabled={starting || undefined} onClick={() => void download()}>
            {failed ? NAMES.retryModelDownload : NAMES.downloadModel}
          </button>
        </div>}
      </>}
      {languageProblem && <p id={ids.languageProblem} className="settings-field-error" role="alert">{languageProblem}</p>}
      {modelProblem && <p id={ids.modelProblem} className="settings-field-error" role="alert">{modelProblem}</p>}
      {/* Where transcription runs: one folded line, which unfolds onto the switch, the test and the fallback models. */}
      {device && !foldHolds && <p className="settings-device settings-device-line">{deviceLine}</p>}
      {device && foldHolds && <details className="settings-device" open={unfolded} data-warning={stopped || undefined}
        onToggle={event => setUnfolded(event.currentTarget.open)}>
        <summary>{deviceLine}</summary>
        {stopped && <p className="settings-issue">The {card?.name} stopped during a transcription, so the processor transcribes until it is tested again.</p>}
        {card && <Switch label={NAMES.useGraphicsCard} help={CARD_HELP} checked={cardOn}
          disabled={!settings || installing} onChange={next => void switchCard(next)}/>}
        {fallbackFolded && <>
          <p className="settings-note settings-fallback">Fallback when the graphics card is off:</p>
          {small.map(modelRow)}
        </>}
        {offerTest && <div className="settings-actions">
          <button type="button" className="settings-pill" disabled={installing} aria-disabled={testing || measuring || undefined} onClick={() => void testDevices()}>
            <Icon name="refresh"/>{NAMES.testGraphicsCard}
          </button>
        </div>}
        {deviceProblem && <p className="settings-field-error" role="alert">{deviceProblem}</p>}
      </details>}
    </section>

    <form className="settings-section settings-vocabulary" onSubmit={event => void save(event)} noValidate>
      <label htmlFor={ids.field}>{NAMES.vocabulary}</label>
      <textarea id={ids.field} ref={field} rows={3} spellCheck={false} value={draft} disabled={!settings} readOnly={saving}
        aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${ids.problem} ${ids.help}` : ids.help}
        placeholder={settings ? 'CueReview, Tauri, Nadia Okafor' : undefined}
        onChange={event => { setDraft(event.target.value); setProblem(''); setSaved(''); }}/>
      <p id={ids.help} className="settings-help">Names and terms the transcriber should expect, separated by commas.</p>
      {problem && <p id={ids.problem} className="settings-field-error" role="alert">{problem}</p>}
      <div className="settings-actions">
        {saved && <span className="settings-saved" role="status"><Icon name="check"/>{saved}</span>}
        <button type="submit" className="settings-pill settings-primary" disabled={!settings} aria-disabled={saving || undefined}>{saving ? 'Saving…' : NAMES.save}</button>
      </div>
    </form>

    <section className="settings-section" aria-labelledby={ids.shortcuts}>
      <h3 id={ids.shortcuts}>Keyboard shortcuts</h3>
      <dl className="settings-shortcuts">{shortcutRows(os).map(row => <div key={row.action}>
        <dt>{row.action}</dt>
        <dd><span aria-hidden="true">{row.keys.map(key => <kbd key={key}>{key}</kbd>)}</span><span className="settings-sr-only">{row.spoken}</span></dd>
      </div>)}</dl>
    </section>

    <p className="settings-about">{FONT_CREDIT}</p>
  </Dialog>;
}
