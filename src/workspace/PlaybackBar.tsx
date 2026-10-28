import { Icon } from '../icons';
import { formatTime } from '../review';
import { shortcut } from '../chrome/windowApi';
import type { Platform } from '../chrome/windowApi';
import { Scrubber } from './Scrubber';
import { NAMES } from './types';
import type { PlaybackBarProps } from './types';
import './workspace.css';

export interface PlaybackBarViewProps extends PlaybackBarProps {
  /** Shortcut labels follow this platform; detected from the user agent when omitted. */
  platform?: Platform;
}

/** Review controls: scrubber, play, time, speed, focus and the Record more pill (decision 6). */
export function PlaybackBar({ timeMs, durationMs, segments, takes, onSeek, playing, canPlay, onTogglePlay, speed, onCycleSpeed, focused, onToggleFocus, recordMoreDisabled, recordMoreBusy = false, onRecordMore, platform }: PlaybackBarViewProps) {
  const record = shortcut('r', platform);
  return <div className="cr-playback" role="group" aria-label={NAMES.playback}>
    <Scrubber timeMs={timeMs} durationMs={durationMs} segments={segments} takes={takes} onSeek={onSeek}/>
    <div className="cr-playback-row">
      <button type="button" className="cr-btn cr-play" data-playing={playing} aria-label={playing ? NAMES.pause : NAMES.play} title={`${playing ? NAMES.pause : NAMES.play} (Space)`} disabled={!canPlay} onClick={onTogglePlay}>
        {playing ? <Icon name="pause" strokeWidth={2.6}/> : <Icon name="play" filled/>}
      </button>
      <p className="cr-time">{formatTime(timeMs)} <span>/ {formatTime(durationMs)}</span></p>
      <span className="cr-spacer"/>
      <button type="button" className="cr-btn cr-speed" aria-label={NAMES.playbackSpeed(speed)} title="Playback speed" onClick={onCycleSpeed}>{speed}×</button>
      <button type="button" className="cr-btn cr-round-button cr-ghost" aria-label={focused ? NAMES.restoreTranscript : NAMES.focusVideo} title={focused ? NAMES.restoreTranscript : NAMES.focusVideo} onClick={onToggleFocus}>
        <Icon name={focused ? 'panel' : 'expand'} strokeWidth={1.8}/>
      </button>
      <span className="cr-control-divider" aria-hidden="true"/>
      <button type="button" className="cr-btn cr-dark-pill" title={`${NAMES.recordMore} (${record.label}): continue this session as a new take`} aria-keyshortcuts={record.aria} disabled={recordMoreDisabled} aria-disabled={recordMoreBusy || undefined} onClick={recordMoreBusy ? undefined : onRecordMore}>
        <span className="cr-record-dot" aria-hidden="true"/>{NAMES.recordMore}
      </button>
    </div>
  </div>;
}
