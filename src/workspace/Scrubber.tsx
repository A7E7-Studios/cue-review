import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { NAMES } from './types';
import type { ScrubberProps } from './types';
import { keyboardSeek, pointerToMs, positionText, speechRuns, takeTicks, toPercent } from './scrubberGeometry';
import './workspace.css';

/**
 * A visually hidden native range named "Playback position" with speech, take ticks
 * and the played part drawn over it. The drawn track takes pointer input; the range
 * keeps keyboard and assistive technology input.
 */
export function Scrubber({ timeMs, durationMs, segments, takes, onSeek, disabled = false }: ScrubberProps) {
  const input = useRef<HTMLInputElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const inactive = disabled || !(durationMs > 0);
  const duration = Math.max(0, durationMs || 0);
  const time = Math.min(Math.max(0, timeMs || 0), duration);

  const seekAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (rect) onSeek(pointerToMs(clientX, rect, duration));
  };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (inactive || event.button !== 0) return;
    event.preventDefault();
    input.current?.focus({ preventScroll: true });
    dragging.current = event.pointerId;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* capture is optional */ }
    seekAt(event.clientX);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => { if (dragging.current === event.pointerId) seekAt(event.clientX); };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current !== event.pointerId) return;
    dragging.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = keyboardSeek(event.key, time, duration, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    if (next !== time) onSeek(next);
  };

  return <div className="cr-scrubber" data-disabled={inactive || undefined} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    <input ref={input} className="cr-scrubber-input" type="range" aria-label={NAMES.playbackPosition} aria-valuetext={positionText(time, duration, takes)}
      min={0} max={duration || 1} step={10} value={time} disabled={inactive} onKeyDown={key} onChange={event => onSeek(Number(event.target.value))}/>
    <div ref={track} className="cr-scrubber-track" aria-hidden="true">
      {speechRuns(segments, duration, time).map(run => <span key={`${run.left}-${run.played}`} className="cr-scrubber-speech" data-played={run.played || undefined} style={{ left: `${run.left}%`, width: `${run.width}%` }}/>)}
    </div>
    {takeTicks(takes, duration).map(tick => <span key={tick.index} className="cr-scrubber-tick" aria-hidden="true" style={{ left: `${tick.left}%` }}/>)}
    <span className="cr-scrubber-knob" aria-hidden="true" style={{ left: `${toPercent(time, duration)}%` }}/>
  </div>;
}
