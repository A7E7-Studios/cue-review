import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, ReactNode, Ref, RefObject } from 'react';
import { Icon } from '../icons';
import { shortcut } from '../chrome/windowApi';
import type { Platform } from '../chrome/windowApi';
import { NAMES } from './types';
import type { CaptureControlsProps, CaptureMenu } from './types';
import './workspace.css';

export interface Placement { left: number; top: number; maxHeight: number; side: 'top' | 'bottom' }
/**
 * Places a popover against its trigger: below when it fits (or when below has more
 * room), otherwise above. It stays `margin` px inside the viewport horizontally, and
 * `maxHeight` caps it to the room on the chosen side so its list scrolls instead.
 */
export function placePopover(anchor: { left: number; top: number; bottom: number }, popover: { width: number; height: number }, viewport: { width: number; height: number }, gap = 6, margin = 8): Placement {
  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const side = popover.height <= below || below >= above ? 'bottom' : 'top';
  const maxHeight = Math.max(0, Math.floor(side === 'bottom' ? below : above));
  const height = Math.min(popover.height, maxHeight);
  const top = side === 'bottom' ? anchor.bottom + gap : anchor.top - gap - height;
  const left = Math.max(margin, Math.min(anchor.left, viewport.width - popover.width - margin));
  return { left: Math.round(left), top: Math.round(top), maxHeight, side };
}

const TYPEAHEAD_MS = 700;
const DEVICE_KINDS = new Set(['android', 'quest']);

function useForwardedRef<T>(local: RefObject<T | null>, external?: Ref<T>) {
  return useCallback((node: T | null) => {
    local.current = node;
    if (typeof external === 'function') external(node);
    else if (external) external.current = node;
  }, [local, external]);
}

interface Option { id: string; label: ReactNode; name?: string; selected: boolean; onSelect?: () => void }

/** Option buttons with one tab stop, Arrow keys, Home/End and typeahead. */
function OptionList({ label, options }: { label: string; options: Option[] }) {
  const list = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const typeahead = useRef({ text: '', at: 0 });
  const stop = options.some(option => option.id === active) ? active : options.find(option => option.selected)?.id ?? options[0]?.id;
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('.cr-option:not(:disabled)') ?? [])];
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const letter = event.key.toLocaleLowerCase();
      const text = now - typeahead.current.at < TYPEAHEAD_MS ? typeahead.current.text + letter : letter;
      typeahead.current = { text, at: now };
      const query = [...text].every(character => character === letter) ? letter : text;
      [...buttons.slice(index + 1), ...buttons.slice(0, index + 1)].find(button => button.textContent?.trim().toLocaleLowerCase().startsWith(query))?.focus();
    }
  };
  return <div ref={list} className="cr-option-list" role="group" aria-label={label} onKeyDown={keyDown}>
    {options.map(option => <button key={option.id} type="button" className="cr-btn cr-option" aria-pressed={option.selected} aria-label={option.name}
      tabIndex={option.id === stop ? 0 : -1} onFocus={() => setActive(option.id)} onClick={option.onSelect}>
      <span>{option.label}</span>{option.selected && <Icon name="check" strokeWidth={2}/>}
    </button>)}
  </div>;
}

