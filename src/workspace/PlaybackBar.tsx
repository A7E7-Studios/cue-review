import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
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

/** The speeds the speed list offers, as YouTube's does. */
export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/**
 * The playback speed: a button of fixed width showing the current speed, opening a list of speeds
 * above it with a check on the current one (playback-controls spec). The list takes focus on the
 * current speed; arrows, Home and End move, Enter or Space chooses, Escape closes, and focus
 * returns to the button.
 */
function SpeedControl({ speed, onSpeed }: { speed: number; onSpeed: (speed: number) => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !list.current?.contains(event.target) && !button.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const close = () => { setOpen(false); button.current?.focus(); };
  const choose = (value: number) => { if (value !== speed) onSpeed(value); close(); };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    // The list handles its own keys, so Space chooses here instead of playing or pausing.
    event.stopPropagation();
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[event.key];
    if (move !== undefined) { event.preventDefault(); items[(move + items.length) % items.length]?.focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Tab') setOpen(false);
  };
  return <span className="cr-speed-anchor">
    <button ref={button} type="button" className="cr-btn cr-speed" aria-label={NAMES.playbackSpeed(speed)} title={NAMES.playbackSpeedList}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}>{speed}×</button>
    {open && <div ref={list} id={id} className="cr-speed-menu" role="menu" aria-label={NAMES.playbackSpeedList} onKeyDown={keys}>
      {PLAYBACK_SPEEDS.map(value => <button key={value} type="button" role="menuitemradio" aria-checked={value === speed} tabIndex={value === speed ? 0 : -1}
        aria-label={value === 1 ? `${value}× ${NAMES.normalSpeed}` : `${value}×`} onClick={() => choose(value)}>
        <span className="cr-speed-check" aria-hidden="true">{value === speed && <Icon name="check" strokeWidth={2}/>}</span>
        {value}×{value === 1 && <span className="cr-speed-normal">{NAMES.normalSpeed}</span>}
      </button>)}
    </div>}
  </span>;
}

/** Review controls: scrubber, play, time, speed and focus (decision 6). The recording bar sits under them. */
export function PlaybackBar({ timeMs, durationMs, segments, takes, onSeek, playing, canPlay, onTogglePlay, speed, onSpeed, focused, onToggleFocus }: PlaybackBarViewProps) {
  return <div className="cr-playback" role="group" aria-label={NAMES.playback}>
    <Scrubber timeMs={timeMs} durationMs={durationMs} segments={segments} takes={takes} onSeek={onSeek}/>
    <div className="cr-playback-row">
      <button type="button" className="cr-btn cr-play" data-playing={playing} aria-label={playing ? NAMES.pause : NAMES.play} title={`${playing ? NAMES.pause : NAMES.play} (Space)`} disabled={!canPlay} onClick={onTogglePlay}>
        {playing ? <Icon name="pause" strokeWidth={2.6}/> : <Icon name="play" filled/>}
      </button>
      <p className="cr-time">{formatTime(timeMs)} <span>/ {formatTime(durationMs)}</span></p>
      <span className="cr-spacer"/>
      <SpeedControl speed={speed} onSpeed={onSpeed}/>
      {/* One toggle hides and restores both sidebars; it keeps its icon and shows pressed. */}
      <button type="button" className="cr-btn cr-round-button cr-ghost cr-focus" aria-label={NAMES.focusVideo} aria-pressed={focused}
        title={focused ? NAMES.leaveFocus : NAMES.focusVideo} onClick={onToggleFocus}>
        <Icon name="expand" strokeWidth={1.8}/>
      </button>
    </div>
  </div>;
}
