import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { useFocusRescue } from './useFocusRescue';

function Harness() {
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(true);
  useFocusRescue(root, () => root.current?.querySelector<HTMLElement>('#fallback'));
  return <div ref={root}>
    {shown && <button onClick={() => setShown(false)}>Hide me</button>}
    <button id="fallback">Fallback</button>
    <button onClick={() => setShown(value => !value)}>Toggle</button>
    <p>Empty space</p>
  </div>;
}

describe('useFocusRescue', () => {
  it('moves focus from a control that unmounts', () => {
    render(<Harness/>);
    const hide = screen.getByRole('button', { name: 'Hide me' });
    hide.focus();
    fireEvent.click(hide);
    expect(screen.queryByRole('button', { name: 'Hide me' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fallback' })).toHaveFocus();
  });

  it('leaves focus alone after a click on empty space', () => {
    render(<Harness/>);
    screen.getByRole('button', { name: 'Hide me' }).focus();
    fireEvent.pointerDown(screen.getByText('Empty space'));
    act(() => (document.activeElement as HTMLElement).blur());
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    expect(document.activeElement).toBe(document.body);
  });

  it('does nothing while focus is still somewhere in the page', () => {
    render(<Harness/>);
    const toggle = screen.getByRole('button', { name: 'Toggle' });
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle).toHaveFocus();
  });
});