/** A panel anchored to its trigger that flips within the viewport. */
function Popover({ id, anchor, title, refreshLabel, onRefresh, children }: { id: string; anchor: RefObject<HTMLElement | null>; title: string; refreshLabel: string; onRefresh: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const place = () => {
      const trigger = anchor.current;
      if (!trigger) return;
      element.style.maxHeight = '';
      const rect = element.getBoundingClientRect();
      const next = placePopover(trigger.getBoundingClientRect(), rect, { width: window.innerWidth, height: window.innerHeight });
      element.style.left = `${next.left}px`;
      element.style.top = `${next.top}px`;
      element.style.maxHeight = `${next.maxHeight}px`;
      element.dataset.side = next.side;
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(element);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { observer?.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor]);
  return <div ref={panel} id={id} className="cr-popover">
    <div className="cr-popover-title"><span>{title}</span><button type="button" className="cr-btn cr-popover-refresh" aria-label={refreshLabel} title={refreshLabel} onClick={onRefresh}><Icon name="refresh" strokeWidth={1.8}/></button></div>
    {children}
  </div>;
}

export interface CaptureControlsViewProps extends CaptureControlsProps {
  /** Shortcut labels follow this platform; detected from the user agent when omitted. */
  platform?: Platform;
}

/** Draft controls: source and microphone pickers and Record. Keeps the `.source-trigger` and `.mic-trigger` hooks. */
export function CaptureControls(props: CaptureControlsViewProps) {
  const { sources, source, microphones, microphoneId, microphoneUnavailable, systemAudio, muted, menu, onMenu, locked, busy, recordLabel, recordDisabled, onRecord, platform } = props;
  const sourceTrigger = useRef<HTMLButtonElement>(null);
  const micTrigger = useRef<HTMLButtonElement>(null);
  const sourceRef = useForwardedRef(sourceTrigger, props.sourceTriggerRef);
  const micRef = useForwardedRef(micTrigger, props.microphoneTriggerRef);
  const sourceField = useRef<HTMLDivElement>(null);
  const micField = useRef<HTMLDivElement>(null);
  const ids = useId();
  const latestMenu = useRef(onMenu);
  useLayoutEffect(() => { latestMenu.current = onMenu; });
  const record = shortcut('r', platform);
  const microphone = microphones.find(item => item.id === microphoneId);
  const micLabel = microphoneUnavailable ? NAMES.microphoneUnavailable : muted && microphoneId ? NAMES.muted : microphone?.name || NAMES.noMicrophone;
  const trigger = (which: CaptureMenu) => which === 'source' ? sourceTrigger.current : micTrigger.current;
  const choose = (which: CaptureMenu, action: () => void) => { action(); onMenu(null); trigger(which)?.focus(); };

  // Opening a picker focuses its selected option; a click outside closes it.
  useEffect(() => {
    if (!menu) return;
    const field = menu === 'source' ? sourceField.current : micField.current;
    const panel = field?.querySelector('.cr-popover');
    (panel?.querySelector<HTMLElement>('.cr-option[aria-pressed="true"]:not(:disabled)') ?? panel?.querySelector<HTMLElement>('.cr-option:not(:disabled)'))?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !field?.contains(event.target)) latestMenu.current(null); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menu]);
  useEffect(() => { if ((locked && menu === 'source') || (busy && menu === 'microphone')) latestMenu.current(null); }, [locked, busy, menu]);

  const fieldHandlers = (which: CaptureMenu) => ({
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Escape' || menu !== which) return;
      event.preventDefault(); event.stopPropagation();
      onMenu(null); trigger(which)?.focus();
    },
    // Tabbing out of the trigger and its picker closes the picker.
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      if (menu === which && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) onMenu(null);
    },
  });

  const sourceOptions: Option[] = sources.map(item => ({
    id: item.id, selected: source?.id === item.id,
    name: item.available ? undefined : NAMES.unavailableSource(item.name),
    label: <>{item.name}{!item.available && <small>Unavailable</small>}</>,
    onSelect: () => choose('source', () => props.onSelectSource(item.id)),
  }));
  const micOptions: Option[] = [
    { id: 'cr:none', label: NAMES.noMicrophone, selected: microphoneId === '', onSelect: () => choose('microphone', () => props.onSelectMicrophone('')) },
    ...(microphoneUnavailable ? [{ id: 'cr:previous', label: NAMES.previousMicrophoneUnavailable, selected: true }] : []),
    ...microphones.map(item => ({ id: item.id, label: item.name, selected: microphoneId === item.id, onSelect: () => choose('microphone', () => props.onSelectMicrophone(item.id)) })),
  ];

  return <div className="cr-capture">
    <div ref={sourceField} className="cr-capture-field" {...fieldHandlers('source')}>
      <button ref={sourceRef} type="button" className="cr-btn cr-capture-trigger source-trigger" title={source?.name} disabled={locked}
        aria-expanded={menu === 'source'} aria-controls={menu === 'source' ? `${ids}-source` : undefined} onClick={() => onMenu(menu === 'source' ? null : 'source')}>
        <Icon name="monitor" strokeWidth={1.7}/><span>{source?.name || 'Choose source'}</span><Icon name="chevron" strokeWidth={2}/>
      </button>
      {menu === 'source' && <Popover id={`${ids}-source`} anchor={sourceTrigger} title="Capture source" refreshLabel={NAMES.refreshCaptureDevices} onRefresh={props.onRefreshSources}>
        <OptionList label={NAMES.captureSources} options={sourceOptions}/>
        {source?.detail && <p className="cr-popover-note">{source.detail}</p>}
        <label className="cr-popover-check"><input type="checkbox" checked={systemAudio} onChange={event => props.onSystemAudio(event.target.checked)}/>{source && DEVICE_KINDS.has(source.kind) ? NAMES.includeDeviceAudio : NAMES.includeSystemAudio}</label>
      </Popover>}
    </div>
    <div ref={micField} className="cr-capture-field" {...fieldHandlers('microphone')}>
      <button ref={micRef} type="button" className="cr-btn cr-capture-trigger mic-trigger" disabled={busy}
        title={microphoneUnavailable ? 'Selected microphone unavailable. Reconnect it or choose another input.' : undefined}
        aria-expanded={menu === 'microphone'} aria-controls={menu === 'microphone' ? `${ids}-microphone` : undefined} onClick={() => onMenu(menu === 'microphone' ? null : 'microphone')}>
        <Icon name={microphone && !muted ? 'mic' : 'micOff'} strokeWidth={1.7}/><span>{micLabel}</span><Icon name="chevron" strokeWidth={2}/>
      </button>
      {menu === 'microphone' && <Popover id={`${ids}-microphone`} anchor={micTrigger} title="Microphone" refreshLabel={NAMES.refreshMicrophones} onRefresh={props.onRefreshMicrophones}>
        <OptionList label={NAMES.microphoneOptions} options={micOptions}/>
        {microphoneUnavailable && <p className="cr-popover-note">Reconnect the selected microphone and refresh microphones, choose another input, or select No microphone.</p>}
        <label className="cr-popover-check"><input type="checkbox" checked={muted} onChange={event => props.onMuted(event.target.checked)}/>{NAMES.muteMicrophone}</label>
      </Popover>}
    </div>
    <span className="cr-spacer"/>
    <button type="button" className="cr-btn cr-dark-pill cr-record" title={`Start recording (${record.label})`} aria-keyshortcuts={record.aria} disabled={recordDisabled} onClick={onRecord}>
      <span className="cr-record-dot" aria-hidden="true"/>{recordLabel}
    </button>
  </div>;
}
