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
  onMove: (sessionId: string, sectionId: string | null) => Promise<boolean>;
};
type Menu = { id: string; x: number; y: number; moving: boolean };

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
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const movable = (item: Session) => !locked && !['recording', 'processing'].includes(item.status);
  const expand = (id: string) => setClosed(current => { const next = new Set(current); next.delete(id); return next; });
  const closeMenu = () => { setMenu(null); returnFocus.current?.focus(); };
  const menuSession = sessions.find(item => item.id === menu?.id);

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
  useEffect(() => { if (locked) { setMenu(null); dragId.current = null; setDragging(null); setDropTarget(null); } }, [locked]);

  const openMenu = (item: Session, anchor: HTMLElement, x?: number, y?: number) => {
    if (!movable(item)) return;
    const rect = anchor.getBoundingClientRect();
    returnFocus.current = anchor;
    setMenu({ id: item.id, x: Math.max(8, Math.min(x ?? rect.right, window.innerWidth - 232)), y: Math.max(8, Math.min(y ?? rect.top, window.innerHeight - 296)), moving: false });
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
        const item = sessions.find(item => item.id === dragId.current);
        if (!item || !movable(item)) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(target);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(current => current === target ? null : current);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        const item = sessions.find(item => item.id === dragId.current);
        if (!item || !movable(item)) return;
        event.preventDefault(); dragId.current = null; setDragging(null); setDropTarget(null);
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
        setMenu(null); dragId.current = item.id; setDragging(item.id);
        event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id);
      }}
      onDragEnd={() => { dragId.current = null; setDragging(null); setDropTarget(null); }}>
      <span>{item.name}</span>{['recording', 'processing'].includes(item.status) && <small>{item.status === 'recording' ? 'Recording' : 'Processing…'}</small>}
    </button>
    <button className="session-options" aria-label="Recording options" title={`Options for ${item.name}`} aria-haspopup="menu" aria-expanded={menu?.id === item.id} disabled={!movable(item)} onClick={event => menu?.id === item.id ? closeMenu() : openMenu(item, event.currentTarget)}><Icon name="more"/></button>
  </div>;
  // Older recordings retain their section IDs. If a section is unavailable, keep its recordings reachable.
  const recentSessions = sessions.filter(item => !item.projectId || !sections.some(section => section.id === item.projectId));

  return <aside className="sidebar" aria-label="Recordings">
    <div className="side-tools"><button aria-label="Collapse sidebar" onClick={props.onCollapse}><Icon name="panel"/></button><button disabled={locked} onClick={props.onNew} title="New recording (Ctrl+N)"><Icon name="plus"/>New recording</button></div>
    <div className="recording-list">
      {sections.map(section => <section key={section.id} aria-label={`Section: ${section.name}`} className={`recording-section ${dropTarget === section.id ? 'drop-target' : ''}`} {...dropHandlers(section.id)}>
        <div className="section-heading">
          <button className="section-toggle" aria-expanded={!closed.has(section.id)} onClick={() => setClosed(current => { const next = new Set(current); if (next.has(section.id)) next.delete(section.id); else next.add(section.id); return next; })}><Icon name="chevron" style={{ transform: closed.has(section.id) ? '' : 'rotate(90deg)' }}/><span>{section.name}</span></button>
          <button className="section-options" disabled={locked} aria-label={`Rename section ${section.name}`} onClick={() => props.onRenameSection(section)}><Icon name="edit"/></button>
        </div>
        {!closed.has(section.id) && <div className="section-sessions">{sessions.filter(item => item.projectId === section.id).map(renderSession)}{!sessions.some(item => item.projectId === section.id) && <p className="side-empty">{dragging ? 'Drop here' : 'No recordings'}</p>}</div>}
      </section>)}
      <section aria-label="Recents" className={`recording-section recent-list ${dropTarget === 'recents' ? 'drop-target' : ''}`} {...dropHandlers(null)}>
        <div className="section-heading recents-heading">Recents</div>
        {recentSessions.map(renderSession)}{!recentSessions.length && !props.loading && <p className="side-empty">{dragging ? 'Drop here' : 'No recordings'}</p>}
      </section>
    </div>
    <div className="side-bottom"><button className="new-section" disabled={locked} onClick={() => props.onCreateSection()}><Icon name="plus"/>New section</button>{props.utilities}</div>
    {menu && menuSession && <div ref={menuRef} className="sidebar-menu" role="menu" aria-label={menu.moving ? 'Move to section' : 'Recording actions'} style={{ left: menu.x, top: menu.y }} onKeyDown={event => {
      event.stopPropagation();
      const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); closeMenu(); }
      else if (event.key === 'ArrowLeft' && menu.moving) { event.preventDefault(); setMenu({ ...menu, moving: false }); }
    }}>
      {menu.moving ? <>
        <div className="sidebar-menu-title">Move to section</div>
        <div className="section-destinations">
          <button role="menuitem" disabled={!menuSession.projectId} onClick={() => void move(menuSession.id, null)}>Recents{!menuSession.projectId && <Icon name="check"/>}</button>
          {sections.map(section => <button role="menuitem" key={section.id} disabled={menuSession.projectId === section.id} onClick={() => void move(menuSession.id, section.id)}>{section.name}{menuSession.projectId === section.id && <Icon name="check"/>}</button>)}
        </div>
        <button className="menu-separated" role="menuitem" onClick={() => { closeMenu(); props.onCreateSection(menuSession.id); }}><Icon name="plus"/>New section</button>
      </> : <>
        <button role="menuitem" onClick={() => setMenu({ ...menu, moving: true })} onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); setMenu({ ...menu, moving: true }); } }}>Move to section<Icon name="chevron"/></button>
        <button role="menuitem" onClick={() => { closeMenu(); props.onRename(menuSession); }}>Rename</button>
      </>}
    </div>}
  </aside>;
}
