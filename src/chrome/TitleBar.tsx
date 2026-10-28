import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Icon } from '../icons';
import { NAMES } from '../workspace/types';
import type { TitleBarProps } from '../workspace/types';
import { shortcut, windowApi } from './windowApi';
import type { Platform } from './windowApi';
import './chrome.css';

// Window chrome (decision 9). Windows draws its own title bar because the window has no
// decorations; macOS and Linux get a toolbar and keep their native window controls.
//
// Dragging uses Tauri's built-in `data-tauri-drag-region` handler: a bare attribute only
// reacts to presses on that element itself, so it goes on empty bar areas and never on a
// control or the search field. The same handler toggles maximize on a double-click.

type DragRegion = { 'data-tauri-drag-region'?: '' };
const dragRegion = (enabled: boolean): DragRegion => enabled ? { 'data-tauri-drag-region': '' } : {};

const run = (action: () => Promise<void>) => () => { action().catch(error => console.error(error)); };

/** Follows the window's maximized state; `override` wins when the caller already tracks it. */
function useMaximized(enabled: boolean, override?: boolean) {
  const [maximized, setMaximized] = useState(false);
  const tracked = enabled && override === undefined;
  useEffect(() => {
    if (!tracked) return;
    let active = true;
    let stop: (() => void) | undefined;
    const refresh = () => {
      windowApi.isMaximized().then(value => { if (active) setMaximized(value); }, () => {});
    };
    refresh();
    windowApi.onResized(refresh).then(unlisten => { if (active) stop = unlisten; else unlisten(); }, () => {});
    return () => { active = false; stop?.(); };
  }, [tracked]);
  return override ?? maximized;
}

/** Ctrl+K (⌘K on macOS) focuses the search field, except behind a dialog or inside a menu. */
function useSearchShortcut(os: Platform, input: RefObject<HTMLInputElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const modifier = os === 'macos' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!modifier || event.altKey || event.shiftKey || event.defaultPrevented || event.key.toLowerCase() !== 'k') return;
      const field = input.current;
      if (!field || field.disabled || field.closest('[inert]')) return;
      if (event.target instanceof Element && event.target.closest('[role=dialog],[role=alertdialog],[role=menu]')) return;
      event.preventDefault();
      field.focus();
      field.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [os, input, enabled]);
}

function Brand({ drag }: { drag: boolean }) {
  return <span className="chrome-brand" {...dragRegion(drag)}>
    <span className="chrome-mark" aria-hidden="true"><span/></span>CueReview
  </span>;
}

function SearchField({ os, value, onChange, input }: { os: Platform; value: string; onChange: (value: string) => void; input: RefObject<HTMLInputElement | null> }) {
  const hint = shortcut('k', os);
  return <div className="chrome-search has-kbd" onMouseDown={event => {
    // The icon and padding belong to the field: focus the input instead of starting a text selection.
    if (event.target !== input.current) { event.preventDefault(); input.current?.focus(); }
  }}>
    <Icon name="search" size={14} strokeWidth={1.9}/>
    <input ref={input} type="search" aria-label={NAMES.searchRecordings} placeholder={NAMES.searchRecordings}
      aria-keyshortcuts={hint.aria} autoComplete="off" spellCheck={false}
      value={value} onChange={event => onChange(event.target.value)}/>
    <kbd className="kbd-hint" aria-hidden="true">{hint.label}</kbd>
  </div>;
}

