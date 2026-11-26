import { Icon } from '../icons';
import type { DeviceGap } from '../backend';
import { NAMES } from './types';
import type { SessionHeaderProps } from './types';
import './workspace.css';

/** Device video missing from a session: its gaps summed, in ms. */
export function deviceVideoMissingMs(gaps: DeviceGap[] | undefined) {
  return (gaps ?? []).reduce((sum, gap) => sum + Math.max(0, gap.endMs - gap.startMs), 0);
}

/** A length in whole seconds, at least 1 s: "12 s", "3 min 3 s", "3 min", "1 h 2 min 5 s". */
export function formatMissing(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = seconds % 60;
  return [hours && `${hours} h`, minutes && `${minutes} min`, rest && `${rest} s`].filter(Boolean).join(' ');
}

/**
 * Title row: rename on click, open folder and the "Copy for agent" pill. No metadata chips (decision 3). A session whose
 * device dropped off USB notes under the title how much device video is missing, in meta text.
 */
export function SessionHeader({ title, draft, renameDisabled, onRename, onOpenFolder, copyDisabled, copyBusy = false, onCopyForAgent, deviceVideoMissingMs: missing }: SessionHeaderProps) {
  const heading = <h1 className="cr-session-title">
    {draft ? title : <button type="button" className="cr-rename" title={NAMES.renameRecording} disabled={renameDisabled} onClick={onRename}>{title}</button>}
  </h1>;
  const note = !draft && !!missing && missing > 0;
  return <header className="cr-session-header">
    {note ? <div className="cr-session-heading">
      {heading}
      <p className="cr-session-note" title="The device dropped off USB while recording. The video is black where it was gone; the microphone has no gap.">
        {NAMES.deviceVideoMissing(formatMissing(missing))}
      </p>
    </div> : heading}
    {!draft && <div className="cr-session-actions">
      <button type="button" className="cr-btn cr-round-button" aria-label={NAMES.openRecordingFolder} title={NAMES.openRecordingFolder} onClick={onOpenFolder}><Icon name="folder" strokeWidth={1.7}/></button>
      <button type="button" className="cr-btn cr-accent-pill" disabled={copyDisabled} aria-disabled={copyBusy || undefined} onClick={copyBusy ? undefined : onCopyForAgent}><Icon name="agent" strokeWidth={1.9}/>{NAMES.copyForAgent}</button>
    </div>}
  </header>;
}
