import { Icon } from '../icons';
import { NAMES } from './types';
import type { SessionHeaderProps } from './types';
import './workspace.css';

/** Title row: rename on click, open folder and the "Copy for agent" pill. No metadata chips (decision 3). */
export function SessionHeader({ title, draft, renameDisabled, onRename, onOpenFolder, copyDisabled, copyBusy = false, onCopyForAgent }: SessionHeaderProps) {
  return <header className="cr-session-header">
    <h1 className="cr-session-title">
      {draft ? title : <button type="button" className="cr-rename" title={NAMES.renameRecording} disabled={renameDisabled} onClick={onRename}>{title}</button>}
    </h1>
    {!draft && <div className="cr-session-actions">
      <button type="button" className="cr-btn cr-round-button" aria-label={NAMES.openRecordingFolder} title={NAMES.openRecordingFolder} onClick={onOpenFolder}><Icon name="folder" strokeWidth={1.7}/></button>
      <button type="button" className="cr-btn cr-accent-pill" disabled={copyDisabled} aria-disabled={copyBusy || undefined} onClick={copyBusy ? undefined : onCopyForAgent}><Icon name="agent" strokeWidth={1.9}/>{NAMES.copyForAgent}</button>
    </div>}
  </header>;
}
