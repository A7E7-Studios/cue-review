import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react';
import type { Segment } from '../backend';
import { Icon } from '../icons';
import { activeSegment, activeWord, findMatches, formatTime, playheadSegment, segmentSeekMs, transcriptItems, wordSeekMs } from '../review';
import { prefersReducedMotion } from '../ui/usePresence';
import { NAMES } from './types';
import type { TranscriptPaneProps } from './types';
import './workspace.css';
import './transcript.css';

export const LIVE_NOTE = 'Live words may change until you stop.';
/** A jump this large between two time updates is a seek, which resumes following. */
const SEEK_JUMP_MS = 2000;
/** How long scroll events after an automatic scroll are treated as ours. */
const AUTO_SCROLL_MS = { smooth: 800, auto: 150 };

/** Item keys for the roving tab stop: `${row}:t` timestamp, `${row}:s` segment text, `${row}:${word}`. */
type ItemKey = string;

function keyExists(segments: Segment[], key: ItemKey | null): key is ItemKey {
  if (!key) return false;
  const [row, item] = key.split(':');
  const segment = segments[Number(row)];
  if (!segment) return false;
  if (item === 't') return true;
  if (item === 's') return !segment.words.length;
  return Number(item) < segment.words.length;
}

function highlight(text: string, needle: string): ReactNode {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at} className="cr-find-mark">{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

interface RowProps {
  segment: Segment;
  index: number;
  live: boolean;
  tail: boolean;
  inert: boolean;
  current: boolean;
  past: boolean;
  /** The spoken word in the current row, or -1. */
  spoken: number;
  /** The row's item that holds the transcript's tab stop: 't', 's', a word index, or null. */
  entry: string | null;
  needle: string;
  match: boolean;
  matchCurrent: boolean;
  seek: (ms: number) => void;
}

const Row = memo(function Row({ segment, index, live, tail, inert, current, past, spoken, entry, needle, match, matchCurrent, seek }: RowProps) {
  const at = segmentSeekMs(segment);
  const tab = (item: string) => entry === item ? 0 : -1;
  // Words are role=button spans: Enter and Space activate them as they would a <button>.
  const activate = (event: KeyboardEvent<HTMLSpanElement>, ms: number) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (!event.repeat) seek(ms);
  };
  const className = ['cr-row', current && 'is-current', past && 'is-past', live && 'is-live', tail && 'is-tail', match && 'is-match', matchCurrent && 'is-match-current'].filter(Boolean).join(' ');
  return <div className={className} data-row={index}>
    <button type="button" className="cr-row-time" data-item={`${index}:t`} tabIndex={tab('t')} disabled={inert} aria-label={NAMES.seekTo(formatTime(at))} onClick={() => seek(at)}>{formatTime(at)}</button>
    <div className="cr-row-body">
      <p className="cr-row-text">
        {segment.words.length
          ? segment.words.map((word, wordIndex) => {
            const ms = wordSeekMs(word);
            const spokenNow = spoken === wordIndex;
            const classes = ['word', spokenNow && 'spoken', current && spoken >= 0 && wordIndex > spoken && 'upcoming', needle && word.text.toLowerCase().includes(needle) && 'found'].filter(Boolean).join(' ');
            // A <button> lays out as one unbreakable box; an inline role=button wraps with the sentence.
            return <Fragment key={wordIndex}>
              {wordIndex > 0 && ' '}
              <span role="button" className={classes} data-item={`${index}:${wordIndex}`} tabIndex={inert ? -1 : tab(String(wordIndex))} aria-disabled={inert || undefined}
                aria-label={NAMES.seekToWord(word.text, formatTime(ms))} aria-current={spokenNow ? 'true' : undefined}
                onClick={inert ? undefined : () => seek(ms)} onKeyDown={inert ? undefined : event => activate(event, ms)}>{word.text}</span>
            </Fragment>;
          })
          : <button type="button" className="segment-text" data-item={`${index}:s`} tabIndex={tab('s')} disabled={inert} onClick={() => seek(at)}>
            {highlight(segment.text, needle)}
            {/* Inside the button: the sentence wraps as one box, so a caret after it would drop to its own line. */}
            {tail && <span className="cr-live-caret" aria-hidden="true"/>}
          </button>}
        {tail && segment.words.length > 0 && <span className="cr-live-caret" aria-hidden="true"/>}
      </p>
      {tail && <span className="cr-live-note">{LIVE_NOTE}</span>}
    </div>
  </div>;
});