function SidebarToggle({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return <button type="button" className="chrome-icon chrome-sidebar-toggle" aria-label={visible ? NAMES.hideSidebar : NAMES.showSidebar} onClick={onToggle}>
    <Icon name="panel" size={16} strokeWidth={1.7}/>
  </button>;
}

function SettingsButton({ onOpen }: { onOpen: () => void }) {
  return <button type="button" className="chrome-icon" aria-label={NAMES.settings} aria-haspopup="dialog" onClick={onOpen}>
    <Icon name="sliders" size={16} strokeWidth={1.7}/>
  </button>;
}

function WindowControls({ maximized, compact = false }: { maximized: boolean; compact?: boolean }) {
  return <div className="window-controls">
    <button type="button" className="window-control" aria-label={NAMES.minimizeWindow} onClick={run(windowApi.minimize)}>
      <Icon name="minimize" size={10} strokeWidth={1.6}/>
    </button>
    {!compact && <button type="button" className="window-control" aria-label={maximized ? NAMES.restoreWindow : NAMES.maximizeWindow} onClick={run(windowApi.toggleMaximize)}>
      <Icon name={maximized ? 'restore' : 'maximize'} size={10} strokeWidth={1.6}/>
    </button>}
    <button type="button" className="window-control window-control-close" aria-label={NAMES.closeWindow} onClick={run(windowApi.close)}>
      <Icon name="close" size={10} strokeWidth={1.6}/>
    </button>
  </div>;
}

/** Room for the native macOS traffic lights (`trafficLightPosition` 24, 26 in tauri.macos.conf.json). */
function TrafficLightSpace() {
  return <span className="chrome-traffic-lights" aria-hidden="true" data-tauri-drag-region=""/>;
}

/**
 * The bar above compact recording mode. It drops search and the sidebar toggle.
 * Windows keeps Minimize and Close; macOS keeps room for the traffic lights.
 * Linux renders nothing because its native title bar already moves the window.
 */
export function CompactDragStrip({ platform: os }: { platform: Platform }) {
  if (os === 'linux') return null;
  if (os === 'macos') return <div className="chrome-strip" data-platform="macos" data-tauri-drag-region=""><TrafficLightSpace/></div>;
  return <header className="chrome-strip" data-platform="windows" aria-label={NAMES.titleBar} data-tauri-drag-region="">
    <Brand drag/>
    <WindowControls maximized={false} compact/>
  </header>;
}

/**
 * Windows: the custom title bar (logo, sidebar toggle, centered search, settings, window controls).
 * macOS: the content toolbar beside the inset sidebar panel. Its sidebar toggle appears only while the
 * sidebar is hidden, because the panel carries its own Collapse sidebar button.
 * Linux: the Windows layout without window controls or drag regions (native decorations).
 */
export function TitleBar(props: TitleBarProps) {
  const { platform: os, sidebarVisible, onToggleSidebar, search, onSearch, onOpenSettings, compact = false } = props;
  const localSearch = useRef<HTMLInputElement>(null);
  const input = props.searchRef ?? localSearch;
  const maximized = useMaximized(os === 'windows' && !compact, props.maximized);
  useSearchShortcut(os, input, !compact);

  if (compact) return <CompactDragStrip platform={os}/>;
  const field = <SearchField os={os} value={search} onChange={onSearch} input={input}/>;

  if (os === 'macos') return <header className="chrome-bar chrome-toolbar" data-platform="macos" data-sidebar={sidebarVisible ? 'visible' : 'hidden'} aria-label={NAMES.toolbar} data-tauri-drag-region="">
    {!sidebarVisible && <><TrafficLightSpace/><SidebarToggle visible={false} onToggle={onToggleSidebar}/></>}
    <Brand drag/>
    <div className="chrome-center" data-tauri-drag-region="">{field}</div>
    <SettingsButton onOpen={onOpenSettings}/>
  </header>;

  const windows = os === 'windows';
  return <header className={`chrome-bar ${windows ? 'chrome-titlebar' : 'chrome-toolbar'}`} data-platform={os} aria-label={windows ? NAMES.titleBar : NAMES.toolbar} {...dragRegion(windows)}>
    <Brand drag={windows}/>
    <SidebarToggle visible={sidebarVisible} onToggle={onToggleSidebar}/>
    <div className="chrome-center" {...dragRegion(windows)}>{field}</div>
    <SettingsButton onOpen={onOpenSettings}/>
    {windows && <WindowControls maximized={maximized}/>}
  </header>;
}
