import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent, MouseEvent } from 'react';
import { isTextField } from './app/useContextMenuGuard';
import type { Project, Session } from './backend';
import { platform as detectPlatform, shortcut } from './chrome/windowApi';
import { Icon } from './icons';
import { formatTime } from './review';
import { usePresence } from './ui/usePresence';
import { NAMES } from './workspace/types';
import type { SidebarProps } from './workspace/types';

type Menu = { kind: 'session' | 'section' | 'panel'; id: string; x: number; y: number; moving: boolean };
const inProgress = (item: Session) => item.status === 'recording' || item.status === 'processing';

function shortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, thisYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
/** "0:42 · Oct 28": shown beside the name on hover or focus (decision 2). */
function sessionMeta(item: Session) {
  return [formatTime(item.durationMs), shortDate(item.createdAt)].filter(Boolean).join(' · ');
}

export function Sidebar(props: SidebarProps) {
  const { sections, sessions, locked } = props;
  const os = props.platform ?? detectPlatform();
  const showCollapse = props.showCollapse ?? true;
  const newKey = shortcut('n', os);
  const [closed, setClosed] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('cuereview.closedSections') || '[]');
      return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
    } catch { return new Set(); }
  });
  // While filtering, every section with a match starts open. Toggles then apply to this query only
  // and leave the saved disclosure state alone.
  const query = (props.filter ?? '').trim().toLocaleLowerCase();
  const filtering = query.length > 0;
  const [filterClosed, setFilterClosed] = useState<{ query: string; ids: Set<string> }>({ query: '', ids: new Set() });
  const isClosed = (id: string) => filtering ? filterClosed.query === query && filterClosed.ids.has(id) : closed.has(id);
  const toggleSection = (id: string) => {
    const flip = (ids: Set<string>) => { const next = new Set(ids); if (next.has(id)) next.delete(id); else next.add(id); return next; };
    if (filtering) setFilterClosed(current => ({ query, ids: flip(current.query === query ? current.ids : new Set()) }));
    else setClosed(flip);
  };
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuPresence = usePresence(!!menu, 120);
  const lastMenu = useRef<Menu | null>(null);
  if (menu) lastMenu.current = menu;
  const shownMenu = menu || lastMenu.current;
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const sectionDragId = useRef<string | null>(null);
  const [draggingSection, setDraggingSection] = useState<string | null>(null);
  const [insertion, setInsertion] = useState<{ id: string; after: boolean } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const typeahead = useRef({ text: '', at: 0 });
  const movable = (item: Session) => !locked && !inProgress(item);
  const expand = (id: string) => setClosed(current => { const next = new Set(current); next.delete(id); return next; });
  const closeMenu = () => { setMenu(null); returnFocus.current?.focus(); };
  const menuSession = shownMenu?.kind === 'session' ? sessions.find(item => item.id === shownMenu.id) : undefined;
  const menuSection = shownMenu?.kind === 'section' ? sections.find(item => item.id === shownMenu.id) : undefined;
  const sectionDeletable = (id: string) => !locked && !sessions.some(item => item.projectId === id && inProgress(item));
  const finishDrag = () => { dragId.current = null; sectionDragId.current = null; setDragging(null); setDraggingSection(null); setDropTarget(null); setInsertion(null); };

  useEffect(() => { localStorage.setItem('cuereview.closedSections', JSON.stringify([...closed])); }, [closed]);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const position = () => {
      const panel = menuRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
      panel.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    typeahead.current = { text: '', at: 0 };
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      const onAnchor = menu.kind !== 'panel' && !!returnFocus.current?.contains(event.target as Node);
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !onAnchor) setMenu(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menu]);
  useEffect(() => { if (locked) { setMenu(null); finishDrag(); } }, [locked]);

  const openMenu = (item: Session, anchor: HTMLElement, x?: number, y?: number) => {
    if (!movable(item)) return;
    const rect = anchor.getBoundingClientRect();
    returnFocus.current = anchor;
    setMenu({ kind: 'session', id: item.id, x: x ?? rect.right, y: y ?? rect.top, moving: false });
  };
  const openSectionMenu = (section: Project, anchor: HTMLElement, x?: number, y?: number) => {
    if (locked) return;
    const rect = anchor.getBoundingClientRect(); returnFocus.current = anchor;
    setMenu({ kind: 'section', id: section.id, x: x ?? rect.right, y: y ?? rect.top, moving: false });
  };
  // The panel's own menu, for a right-click anywhere in the sidebar without a menu of its own.
  // Rows and section headings open theirs first and mark the event handled.
  const openPanelMenu = (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || isTextField(event.target)) return;
    event.preventDefault();
    const focused = document.activeElement;
    returnFocus.current = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    setMenu({ kind: 'panel', id: '', x: event.clientX, y: event.clientY, moving: false });
  };
  const reorder = async (id: string, targetId: string | null, after: boolean) => {
    if (locked || id === targetId || !sections.some(item => item.id === id)) return;
    const ids = sections.filter(item => item.id !== id).map(item => item.id);
    const targetIndex = targetId === null ? ids.length : ids.indexOf(targetId) + (after ? 1 : 0);
    ids.splice(targetIndex, 0, id);
    if (ids.every((value, index) => value === sections[index]?.id)) return;
    closeMenu();
    if (await props.onReorder(ids)) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(id)}"] .section-toggle`)?.focus());
  };
  const move = async (id: string, sectionId: string | null) => {
    closeMenu();
    if (await props.onMove(id, sectionId)) {
      if (sectionId) expand(sectionId);
      // A moved row may have been unmounted. Keep keyboard focus on its new row.
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"] .session`)?.focus());
    }
  };
  const dropHandlers = (sectionId: string | null) => {
    const target = sectionId ?? 'recents';
    return {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (sectionDragId.current && !locked) {
          event.preventDefault(); event.dataTransfer.dropEffect = 'move';
          const rect = (event.currentTarget.querySelector('.section-heading') || event.currentTarget).getBoundingClientRect();
          setInsertion({ id: target, after: sectionId !== null && event.clientY > rect.top + rect.height / 2 });
          return;
        }
        const item = sessions.find(item => item.id === dragId.current);
        if (!item || !movable(item)) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(target);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          setDropTarget(current => current === target ? null : current); setInsertion(current => current?.id === target ? null : current);
        }
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (sectionDragId.current && !locked) {
          event.preventDefault(); const id = sectionDragId.current;
          const rect = (event.currentTarget.querySelector('.section-heading') || event.currentTarget).getBoundingClientRect();
          const after = sectionId !== null && event.clientY > rect.top + rect.height / 2;
          finishDrag(); void reorder(id, sectionId, after); return;
        }
        const item = sessions.find(item => item.id === dragId.current);
        if (!item || !movable(item)) return;
        event.preventDefault(); finishDrag();
        void move(item.id, sectionId);
      },
    };
  };
  const renderSession = (item: Session) => {
    const active = props.activeId === item.id;
    const meta = inProgress(item) ? '' : sessionMeta(item);
    return <div className={`session-row ${active ? 'active' : ''} ${dragging === item.id ? 'dragging' : ''}`} data-session-id={item.id} key={item.id}>
      <button className={`session ${active ? 'active' : ''}`} aria-current={active ? 'true' : undefined} disabled={locked} draggable={movable(item)}
        title={meta ? `${item.name} · ${meta}` : item.name}
        onClick={() => props.onOpen(item.id)}
        onDoubleClick={() => { if (movable(item)) props.onRename(item); }}
        onContextMenu={event => { event.preventDefault(); openMenu(item, event.currentTarget, event.clientX, event.clientY); }}
        onDragStart={event => {
          if (!movable(item)) { event.preventDefault(); return; }
          setMenu(null); sectionDragId.current = null; dragId.current = item.id; setDragging(item.id);
          event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id);
        }}
        onDragEnd={finishDrag}>
        {/* A dot marks a recording in progress (red while recording, muted while processing); its status is
            spoken from visually hidden text, so the name keeps the row's full width. */}
        {inProgress(item) && <span className="session-status-dot" data-status={item.status} aria-hidden="true"/>}
        <span className="session-name">{item.name}</span>
        {inProgress(item) && <span className="session-status-text">{item.status === 'recording' ? ', recording' : ', processing'}</span>}
        {/* Drawn from data-meta by CSS, so the row's name and text stay the session name alone. */}
        {meta && <span className="session-meta" aria-hidden="true" data-meta={meta}/>}
      </button>
      <button className="session-options" aria-label={NAMES.recordingOptions} title={`Options for ${item.name}`} aria-haspopup="menu" aria-expanded={menu?.kind === 'session' && menu.id === item.id} disabled={!movable(item)} onClick={event => menu?.kind === 'session' && menu.id === item.id ? closeMenu() : openMenu(item, event.currentTarget)}><Icon name="more"/></button>
    </div>;
  };
  const matches = filtering ? sessions.filter(item => item.name.toLocaleLowerCase().includes(query)) : sessions;
  const shownSections = filtering ? sections.filter(section => matches.some(item => item.projectId === section.id)) : sections;
  // Older recordings retain their section IDs. If a section is unavailable, keep its recordings reachable.
  const recentSessions = matches.filter(item => !item.projectId || !sections.some(section => section.id === item.projectId));
  const noMatches = filtering && !matches.length;

  return <aside className="sidebar" data-platform={os} aria-label={NAMES.recordings} onContextMenu={openPanelMenu}>
    {(os === 'macos' || showCollapse) && <div className="side-header" {...(os === 'macos' ? { 'data-tauri-drag-region': '' } : {})}>
      {/* macOS draws its traffic lights here (tauri.macos.conf.json trafficLightPosition). */}
      {os === 'macos' && <span className="side-traffic-lights" aria-hidden="true" data-tauri-drag-region=""/>}
      {showCollapse && <button className="side-collapse" aria-label={NAMES.hideSidebar} onClick={props.onCollapse}><Icon name="panel" size={16} strokeWidth={1.7}/></button>}
    </div>}
    <div className="side-tools">
      <button className="new-recording has-kbd" disabled={locked} onClick={props.onNew} aria-keyshortcuts={newKey.aria}>
        <span className="new-recording-dot" aria-hidden="true"/>
        <span className="new-recording-label">{NAMES.newRecording}</span>
        <kbd className="kbd-hint" aria-hidden="true">{newKey.label}</kbd>
      </button>
      <button className="new-section" disabled={locked} aria-label={NAMES.newSection} title={NAMES.newSection} onClick={() => props.onCreateSection()}><Icon name="folderPlus" size={17} strokeWidth={1.7}/></button>
    </div>
    <div className="recording-list">
      {shownSections.map(section => {
        const sectionClosed = isClosed(section.id);
        return <section key={section.id} data-section-id={section.id} aria-label={NAMES.section(section.name)} className={`recording-section ${dropTarget === section.id ? 'drop-target' : ''} ${draggingSection === section.id ? 'dragging-section' : ''} ${insertion?.id === section.id ? insertion.after ? 'insert-after' : 'insert-before' : ''}`} {...dropHandlers(section.id)}>
          <div className="section-heading">
            <button className="section-toggle" draggable={!locked} disabled={locked}
              onDragStart={event => { if (locked) { event.preventDefault(); return; } setMenu(null); dragId.current = null; sectionDragId.current = section.id; setDraggingSection(section.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', section.id); }}
              onDragEnd={finishDrag}
              onContextMenu={event => { event.preventDefault(); openSectionMenu(section, event.currentTarget, event.clientX, event.clientY); }}
              aria-expanded={!sectionClosed} onClick={() => toggleSection(section.id)}><span>{section.name}</span><Icon name="chevron" className="section-chevron"/></button>
            <button className="section-options" disabled={locked} aria-label={NAMES.sectionOptions(section.name)} aria-haspopup="menu" aria-expanded={menu?.kind === 'section' && menu.id === section.id} onClick={event => menu?.kind === 'section' && menu.id === section.id ? closeMenu() : openSectionMenu(section, event.currentTarget)}><Icon name="more"/></button>
          </div>
          <div className="section-reveal" data-open={!sectionClosed} aria-hidden={sectionClosed} inert={sectionClosed}><div className="section-sessions">{matches.filter(item => item.projectId === section.id).map(renderSession)}{!sessions.some(item => item.projectId === section.id) && <p className="side-empty">{dragging ? 'Drop here' : NAMES.noRecordings}</p>}</div></div>
        </section>;
      })}
      {(!filtering || recentSessions.length > 0) && <section aria-label={NAMES.recents} className={`recording-section recent-list ${dropTarget === 'recents' ? 'drop-target' : ''} ${insertion?.id === 'recents' ? 'insert-before' : ''}`} {...dropHandlers(null)}>
        <div className="section-heading recents-heading">{NAMES.recents}</div>
        {recentSessions.map(renderSession)}{!recentSessions.length && !props.loading && <p className="side-empty">{dragging ? 'Drop here' : NAMES.noRecordings}</p>}
      </section>}
      {/* Always mounted so screen readers hear "No matches" as the search narrows to nothing. */}
      <div className="side-filter-status" role="status">{noMatches && <p className="side-empty">{NAMES.noMatches}</p>}</div>
    </div>
    {props.utilities && <div className="side-bottom">{props.utilities}</div>}
    {menuPresence.present && shownMenu && (menuSession || menuSection || shownMenu.kind === 'panel') && <div ref={menuRef} className="sidebar-menu" data-state={menuPresence.phase} aria-hidden={!menu} inert={!menu} role="menu" aria-label={shownMenu.kind === 'panel' ? NAMES.panelActions : shownMenu.kind === 'section' ? NAMES.sectionActions : shownMenu.moving ? NAMES.moveToSection : NAMES.recordingActions} style={{ left: shownMenu.x, top: shownMenu.y }} onFocus={event => {
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]').forEach(button => { button.tabIndex = button === (event.target as HTMLElement) ? 0 : -1; });
    }} onKeyDown={event => {
      event.stopPropagation();
      const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); closeMenu(); }
      else if (event.key === 'Tab') { closeMenu(); }
      else if (event.key === 'ArrowLeft' && shownMenu.moving) { event.preventDefault(); setMenu({ ...shownMenu, moving: false }); }
      else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        const now = Date.now();
        const letter = event.key.toLocaleLowerCase();
        const text = now - typeahead.current.at < 700 ? typeahead.current.text + letter : letter;
        typeahead.current = { text, at: now };
        const query = [...text].every(char => char === letter) ? letter : text;
        [...buttons.slice(index + 1), ...buttons.slice(0, index + 1)].find(button => button.textContent?.trim().toLocaleLowerCase().startsWith(query))?.focus();
      }
    }}>
      {shownMenu.kind === 'panel' ? <>
        <button role="menuitem" disabled={locked} aria-keyshortcuts={newKey.aria} onClick={() => { closeMenu(); props.onNew(); }}>{NAMES.newRecording}<kbd className="menu-kbd" aria-hidden="true">{newKey.label}</kbd></button>
        <button role="menuitem" disabled={locked} onClick={() => { closeMenu(); props.onCreateSection(); }}>{NAMES.newSection}</button>
      </> : menuSection ? <>
        <button role="menuitem" onClick={() => { closeMenu(); props.onRenameSection(menuSection); }}>{NAMES.rename}</button>
        <button role="menuitem" disabled={sections[0]?.id === menuSection.id} onClick={() => { const index = sections.findIndex(item => item.id === menuSection.id); void reorder(menuSection.id, sections[index - 1]?.id ?? null, false); }}>{NAMES.moveUp}</button>
        <button role="menuitem" disabled={sections.at(-1)?.id === menuSection.id} onClick={() => { const index = sections.findIndex(item => item.id === menuSection.id); void reorder(menuSection.id, sections[index + 1]?.id ?? null, true); }}>{NAMES.moveDown}</button>
        <button role="menuitem" className="menu-separated destructive" disabled={!sectionDeletable(menuSection.id)} title={!sectionDeletable(menuSection.id) ? 'Finish recording and processing before deleting this section.' : undefined} onClick={() => { closeMenu(); props.onDeleteSection(menuSection); }}>{NAMES.deleteSectionItem}</button>
      </> : menuSession && (shownMenu.moving ? <>
        <div className="sidebar-menu-title">{NAMES.moveToSection}</div>
        <div className="section-destinations">
          <button role="menuitem" disabled={!menuSession.projectId} onClick={() => void move(menuSession.id, null)}>{NAMES.recents}{!menuSession.projectId && <Icon name="check"/>}</button>
          {sections.map(section => <button role="menuitem" key={section.id} disabled={menuSession.projectId === section.id} onClick={() => void move(menuSession.id, section.id)}>{section.name}{menuSession.projectId === section.id && <Icon name="check"/>}</button>)}
        </div>
        <button className="menu-separated" role="menuitem" onClick={() => { closeMenu(); props.onCreateSection(menuSession.id); }}><Icon name="plus"/>{NAMES.newSection}</button>
      </> : <>
        <button role="menuitem" onClick={() => setMenu({ ...shownMenu, moving: true })} onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); setMenu({ ...shownMenu, moving: true }); } }}>{NAMES.moveToSection}<Icon name="chevron"/></button>
        <button role="menuitem" onClick={() => { closeMenu(); props.onRename(menuSession); }}>{NAMES.rename}</button>
        <button role="menuitem" className="menu-separated destructive" onClick={() => { closeMenu(); props.onDeleteSession(menuSession); }}>{NAMES.deleteRecordingItem}</button>
      </>)}
    </div>}
  </aside>;
}
