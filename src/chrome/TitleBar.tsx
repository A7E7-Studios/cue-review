import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { NAMES } from '../workspace/types';
import type { TitleBarProps } from '../workspace/types';
import { windowApi } from './windowApi';
import type { Platform } from './windowApi';
import './chrome.css';

// Window chrome (decision 9). Windows draws its own title bar because the window has no
// decorations; macOS and Linux get a toolbar and keep their native window controls.
//
// Dragging uses Tauri's built-in `data-tauri-drag-region` handler: a bare attribute only
// reacts to presses on that element itself, so it goes on empty bar areas and never on a
// control. The same handler toggles maximize on a double-click.

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

function Brand({ drag }: { drag: boolean }) {
  return <span className="chrome-brand" {...dragRegion(drag)}>
    <span className="chrome-mark" aria-hidden="true"><span/></span>CueReview
  </span>;
}

// Toolbar icons are 20px in 36×32 buttons on Windows and Linux; macOS draws them at 16px (chrome.css).
function SidebarToggle({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return <button type="button" className="chrome-icon chrome-sidebar-toggle" aria-label={visible ? NAMES.hideSidebar : NAMES.showSidebar} onClick={onToggle}>
    <Icon name="panel" size={20} strokeWidth={1.6}/>
  </button>;
}

function SettingsButton({ onOpen }: { onOpen: () => void }) {
  return <button type="button" className="chrome-icon" aria-label={NAMES.settings} aria-haspopup="dialog" onClick={onOpen}>
    <Icon name="sliders" size={20} strokeWidth={1.6}/>
  </button>;
}

/**
 * Window-control glyphs drawn as Windows draws its own: a 10×10 box with 1px lines on whole pixels
 * (the half-pixel coordinates centre each line on a pixel row). Close is diagonal, so it keeps
 * anti-aliasing; the others are drawn with crisp edges.
 */
const windowGlyphs = {
  minimize: 'M0 5.5h10',
  maximize: 'M.5.5h9v9h-9z',
  restore: 'M.5 2.5h7v7h-7zM2.5 2.5v-2h7v7h-2',
  close: 'M.5.5l9 9M9.5.5l-9 9',
} as const;
function WindowGlyph({ name }: { name: keyof typeof windowGlyphs }) {
  return <svg className="window-glyph" viewBox="0 0 10 10" width={10} height={10} fill="none" stroke="currentColor" strokeWidth={1}
    shapeRendering={name === 'close' ? 'geometricPrecision' : 'crispEdges'} aria-hidden="true"><path d={windowGlyphs[name]}/></svg>;
}

function WindowControls({ maximized, compact = false }: { maximized: boolean; compact?: boolean }) {
  return <div className="window-controls">
    <button type="button" className="window-control" aria-label={NAMES.minimizeWindow} onClick={run(windowApi.minimize)}>
      <WindowGlyph name="minimize"/>
    </button>
    {!compact && <button type="button" className="window-control" aria-label={maximized ? NAMES.restoreWindow : NAMES.maximizeWindow} onClick={run(windowApi.toggleMaximize)}>
      <WindowGlyph name={maximized ? 'restore' : 'maximize'}/>
    </button>}
    <button type="button" className="window-control window-control-close" aria-label={NAMES.closeWindow} onClick={run(windowApi.close)}>
      <WindowGlyph name="close"/>
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
 * Windows: the custom title bar (logo, sidebar toggle, settings, window controls). Search opens from
 * the sidebar (search spec), so the bar's middle is empty and drags the window.
 * macOS: the content toolbar beside the inset sidebar panel. Its sidebar toggle appears only while the
 * sidebar is hidden, because the panel carries its own Hide sidebar button.
 * Linux: the Windows layout without window controls or drag regions (native decorations).
 */
export function TitleBar(props: TitleBarProps) {
  const { platform: os, sidebarVisible, onToggleSidebar, onOpenSettings, compact = false } = props;
  const maximized = useMaximized(os === 'windows' && !compact, props.maximized);

  if (compact) return <CompactDragStrip platform={os}/>;

  if (os === 'macos') return <header className="chrome-bar chrome-toolbar" data-platform="macos" data-sidebar={sidebarVisible ? 'visible' : 'hidden'} aria-label={NAMES.toolbar} data-tauri-drag-region="">
    {!sidebarVisible && <><TrafficLightSpace/><SidebarToggle visible={false} onToggle={onToggleSidebar}/></>}
    <Brand drag/>
    <div className="chrome-center" data-tauri-drag-region=""/>
    <SettingsButton onOpen={onOpenSettings}/>
  </header>;

  const windows = os === 'windows';
  return <header className={`chrome-bar ${windows ? 'chrome-titlebar' : 'chrome-toolbar'}`} data-platform={os} aria-label={windows ? NAMES.titleBar : NAMES.toolbar} {...dragRegion(windows)}>
    <Brand drag={windows}/>
    <SidebarToggle visible={sidebarVisible} onToggle={onToggleSidebar}/>
    <div className="chrome-center" {...dragRegion(windows)}/>
    <SettingsButton onOpen={onOpenSettings}/>
    {windows && <WindowControls maximized={maximized}/>}
  </header>;
}
