import { useRef } from 'react';
import type { FormEvent, RefObject } from 'react';
import { Dialog } from '../ui/Dialog';
import { NAMES } from '../workspace/types';

/** New section, Rename section and Recording name. `sessionId` moves that recording into a new section. */
export type NameDialogState = { kind: 'section' | 'renameSection' | 'renameRecording'; id?: string; sessionId?: string; value: string };

const TITLES = { section: NAMES.newSection, renameSection: NAMES.renameSectionDialog, renameRecording: NAMES.recordingNameDialog } as const;

export function NameDialog({ state, busy, error, fallbackFocusRef, onChange, onClose, onSubmit }: {
  state: NameDialogState | null;
  busy: boolean;
  error: string;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <Dialog open={!!state} onClose={onClose} title={state ? TITLES[state.kind] : ''} className="app-dialog name-dialog" busy={busy}
    initialFocusRef={input} fallbackFocusRef={fallbackFocusRef} onSubmit={onSubmit}>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <label className="app-dialog-field">{NAMES.nameField}<input ref={input} disabled={busy} maxLength={160} value={state?.value ?? ''} onChange={event => onChange(event.target.value)}/></label>
    <div className="dialog-actions">
      <button type="button" className="dialog-button" disabled={busy} onClick={onClose}>{NAMES.cancel}</button>
      <button type="submit" className="dialog-button primary" disabled={busy || !state?.value.trim()}>{busy ? 'Saving…' : NAMES.save}</button>
    </div>
  </Dialog>;
}

/** The permanent-delete confirmation. It names only what the recording folder holds. */
export function DeleteRecordingDialog({ target, busy, error, restoreFocusRef, fallbackFocusRef, onClose, onDelete }: {
  target: { id: string; name: string } | null;
  busy: boolean;
  error: string;
  restoreFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDelete: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return <Dialog open={!!target} onClose={onClose} title={NAMES.deleteRecordingDialog} role="alertdialog" className="app-dialog delete-dialog"
    description={<>Permanently delete <strong>{target?.name}</strong> and all its files: the video, audio and transcript of every take. This cannot be undone.</>}
    busy={busy} initialFocusRef={cancel} restoreFocusRef={restoreFocusRef} fallbackFocusRef={fallbackFocusRef}>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button ref={cancel} type="button" className="dialog-button" disabled={busy} onClick={onClose}>{NAMES.cancel}</button>
      <button type="button" className="dialog-button danger-button" disabled={busy} onClick={onDelete}>{busy ? 'Deleting…' : NAMES.deleteRecording}</button>
    </div>
  </Dialog>;
}