function Divider({ take, startMs, live }: { take: number; startMs: number; live: boolean }) {
  return <p className="cr-take-divider" data-live={live || undefined}><span aria-hidden="true"/>{live ? `Take ${take} · recording` : `Take ${take} · ${formatTime(startMs)}`}<span aria-hidden="true"/></p>;
}

function visibleIn(element: Element, box: Element) {
  const item = element.getBoundingClientRect();
  const view = box.getBoundingClientRect();
  return item.bottom > view.top + 1 && item.top < view.bottom - 1;
}

/** The transcript column (decisions 4, 10 and 12). */
export function TranscriptPane({ mode, transcript, timeMs, onSeek, status, liveTake, liveError, emptyMessage, error, onRetry, retryDisabled = false, retryBusy = false, discardTake, onDiscardTake, findRequest = 0 }: TranscriptPaneProps) {
  const recording = mode === 'recording';
  const segments = transcript.segments;
  const liveIndex = recording ? liveTake?.index ?? 1 : undefined;
  const liveStart = recording ? liveTake?.startMs ?? 0 : undefined;
  const items = useMemo(() => transcriptItems(segments, transcript.takes, liveIndex === undefined ? undefined : { index: liveIndex, startMs: liveStart ?? 0 }), [segments, transcript.takes, liveIndex, liveStart]);
  const current = activeSegment(segments, timeMs);
  const spoken = current >= 0 ? activeWord(segments[current].words, timeMs) : -1;
  const hasLiveRows = items.some(item => item.kind === 'segment' && item.live);

  const scroller = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const findButton = useRef<HTMLButtonElement>(null);
  const findId = useId();
  const latestSeek = useRef(onSeek);
  useLayoutEffect(() => { latestSeek.current = onSeek; });

  // Following: keep the playhead's row (or the live end) in view until the reader scrolls away.
  // Before the playhead reaches the first sentence there is nothing to follow or return to.
  const [following, setFollowing] = useState(true);
  const autoUntil = useRef(0);
  const playheadRow = recording ? -1 : playheadSegment(segments, timeMs);
  const hasTarget = recording ? items.length > 0 : playheadRow >= 0;
  const followKey = recording ? `end:${segments.length}:${segments.at(-1)?.text.length ?? 0}` : playheadRow >= 0 ? String(playheadRow) : '';
  const followTarget = useCallback((): Element | null => {
    const box = scroller.current;
    if (!box) return null;
    return recording ? box.querySelector('[data-follow-end]') : playheadRow >= 0 ? box.querySelector(`[data-row="${playheadRow}"]`) : null;
  }, [recording, playheadRow]);
  const scrollTo = useCallback((element: Element | null, block: ScrollLogicalPosition) => {
    if (!element) return;
    // Smooth only for short moves; a jump across the transcript is instant.
    const box = scroller.current?.getBoundingClientRect();
    const item = element.getBoundingClientRect();
    const far = !!box && Math.max(box.top - item.bottom, item.top - box.bottom) > box.height * 2;
    const smooth = !prefersReducedMotion() && !far;
    autoUntil.current = performance.now() + (smooth ? AUTO_SCROLL_MS.smooth : AUTO_SCROLL_MS.auto);
    element.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block });
  }, []);
  useEffect(() => { if (following && followKey) scrollTo(followTarget(), 'nearest'); }, [following, followKey, followTarget, scrollTo]);
  const identity = `${mode}:${segments[0]?.id ?? segments[0]?.startMs ?? ''}`;
  useEffect(() => { setFollowing(true); }, [identity]);
  const lastTime = useRef(timeMs);
  useEffect(() => {
    if (Math.abs(timeMs - lastTime.current) > SEEK_JUMP_MS) setFollowing(true);
    lastTime.current = timeMs;
  }, [timeMs]);
  const seek = useCallback((ms: number) => { setFollowing(true); latestSeek.current(ms); }, []);
  const scrolled = () => {
    const box = scroller.current;
    const now = performance.now();
    // Our own scroll is still moving: keep treating its events as ours.
    if (now < autoUntil.current) { autoUntil.current = Math.max(autoUntil.current, now + AUTO_SCROLL_MS.auto); return; }
    const target = followTarget();
    if (!box || !target) return;
    // Scrolling the followed place back into view resumes following, as scrolling away stops it.
    setFollowing(visibleIn(target, box));
  };
  // A wheel or touch during an automatic scroll is the reader's.
  const reading = () => { autoUntil.current = 0; };

  // Roving tab stop: one entry into the transcript, then the arrow keys.
  const [focusKey, setFocusKey] = useState<ItemKey | null>(null);
  const [focusInside, setFocusInside] = useState(false);
  const playingKey = current >= 0 ? `${current}:${spoken >= 0 ? spoken : 't'}` : null;
  const entry = focusInside && keyExists(segments, focusKey) ? focusKey
    : playingKey ?? (keyExists(segments, focusKey) ? focusKey : segments.length ? '0:t' : null);
  const [entryRow, entryItem] = entry ? entry.split(':') : [null, null];
  const focused = (event: FocusEvent<HTMLDivElement>) => {
    const key = event.target instanceof HTMLElement ? event.target.dataset.item : undefined;
    if (key) { setFocusKey(key); setFocusInside(true); }
  };
  const blurred = (event: FocusEvent<HTMLDivElement>) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocusInside(false);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const key = target?.dataset.item;
    if (!target || !key || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const all = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-item]:not(:disabled):not([aria-disabled="true"])') ?? [])];
    const at = all.indexOf(target);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowRight') next = all[at + 1];
    else if (event.key === 'ArrowLeft') next = all[at - 1];
    else if (event.key === 'Home') next = all[0];
    else if (event.key === 'End') next = all.at(-1);
    else {
      // Up and Down move between sentences, landing on their timestamps.
      const starts = all.filter(element => element.dataset.item?.endsWith(':t'));
      const row = starts.findIndex(element => element.dataset.item === `${key.split(':')[0]}:t`);
      next = starts[row + (event.key === 'ArrowDown' ? 1 : -1)];
    }
    next?.focus();
  };
  const focusEntry = () => requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>('[data-item][tabindex="0"]:not(:disabled)')?.focus({ preventScroll: true }));
  const returnToPlayback = () => { setFollowing(true); focusEntry(); };

  // Find in transcript, for review only: while recording the column shows the live tail and no Find.
  const [findOpen, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const finding = findOpen && !recording;
  const needle = recording ? '' : query.trim().toLowerCase();
  useEffect(() => { if (recording) { setFinding(false); setQuery(''); setCursor(0); } }, [recording]);
  const matches = useMemo(() => recording ? [] : findMatches(segments, query), [recording, segments, query]);
  const matchIndex = matches.length ? Math.min(cursor, matches.length - 1) : -1;
  const matchRow = matchIndex >= 0 ? matches[matchIndex] : -1;
  const matchSet = useMemo(() => new Set(matches), [matches]);
  useEffect(() => { if (finding) findInput.current?.focus(); }, [finding]);
  // Ctrl/⌘+F opens Find, or takes focus back to its field when it is open.
  const lastFindRequest = useRef(findRequest);
  useEffect(() => {
    if (findRequest === lastFindRequest.current) return;
    lastFindRequest.current = findRequest;
    if (recording) return;
    if (findOpen) { findInput.current?.focus(); findInput.current?.select(); } else setFinding(true);
  }, [findRequest, findOpen, recording]);
  // The bar slides open and closed (search spec); it stays mounted while it closes.
  const findPresence = usePresence(finding, 180);
  const lastQuery = useRef(query);
  if (finding) lastQuery.current = query;
  useEffect(() => {
    if (matchRow < 0) return;
    setFollowing(false);
    scrollTo(scroller.current?.querySelector(`[data-row="${matchRow}"]`) ?? null, 'center');
  }, [matchRow, needle, scrollTo]);
  const closeFind = () => { setFinding(false); setQuery(''); setCursor(0); findButton.current?.focus(); };
  const step = (by: number) => { if (matches.length) setCursor((matchIndex + by + matches.length) % matches.length); };
  const findKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind(); }
  };

  const tailPlaceholder = recording && liveIndex !== undefined && liveIndex > 1 && !hasLiveRows;
  return <section className="cr-transcript" aria-label={NAMES.transcript} data-mode={mode}>
    <div className="cr-transcript-header">
      <h2>{NAMES.transcript}</h2>
      {status && <span className="cr-status-chip" data-status={status} role="status"><i aria-hidden="true"/>{status === 'recording' ? 'Recording' : 'Processing'}</span>}
      <span className="cr-spacer"/>
      {!recording && <button ref={findButton} type="button" className="cr-btn cr-round-button cr-ghost" aria-label={NAMES.findInTranscript} title={NAMES.findInTranscript}
        aria-expanded={finding} aria-controls={finding ? findId : undefined} onClick={() => finding ? closeFind() : setFinding(true)}>
        <Icon name="search" strokeWidth={1.8}/>
      </button>}
    </div>
    {findPresence.present && <div className="cr-find-reveal" data-state={finding ? findPresence.phase : 'exiting'} inert={!finding || undefined}><div className="cr-find-clip"><div className="cr-find" id={findId}>
      <Icon name="search" strokeWidth={1.9}/>
      <input ref={findInput} type="search" aria-label={NAMES.findInTranscript} placeholder="Find in transcript" value={finding ? query : lastQuery.current} onKeyDown={findKeyDown}
        onChange={event => { setQuery(event.target.value); setCursor(0); }}/>
      <span className="cr-find-count" role="status">{needle ? matches.length ? `${matchIndex + 1} of ${matches.length}` : NAMES.noMatches : ''}</span>
      <button type="button" className="cr-btn cr-find-step" aria-label="Previous match" disabled={!matches.length} onClick={() => step(-1)}><Icon name="chevron" strokeWidth={2} style={{ transform: 'rotate(-90deg)' }}/></button>
      <button type="button" className="cr-btn cr-find-step" aria-label="Next match" disabled={!matches.length} onClick={() => step(1)}><Icon name="chevron" strokeWidth={2} style={{ transform: 'rotate(90deg)' }}/></button>
    </div></div></div>}
    <div ref={scroller} className="cr-transcript-scroll" onScroll={scrolled} onWheel={reading} onTouchMove={reading} onKeyDown={keyDown} onFocus={focused} onBlur={blurred}>
      {items.length ? items.map(item => item.kind === 'divider'
        ? <Divider key={`take-${item.take}`} take={item.take} startMs={item.startMs} live={item.live}/>
        : <Row key={segments[item.index].id ?? item.index} segment={segments[item.index]} index={item.index} live={item.live} tail={item.tail} inert={recording}
            current={current === item.index} past={current !== item.index && segments[item.index].endMs <= timeMs} spoken={current === item.index ? spoken : -1}
            entry={entryRow === String(item.index) ? entryItem : null} needle={needle} match={matchSet.has(item.index)} matchCurrent={matchRow === item.index} seek={seek}/>)
        : !error && emptyMessage && <p className="cr-transcript-empty">{emptyMessage}</p>}
      {tailPlaceholder && <div className="cr-row is-live is-tail">
        <span className="cr-row-time">{formatTime(liveStart ?? 0)}</span>
        <div className="cr-row-body"><p className="cr-row-text">{emptyMessage}<span className="cr-live-caret" aria-hidden="true"/></p><span className="cr-live-note">{LIVE_NOTE}</span></div>
      </div>}
      {liveError && <p className="cr-transcript-note" role="status"><Icon name="warning" strokeWidth={1.8}/>{liveError}</p>}
      {error && <div className="cr-transcript-error">
        <p><Icon name="warning" strokeWidth={1.8}/>{error}</p>
        {(onRetry || (discardTake && onDiscardTake)) && <div className="cr-transcript-error-actions">
          {onRetry && <button type="button" className="cr-btn cr-pill" disabled={retryDisabled} aria-disabled={retryBusy || undefined} onClick={retryBusy ? undefined : onRetry}><Icon name="refresh" strokeWidth={1.8}/>{NAMES.retryTranscription}</button>}
          {discardTake && onDiscardTake && <button type="button" className="cr-btn cr-pill" aria-haspopup="dialog" aria-disabled={retryBusy || undefined} onClick={retryBusy ? undefined : onDiscardTake}><Icon name="close" strokeWidth={1.8}/>{NAMES.discardTake(discardTake)}</button>}
        </div>}
      </div>}
      <div className="cr-transcript-end" data-follow-end aria-hidden="true"/>
    </div>
    {!following && hasTarget && <button type="button" className="cr-btn cr-return" onClick={returnToPlayback}><Icon name="play" filled/>{recording ? NAMES.backToLive : NAMES.returnToPlayback}</button>}
  </section>;
}
