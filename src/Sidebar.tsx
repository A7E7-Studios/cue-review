import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import type { Project, Session } from './backend';
import { Icon } from './icons';
import { formatTime } from './review';

type Props = {
  sections: Project[];
  sessions: Session[];
  activeId?: string;
  locked: boolean;
  loading: boolean;
  utilities: ReactNode;
  onCollapse: () => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRename: (session: Session) => void;
  onRenameSection: (section: Project) => void;
  onCreateSection: (sessionId?: string) => void;
  onDeleteSection: (section: Project) => void;
  onDeleteSession: (session: Session) => void;
  onReorder: (ids: string[]) => Promise<boolean>;
  onMove: (sessionId: string, sectionId: string | null) => Promise<boolean>;
};
type Menu = { kind: 'session' | 'section'; id: string; x: number; y: number; moving: boolean };

export function Sidebar(props: Props) {
  const { sections, sessions, locked } = props;
  const [closed, setClosed] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('cuereview.closedSections') || '[]');
      return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
    } catch { return new Set(); }
  });
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const sectionDragId = useRef<string | null>(null);
  const [draggingSection, setDraggingSection] = useState<string | null>(null);
  const [insertion, setInsertion] = useState<{ id: string; after: boolean } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const movable = (item: Session) => !locked && !['recording', 'processing'].includes(item.status);
  const expand = (id: string) => setClosed(current => { const next = new Set(current); next.delete(id); return next; });
  const closeMenu = () => { setMenu(null); returnFocus.current?.focus(); };
  const menuSession = menu?.kind === 'session' ? sessions.find(item => item.id === menu.id) : undefined;
  const menuSection = menu?.kind === 'section' ? sections.find(item => item.id === menu.id) : undefined;
  const sectionDeletable = (id: string) => !locked && !sessions.some(item => item.projectId === id && ['recording', 'processing'].includes(item.status));
  const finishDrag = () => { dragId.current = null; sectionDragId.current = null; setDragging(null); setDraggingSection(null); setDropTarget(null); setInsertion(null); };

  useEffect(() => { localStorage.setItem('cuereview.closedSections', JSON.stringify([...closed])); }, [closed]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !returnFocus.current?.contains(event.target)) setMenu(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menu]);
  useEffect(() => { if (locked) { setMenu(null); finishDrag(); } }, [locked]);

  const openMenu = (item: Session, anchor: HTMLElement, x?: number, y?: number) => {
    if (!movable(item)) return;
    const rect = anchor.getBoundingClientRect();
    returnFocus.current = anchor;
    setMenu({ kind: 'session', id: item.id, x: Math.max(8, Math.min(x ?? rect.right, window.innerWidth - 232)), y: Math.max(8, Math.min(y ?? rect.top, window.innerHeight - 296)), moving: false });
  };
  const openSectionMenu = (section: Project, anchor: HTMLElement, x?: number, y?: number) => {
    if (locked) return;
    const rect = anchor.getBoundingClientRect(); returnFocus.current = anchor;
    setMenu({ kind: 'section', id: section.id, x: Math.max(8, Math.min(x ?? rect.right, window.innerWidth - 232)), y: Math.max(8, Math.min(y ?? rect.top, window.innerHeight - 296)), moving: false });
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
          const rect = event.currentTarget.getBoundingClientRect();
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
          const rect = event.currentTarget.getBoundingClientRect();
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
  const renderSession = (item: Session) => <div className={`session-row ${props.activeId === item.id ? 'active' : ''} ${dragging === item.id ? 'dragging' : ''}`} data-session-id={item.id} key={item.id}>
    <button className={`session ${props.activeId === item.id ? 'active' : ''}`} disabled={locked} draggable={movable(item)}
      title={`${item.name} · ${new Date(item.createdAt).toLocaleDateString()} · ${formatTime(item.durationMs)}`}
      onClick={() => props.onOpen(item.id)}
      onDoubleClick={() => { if (movable(item)) props.onRename(item); }}
      onContextMenu={event => { event.preventDefault(); openMenu(item, event.currentTarget, event.clientX, event.clientY); }}
      onDragStart={event => {
        if (!movable(item)) { event.preventDefault(); return; }
        setMenu(null); sectionDragId.current = null; dragId.current = item.id; setDragging(item.id);
        event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id);
      }}
      onDragEnd={finishDrag}>
      <span>{item.name}</span>{['recording', 'processing'].includes(item.status) && <small>{item.status === 'recording' ? 'Recording' : 'Processing…'}</small>}
    </button>
    <button className="session-options" aria-label="Recording options" title={`Options for ${item.name}`} aria-haspopup="menu" aria-expanded={menu?.kind === 'session' && menu.id === item.id} disabled={!movable(item)} onClick={event => menu?.kind === 'session' && menu.id === item.id ? closeMenu() : openMenu(item, event.currentTarget)}><Icon name="more"/></button>
  </div>;
  // Older recordings retain their section IDs. If a section is unavailable, keep its recordings reachable.
  const recentSessions = sessions.filter(item => !item.projectId || !sections.some(section => section.id === item.projectId));

  return <aside className="sidebar" aria-label="Recordings">
    <div className="side-tools"><button aria-label="Collapse sidebar" onClick={props.onCollapse}><Icon name="panel"/></button><button disabled={locked} onClick={props.onNew} title="New recording (Ctrl+N)"><Icon name="plus"/>New recording</button></div>
    <div className="recording-list">
      {sections.map(section => <section key={section.id} data-section-id={section.id} aria-label={`Section: ${section.name}`} className={`recording-section ${dropTarget === section.id ? 'drop-target' : ''} ${draggingSection === section.id ? 'dragging-section' : ''} ${insertion?.id === section.id ? insertion.after ? 'insert-after' : 'insert-before' : ''}`} {...dropHandlers(section.id)}>
        <div className="section-heading">
          <button className="section-toggle" draggable={!locked} disabled={locked}
            onDragStart={event => { if (locked) { event.preventDefault(); return; } setMenu(null); dragId.current = null; sectionDragId.current = section.id; setDraggingSection(section.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', section.id); }}
            onDragEnd={finishDrag}
            onContextMenu={event => { event.preventDefault(); openSectionMenu(section, event.currentTarget, event.clientX, event.clientY); }}
            aria-expanded={!closed.has(section.id)} onClick={() => setClosed(current => { const next = new Set(current); if (next.has(section.id)) next.delete(section.id); else next.add(section.id); return next; })}><Icon name="chevron" style={{ transform: closed.has(section.id) ? '' : 'rotate(90deg)' }}/><span>{section.name}</span></button>
          <button className="section-options" disabled={locked} aria-label={`Section options for ${section.name}`} aria-haspopup="menu" aria-expanded={menu?.kind === 'section' && menu.id === section.id} onClick={event => menu?.kind === 'section' && menu.id === section.id ? closeMenu() : openSectionMenu(section, event.currentTarget)}><Icon name="more"/></button>
        </div>
        {!closed.has(section.id) && <div className="section-sessions">{sessions.filter(item => item.projectId === section.id).map(renderSession)}{!sessions.some(item => item.projectId === section.id) && <p className="side-empty">{dragging ? 'Drop here' : 'No recordings'}</p>}</div>}
      </section>)}
      <section aria-label="Recents" className={`recording-section recent-list ${dropTarget === 'recents' ? 'drop-target' : ''} ${insertion?.id === 'recents' ? 'insert-before' : ''}`} {...dropHandlers(null)}>
        <div className="section-heading recents-heading">Recents</div>
        {recentSessions.map(renderSession)}{!recentSessions.length && !props.loading && <p className="side-empty">{dragging ? 'Drop here' : 'No recordings'}</p>}
      </section>
    </div>
    <div className="side-bottom"><button className="new-section" disabled={locked} onClick={() => props.onCreateSection()}><Icon name="plus"/>New section</button>{props.utilities}</div>
    {menu && (menuSession || menuSection) && <div ref={menuRef} className="sidebar-menu" role="menu" aria-label={menu.kind === 'section' ? 'Section actions' : menu.moving ? 'Move to section' : 'Recording actions'} style={{ left: menu.x, top: menu.y }} onKeyDown={event => {
      event.stopPropagation();
      const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); closeMenu(); }
      else if (event.key === 'ArrowLeft' && menu.moving) { event.preventDefault(); setMenu({ ...menu, moving: false }); }
    }}>
      {menuSection ? <>
        <button role="menuitem" onClick={() => { closeMenu(); props.onRenameSection(menuSection); }}>Rename</button>
        <button role="menuitem" disabled={sections[0]?.id === menuSection.id} onClick={() => { const index = sections.findIndex(item => item.id === menuSection.id); void reorder(menuSection.id, sections[index - 1]?.id ?? null, false); }}>Move up</button>
        <button role="menuitem" disabled={sections.at(-1)?.id === menuSection.id} onClick={() => { const index = sections.findIndex(item => item.id === menuSection.id); void reorder(menuSection.id, sections[index + 1]?.id ?? null, true); }}>Move down</button>
        <button role="menuitem" className="menu-separated destructive" disabled={!sectionDeletable(menuSection.id)} title={!sectionDeletable(menuSection.id) ? 'Finish recording and processing before deleting this section.' : undefined} onClick={() => { closeMenu(); props.onDeleteSection(menuSection); }}>Delete section…</button>
      </> : menuSession && (menu.moving ? <>
        <div className="sidebar-menu-title">Move to section</div>
        <div className="section-destinations">
          <button role="menuitem" disabled={!menuSession.projectId} onClick={() => void move(menuSession.id, null)}>Recents{!menuSession.projectId && <Icon name="check"/>}</button>
          {sections.map(section => <button role="menuitem" key={section.id} disabled={menuSession.projectId === section.id} onClick={() => void move(menuSession.id, section.id)}>{section.name}{menuSession.projectId === section.id && <Icon name="check"/>}</button>)}
        </div>
        <button className="menu-separated" role="menuitem" onClick={() => { closeMenu(); props.onCreateSection(menuSession.id); }}><Icon name="plus"/>New section</button>
      </> : <>
        <button role="menuitem" onClick={() => setMenu({ ...menu, moving: true })} onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); setMenu({ ...menu, moving: true }); } }}>Move to section<Icon name="chevron"/></button>
        <button role="menuitem" onClick={() => { closeMenu(); props.onRename(menuSession); }}>Rename</button>
        <button role="menuitem" className="menu-separated destructive" onClick={() => { closeMenu(); props.onDeleteSession(menuSession); }}>Delete recording…</button>
      </>)}
    </div>}
  </aside>;
}
