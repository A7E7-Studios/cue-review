import { Icon } from '../icons';
import { formatTime } from '../review';
import type { Platform } from '../chrome/windowApi';
import { Scrubber } from './Scrubber';
import { NAMES } from './types';
import type { PlaybackBarProps } from './types';
import './workspace.css';

export interface PlaybackBarViewProps extends PlaybackBarProps {
  /** Shortcut labels follow this platform; detected from the user agent when omitted. */
  platform?: Platform;
}

/** Review controls: scrubber, play, time, speed and focus (decision 6). The recording bar sits under them. */
export function PlaybackBar({ timeMs, durationMs, segments, takes, onSeek, playing, canPlay, onTogglePlay, speed, onCycleSpeed, focused, onToggleFocus }: PlaybackBarViewProps) {
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
    </div>
  </div>;
}
