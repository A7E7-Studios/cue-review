import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Settings, SetupStatus } from '../backend';
import { platform, shortcut } from '../chrome/windowApi';
import type { Platform, WindowTheme } from '../chrome/windowApi';
import { Icon } from '../icons';
import { Dialog } from '../ui/Dialog';
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

/** Settings → Appearance, capability statuses, technical details, vocabulary and shortcuts (decision 14, C5). */
export function SettingsDialog({ open, onClose, fallbackFocusRef, theme, onTheme, setup, installing, onInstall, onCheckAgain, settings, onSaveSettings, error }: SettingsDialogProps) {
  const stored = settings?.vocabulary ?? '';
  const [draft, setDraft] = useState(stored);
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  /** Confirmation for the last save, cleared by the next edit. */
  const [saved, setSaved] = useState('');
  const pending = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const ids = { help: useId(), problem: useId(), field: useId(), tools: useId(), shortcuts: useId() };

  // Opening, loading or saving shows the stored value.
  useEffect(() => { setDraft(stored); setProblem(''); }, [stored, open]);
  useEffect(() => { if (open) setSaved(''); }, [open]);

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
