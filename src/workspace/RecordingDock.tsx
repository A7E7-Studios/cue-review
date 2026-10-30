import { useId } from 'react';
import { Icon } from '../icons';
import { formatTimer } from '../review';
import { shortcut } from '../chrome/windowApi';
import type { Platform } from '../chrome/windowApi';
import { NAMES } from './types';
import type { RecordingDockProps } from './types';
import './workspace.css';

/** Bar heights of the level meter, from the Float v2 mock. */
const METER = [8, 12, 16, 20, 15, 22, 12, 9, 6, 4];
/** The meter's floor and the decibels each bar stands for: bar n lights above −60 + 6(n − 1) dBFS, so the ninth and tenth light above −12 and −6 dBFS. */
const METER_FLOOR_DB = -60;
const METER_STEP_DB = 6;
/** Lit bars from this index on (above −12 dBFS) use the high colour. */
const METER_HIGH = 8;

/** A linear RMS level (0 to 1) in dBFS, floored at the meter's floor. */
export function levelDb(level: number) {
  return level > 0 ? Math.max(METER_FLOOR_DB, 20 * Math.log10(level)) : METER_FLOOR_DB;
}
/** Bars lit for a linear RMS level: one for each 6 dB step above −60 dBFS it reaches into. */
export function litBars(level: number) {
  return Math.min(METER.length, Math.ceil((levelDb(level) - METER_FLOOR_DB) / METER_STEP_DB));
}
/**
 * The part of a microphone's name that tells devices apart: "Default — Microphone (HD Pro Webcam C920)"
 * reads "HD Pro Webcam C920". Windows wraps the device in its one-word endpoint name, in the system's
 * language ("Mikrofon (…)"); a longer name such as "Headset Microphone (…)" is kept whole.
 */
export function shortMicrophoneName(name: string) {
  const device = name.replace(/^Default\s+[—-]\s+/, '');
  return device.match(/^[\p{L}\p{M}]+ \((.+)\)$/u)?.[1] ?? device;
}

export interface RecordingDockViewProps extends RecordingDockProps {
  /** Shortcut labels follow this platform; detected from the user agent when omitted. */
  platform?: Platform;
}

/**
 * The dark dock that replaces the playback bar while recording (decision 6). No progress bar.
 * It stays on one row: as its slot narrows, workspace.css drops the source and Stop labels to
 * icons (their names stay as visually hidden text), then the microphone's name, then the meter.
 * Stop is always shown. The take shows only in the timer's name and the transcript's divider: the
 * dock keeps one width from take to take, and muting keeps it too.
 */
export function RecordingDock({ elapsedMs, take, audioLevel, sourceName, hasMicrophone, microphoneName, muted, onMuted, compact, onToggleCompact, stopDisabled, onStop, platform }: RecordingDockViewProps) {
  const stop = shortcut('r', platform);
  const nameId = useId();
  const level = muted ? 0 : Math.min(1, Math.max(0, Number.isFinite(audioLevel) ? audioLevel! : 0));
  const lit = litBars(level);
  const db = Math.round(levelDb(level));
  const device = microphoneName || 'Microphone';
  return <div className="cr-dock-slot" role="group" aria-label={NAMES.recordingControls} data-compact={compact || undefined}>
    <div className="cr-dock">
      <p className="cr-dock-timer" role="timer" aria-label={NAMES.takeTimer(take)}>
        <span className="cr-dock-live" aria-hidden="true"/>
        <span className="cr-dock-clock">{formatTimer(elapsedMs)}</span>
      </p>
      <span className="cr-dock-divider" aria-hidden="true"/>
      <button type="button" className="cr-btn cr-dock-source" disabled title={`${sourceName}. The source is locked while recording.`}><Icon name="monitor" strokeWidth={1.7}/><span className="cr-dock-label">{sourceName}</span></button>
      {/* The chip is the toggle. Its name and meter lie over it as siblings: a button cannot hold a meter, and the
          button's accessible name stays "Mute microphone", with the name (or Muted) as its description; hidden from the
          tree on its own, so a screen reader does not read it twice. */}
      {hasMicrophone && <span className="cr-mic-chip" data-muted={muted || undefined}>
        <button type="button" className="cr-btn cr-mic-toggle" aria-label={NAMES.muteMicrophone} aria-pressed={muted} aria-describedby={nameId}
          title={`${muted ? 'Unmute' : 'Mute'} ${device}`} onClick={() => onMuted(!muted)}>
          <Icon name={muted ? 'micOff' : 'mic'} strokeWidth={1.7}/>
        </button>
        <span id={nameId} className="cr-mic-name" aria-hidden="true">{muted ? NAMES.muted : shortMicrophoneName(device)}</span>
        <span className="cr-meter" role="meter" aria-label={NAMES.microphoneLevel} aria-valuemin={METER_FLOOR_DB} aria-valuemax={0} aria-valuenow={db}
          aria-valuetext={muted ? NAMES.muted : `${db} dB`}>
          {METER.map((height, index) => <span key={index} aria-hidden="true" data-level={index >= lit ? 'off' : index >= METER_HIGH ? 'high' : 'low'} style={muted ? undefined : { height }}/>)}
        </span>
      </span>}
      <button type="button" className="cr-btn cr-dock-button" aria-label={compact ? NAMES.expand : NAMES.compact} title={compact ? 'Restore workspace' : 'Compact recording mode'} onClick={onToggleCompact}>
        <Icon name={compact ? 'expand' : 'compact'} strokeWidth={1.7}/>
      </button>
      <button type="button" className="cr-btn cr-stop" title={`Stop recording (${stop.label})`} aria-keyshortcuts={stop.aria} aria-disabled={stopDisabled || undefined} onClick={stopDisabled ? undefined : onStop}>
        <span className="cr-stop-square" aria-hidden="true"/><span className="cr-dock-label">{NAMES.stop}</span>
      </button>
    </div>
  </div>;
}
