import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import type { Project, Session, Transcript } from '../backend';
import { Icon } from '../icons';
import { formatTime } from '../review';
import { Dialog } from '../ui/Dialog';
import { NAMES } from '../workspace/types';
import { matchingLines, matchingRecordings, matchRanges, queryWords, recentRecordings } from './searchIndex';
import './search.css';

export interface SearchDialogProps {
  open: boolean;
  onClose: () => void;
  sessions: Session[];
  sections: Project[];
  /** Transcripts loaded so far, by session id; lines appear as they arrive. */
  transcripts: ReadonlyMap<string, Transcript>;
  /** Opens a recording; with `atMs`, playback stands at that time. */
  onOpen: (id: string, atMs?: number) => void;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}

type Result = { key: string; id: string; atMs?: number; group: 'recent' | 'recordings' | 'lines'; title: ReactNode; detail: ReactNode; time?: string };

/** The text with the ranges the words match wrapped in <mark>. */
function marked(text: string, words: string[]): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of matchRanges(text, words)) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  parts.push(text.slice(at));
  return parts;
}

function shortDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Search over every recording (search spec): before anything is typed, the most recent recordings;
 * then the recordings whose names match and the transcript lines that match every word. Focus stays
 * in the field; ↑ and ↓ move the active result (`aria-activedescendant`), Enter opens it.
 */
export function SearchDialog({ open, onClose, sessions, sections, transcripts, onOpen, fallbackFocusRef }: SearchDialogProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  useEffect(() => { if (open) { setQuery(''); setActive(0); } }, [open]);

  const words = queryWords(query);
  const sectionName = useMemo(() => new Map(sections.map(section => [section.id, section.name])), [sections]);
  const place = (session: Session) => [session.projectId ? sectionName.get(session.projectId) : NAMES.recents, shortDate(session.createdAt), formatTime(session.durationMs)].filter(Boolean).join(' · ');
  const results: Result[] = words.length ? [
    ...matchingRecordings(sessions, words).map((session): Result => ({ key: `r:${session.id}`, id: session.id, group: 'recordings', title: marked(session.name, words), detail: place(session) })),
    ...matchingLines(sessions, transcripts, words).map((line): Result => ({ key: `l:${line.session.id}:${line.startMs}`, id: line.session.id, atMs: line.startMs, group: 'lines', title: line.session.name, detail: marked(line.text, words), time: formatTime(line.startMs) })),
  ] : recentRecordings(sessions).map((session): Result => ({ key: `r:${session.id}`, id: session.id, group: 'recent', title: session.name, detail: place(session) }));
  const current = Math.min(active, Math.max(0, results.length - 1));
  useEffect(() => { list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView?.({ block: 'nearest' }); }, [current]);

  const choose = (result: Result | undefined) => { if (!result) return; onClose(); onOpen(result.id, result.atMs); };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length) setActive((current + (event.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length);
    } else if (event.key === 'Enter') { event.preventDefault(); choose(results[current]); }
  };
  const heading = { recent: NAMES.searchRecent, recordings: NAMES.searchRecordingsGroup, lines: NAMES.searchLinesGroup };

  return <Dialog open={open} onClose={onClose} title={NAMES.search} className="search-dialog" initialFocusRef={field} fallbackFocusRef={fallbackFocusRef}>
    <div className="search-field">
      <Icon name="search" size={16} strokeWidth={1.8}/>
      <input ref={field} type="search" role="combobox" aria-label={NAMES.searchRecordings} placeholder={NAMES.searchPlaceholder}
        aria-expanded={results.length > 0} aria-controls={`${id}-results`} aria-autocomplete="list"
        aria-activedescendant={results.length ? `${id}-${current}` : undefined} autoComplete="off" spellCheck={false}
        value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={keys}/>
    </div>
    <ul ref={list} id={`${id}-results`} className="search-results" role="listbox" aria-label={NAMES.searchResults}>
      {results.map((result, index) => <li key={result.key} id={`${id}-${index}`} data-index={index} role="option" aria-selected={index === current}
        className={`search-result${index === 0 || results[index - 1].group !== result.group ? ' search-group-start' : ''}`}
        data-group={index === 0 || results[index - 1].group !== result.group ? heading[result.group] : undefined}
        onMouseMove={() => { if (index !== current) setActive(index); }} onMouseDown={event => event.preventDefault()} onClick={() => choose(result)}>
        <Icon name={result.group === 'lines' ? 'text' : 'monitor'} size={16} strokeWidth={1.7}/>
        <span className="search-result-main">
          <span className="search-result-title">{result.title}</span>
          <span className="search-result-detail">{result.group === 'lines' ? <>“{result.detail}”</> : result.detail}</span>
        </span>
        {result.time && <span className="search-result-time">{result.time}</span>}
      </li>)}
    </ul>
    {/* Always there, so screen readers hear the change as results narrow to nothing. */}
    <p className="search-status" role="status">{words.length && !results.length ? NAMES.noMatches : ''}</p>
  </Dialog>;
}
