import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { FormEventHandler, ReactNode, RefObject, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons';
import { usePresence } from './usePresence';
import './Dialog.css';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  role?: 'dialog' | 'alertdialog';
  description?: ReactNode;
  busy?: boolean;
  className?: string;
  closeLabel?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  onSubmit?: FormEventHandler<HTMLFormElement>;
}

const focusSelector = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex]:not([tabindex="-1"])';
function canFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element === document.body || element.closest('[inert],[hidden]') || element.matches(':disabled')) return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return false;
  }
  const closedDetails = element.closest('details:not([open])');
  return !closedDetails || !!closedDetails.querySelector(':scope > summary')?.contains(element);
}
function focusable(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(focusSelector)).filter(element => canFocus(element) && element.tabIndex >= 0);
}

export function Dialog(props: DialogProps) {
  const {present, phase} = usePresence(props.open);
  const [host] = useState(() => { const element = document.createElement('div'); element.dataset.dialogPortal = ''; return element; });
  const panel = useRef<HTMLElement | null>(null);
  const current = useRef(props);
  current.current = props;
  const lastOpen = useRef(props);
  if (props.open) lastOpen.current = props;
  const shown = props.open ? props : lastOpen.current;
  const titleId = useId();
  const descriptionId = useId();

  useLayoutEffect(() => {
    if (!present) return;
    const invoking = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.append(host);
    const background = new Map<HTMLElement, boolean>();
    const isolate = () => {
      for (const sibling of Array.from(document.body.children)) {
        if (sibling === host || !(sibling instanceof HTMLElement) || background.has(sibling)) continue;
        background.set(sibling, sibling.hasAttribute('inert'));
        sibling.setAttribute('inert', '');
      }
    };
    isolate();
    const observer = new MutationObserver(isolate);
    observer.observe(document.body, {childList: true});
    const focusFirst = () => {
      const target = current.current.initialFocusRef?.current;
      if (target && panel.current?.contains(target) && canFocus(target)) target.focus();
      else (panel.current && (focusable(panel.current)[0] || panel.current))?.focus();
    };
    focusFirst();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!current.current.busy && current.current.open) current.current.onClose();
      } else if (event.key === 'Tab' && panel.current) {
        const elements = focusable(panel.current);
        event.preventDefault();
        if (!elements.length) panel.current.focus();
        else {
          const index = elements.indexOf(document.activeElement as HTMLElement);
          const next = index < 0 ? (event.shiftKey ? elements.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length;
          elements[next].focus();
        }
      }
    };
    const containFocus = (event: FocusEvent) => { if (panel.current && !panel.current.contains(event.target as Node)) focusFirst(); };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', containFocus);
    return () => {
      observer.disconnect();
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', containFocus);
      for (const [element, wasInert] of background) if (!wasInert) element.removeAttribute('inert');
      host.remove();
      const requested = current.current.restoreFocusRef?.current;
      const fallback = current.current.fallbackFocusRef?.current;
      const target = [requested, invoking, fallback].find((item): item is HTMLElement => canFocus(item || null));
      if (target) target.focus();
      else document.querySelector<HTMLElement>('[data-dialog-focus-fallback]')?.focus();
    };
  }, [present, host]);

  if (!present) return null;
  // Exit motion retains the previous children only for painting. Their handlers
  // may close over a removed recording, so block both pointer and keyboard activation.
  const guardClosed = (event: SyntheticEvent) => {
    if (!current.current.open) { event.preventDefault(); event.stopPropagation(); }
  };
  const contents = <><div className="dialog-title"><h2 id={titleId}>{shown.title}</h2>{shown.closeLabel && <button type="button" aria-label={shown.closeLabel} disabled={props.busy} onClick={() => { if (!current.current.busy && current.current.open) current.current.onClose(); }}><Icon name="close" size={16} strokeWidth={2.25}/></button>}</div>{shown.description && <p className="dialog-description" id={descriptionId}>{shown.description}</p>}{shown.children}</>;
  const attributes = {className: `ui-dialog ${shown.className || ''}`, role: shown.role || 'dialog', 'aria-modal': true as const, 'aria-labelledby': titleId, 'aria-describedby': shown.description ? descriptionId : undefined, 'aria-busy': props.busy || undefined, tabIndex: -1};
  return createPortal(<div className="modal-backdrop ui-dialog-backdrop" data-state={phase} onClickCapture={guardClosed} onPointerDownCapture={guardClosed} onMouseDownCapture={guardClosed} onKeyDownCapture={guardClosed} onKeyUpCapture={guardClosed} onMouseDown={event => { if (event.target === event.currentTarget && !current.current.busy && current.current.open) current.current.onClose(); }}>
    {shown.onSubmit ? <form {...attributes} ref={element => {panel.current = element;}} onSubmit={event => { if (current.current.busy || !current.current.open) event.preventDefault(); else current.current.onSubmit?.(event); }}>{contents}</form> : <section {...attributes} ref={element => {panel.current = element;}}>{contents}</section>}
  </div>, host);
}
