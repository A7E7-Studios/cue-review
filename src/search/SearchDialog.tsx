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

type Group = 'recent' | 'recordings' | 'lines';
type Result = { key: string; id: string; atMs?: number; group: Group; title: ReactNode; detail: ReactNode; time?: string };

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

const GROUPS: Group[] = ['recent', 'recordings', 'lines'];
const HEADINGS: Record<Group, string> = { recent: NAMES.searchRecent, recordings: NAMES.searchRecordingsGroup, lines: NAMES.searchLinesGroup };

/**
 * Search over every recording (search spec): before anything is typed, the most recent recordings;
 * then the recordings whose names match and the transcript lines that match every word. Focus stays
 * in the field (a combobox); ↑ and ↓ move the active result (`aria-activedescendant`), Enter opens it.
 * Results sit in labelled groups. The active result is kept by its key, and the first result is
 * pinned once results show, so lines arriving from a transcript loaded meanwhile never change what
 * Enter opens.
 */
export function SearchDialog({ open, onClose, sessions, sections, transcripts, onOpen, fallbackFocusRef }: SearchDialogProps) {
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Each opening starts empty, in the same render, so a reopened window never shows the last query.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setQuery(''); setActiveKey(null); }
  }
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const sectionName = useMemo(() => new Map(sections.map(section => [section.id, section.name])), [sections]);
  const results = useMemo((): Result[] => {
    const words = queryWords(query);
    const place = (session: Session) => [session.projectId ? sectionName.get(session.projectId) : NAMES.recents, shortDate(session.createdAt), formatTime(session.durationMs)].filter(Boolean).join(' · ');
    if (!words.length) return recentRecordings(sessions).map(session => ({ key: `r:${session.id}`, id: session.id, group: 'recent', title: session.name, detail: place(session) }));
    return [
      ...matchingRecordings(sessions, words).map((session): Result => ({ key: `r:${session.id}`, id: session.id, group: 'recordings', title: marked(session.name, words), detail: place(session) })),
      ...matchingLines(sessions, transcripts, words).map((line): Result => ({ key: `l:${line.session.id}:${line.startMs}`, id: line.session.id, atMs: line.startMs, group: 'lines', title: line.session.name, detail: marked(line.text, words), time: formatTime(line.startMs) })),
    ];
  }, [query, sessions, sectionName, transcripts]);
  useEffect(() => { if (activeKey === null && results.length) setActiveKey(results[0].key); }, [activeKey, results]);
  const found = results.findIndex(result => result.key === activeKey);
  const current = found >= 0 ? found : 0;
  const optionId = (index: number) => `${id}-option-${index}`;
  useEffect(() => { list.current?.querySelector(`#${CSS.escape(optionId(current))}`)?.scrollIntoView?.({ block: 'nearest' }); });

  const choose = (result: Result | undefined) => { if (!result) return; onClose(); onOpen(result.id, result.atMs); };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length) setActiveKey(results[(current + (event.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length].key);
    } else if (event.key === 'Enter') { event.preventDefault(); choose(results[current]); }
  };
  const words = queryWords(query);

  return <Dialog open={open} onClose={onClose} title={NAMES.search} className="search-dialog" initialFocusRef={field} fallbackFocusRef={fallbackFocusRef}>
    <div className="search-field">
      <Icon name="search" size={16} strokeWidth={1.8}/>
      <input ref={field} type="search" role="combobox" aria-label={NAMES.searchRecordings} placeholder={NAMES.searchPlaceholder}
        aria-expanded={results.length > 0} aria-controls={`${id}-results`} aria-autocomplete="list"
        aria-activedescendant={results.length ? optionId(current) : undefined} autoComplete="off" spellCheck={false}
        value={query} onChange={event => { setQuery(event.target.value); setActiveKey(null); }} onKeyDown={keys}/>
    </div>
    <div ref={list} id={`${id}-results`} className="search-results" role="listbox" aria-label={NAMES.searchResults}>
      {GROUPS.map(group => {
        const members = results.map((result, index) => ({ result, index })).filter(item => item.result.group === group);
        if (!members.length) return null;
        const headingId = `${id}-${group}`;
        return <div key={group} className="search-group" role="group" aria-labelledby={headingId}>
          <div id={headingId} className="search-group-heading" role="presentation">{HEADINGS[group]}</div>
          {members.map(({ result, index }) => <div key={result.key} id={optionId(index)} role="option" aria-selected={index === current} className="search-result"
            onMouseMove={() => { if (index !== current) setActiveKey(result.key); }} onMouseDown={event => event.preventDefault()} onClick={() => choose(result)}>
            <Icon name={result.group === 'lines' ? 'text' : 'monitor'} size={16} strokeWidth={1.7}/>
            <span className="search-result-main">
              <span className="search-result-title">{result.title}</span>
              <span className="search-result-detail">{result.group === 'lines' ? <>“{result.detail}”</> : result.detail}</span>
            </span>
            {result.time && <span className="search-result-time">{result.time}</span>}
          </div>)}
        </div>;
      })}
    </div>
    {/* Always there, so screen readers hear the change as results narrow to nothing. */}
    <p className="search-status" role="status">{words.length && !results.length ? NAMES.noMatches : ''}</p>
  </Dialog>;
}
