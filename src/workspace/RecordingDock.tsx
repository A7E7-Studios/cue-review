import { Icon } from '../icons';
import { formatTimer } from '../review';
import { shortcut } from '../chrome/windowApi';
import type { Platform } from '../chrome/windowApi';
import { NAMES } from './types';
import type { RecordingDockProps } from './types';
import './workspace.css';

/** Bar heights of the level meter, from the Float v2 mock. */
const METER = [8, 12, 16, 20, 15, 22, 12, 9, 6, 4];
/** Lit bars from this index on use the high colour. */
const METER_HIGH = 5;

export interface RecordingDockViewProps extends RecordingDockProps {
  /** Shortcut labels follow this platform; detected from the user agent when omitted. */
  platform?: Platform;
}

/**
 * The dark dock that replaces the playback bar while recording (decision 6). No progress bar.
 * It stays on one row: as its slot narrows, workspace.css drops the source and Stop labels to
 * icons (their names stay as visually hidden text), then the take label, then the meter. Stop is always shown.
 */
export function RecordingDock({ elapsedMs, take, audioLevel, sourceName, hasMicrophone, muted, onMuted, compact, onToggleCompact, stopDisabled, onStop, platform }: RecordingDockViewProps) {
  const stop = shortcut('r', platform);
  const level = Math.min(1, Math.max(0, Number.isFinite(audioLevel) ? audioLevel! : 0));
  const lit = Math.round(level * METER.length);
  const meter = hasMicrophone && !muted;
  return <div className="cr-dock-slot" role="group" aria-label={NAMES.recordingControls} data-compact={compact || undefined}>
    <div className="cr-dock">
      <p className="cr-dock-timer" role="timer" aria-label={NAMES.takeTimer(take)}>
        <span className="cr-dock-live" aria-hidden="true"/>
        <span className="cr-dock-clock">{formatTimer(elapsedMs)}</span>
        {take >= 2 && <span className="cr-dock-take">Take {take}</span>}
      </p>
      {meter && <span className="cr-meter" role="meter" aria-label={NAMES.microphoneLevel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} aria-valuetext={`${Math.round(level * 100)}%`}>
        {METER.map((height, index) => <span key={index} aria-hidden="true" data-level={index >= lit ? 'off' : index >= METER_HIGH ? 'high' : 'low'} style={{ height }}/>)}
      </span>}
      <span className="cr-dock-divider" aria-hidden="true"/>
      <button type="button" className="cr-btn cr-dock-source" disabled title={`${sourceName}. The source is locked while recording.`}><Icon name="monitor" strokeWidth={1.7}/><span className="cr-dock-label">{sourceName}</span></button>
      {hasMicrophone && <button type="button" className="cr-btn cr-dock-button" aria-label={NAMES.muteMicrophone} aria-pressed={muted} title={muted ? 'Unmute microphone' : NAMES.muteMicrophone} onClick={() => onMuted(!muted)}>
        <Icon name={muted ? 'micOff' : 'mic'} strokeWidth={1.7}/>
      </button>}
      <button type="button" className="cr-btn cr-dock-button" aria-label={compact ? NAMES.expand : NAMES.compact} title={compact ? 'Restore workspace' : 'Compact recording mode'} onClick={onToggleCompact}>
        <Icon name={compact ? 'expand' : 'compact'} strokeWidth={1.7}/>
      </button>
      <button type="button" className="cr-btn cr-stop" title={`Stop recording (${stop.label})`} aria-keyshortcuts={stop.aria} aria-disabled={stopDisabled || undefined} onClick={stopDisabled ? undefined : onStop}>
        <span className="cr-stop-square" aria-hidden="true"/><span className="cr-dock-label">{NAMES.stop}</span>
      </button>
    </div>
    {take >= 2 && <p className="cr-dock-caption">Adding to this session. Stop to process take {take} on this device.</p>}
  </div>;
}
