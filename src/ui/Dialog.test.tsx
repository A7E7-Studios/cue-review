import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import { Dialog } from './Dialog';

beforeEach(() => { document.documentElement.dataset.motion = 'reduced'; });
afterEach(() => { delete document.documentElement.dataset.motion; vi.useRealTimers(); });

function Harness({busy = false, removeTrigger = false}: {busy?: boolean; removeTrigger?: boolean}) {
  const [open, setOpen] = useState(false);
  const [removed, setRemoved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const fallback = useRef<HTMLButtonElement>(null);
  return <><button ref={fallback}>Surviving control</button>{!removed && <button onClick={() => setOpen(true)}>Open note</button>}
    <Dialog open={open} onClose={() => setOpen(false)} title="Note" busy={busy} initialFocusRef={input} fallbackFocusRef={fallback}>
      <label>Note text<input ref={input}/></label>
      <button disabled={busy} onClick={() => {setOpen(false); if (removeTrigger) setRemoved(true);}}>Done</button>
    </Dialog></>;
}

describe('Dialog', () => {
  it('moves focus inside, makes background inert, contains Tab and restores the invoking control', async () => {
    const user = userEvent.setup();
    const {container} = render(<Harness/>);
    const trigger = screen.getByRole('button', {name:'Open note'});
    await user.click(trigger);
    const input = screen.getByRole('textbox', {name:'Note text'});
    expect(input).toHaveFocus();
    expect(container).toHaveAttribute('inert');
    await user.tab({shift:true});
    expect(screen.getByRole('button', {name:'Done'})).toHaveFocus();
    await user.tab(); expect(input).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(container).not.toHaveAttribute('inert');
  });

  it('restores a surviving fallback after the invoking row is removed', async () => {
    const user = userEvent.setup(); render(<Harness removeTrigger/>);
    await user.click(screen.getByRole('button', {name:'Open note'}));
    await user.click(screen.getByRole('button', {name:'Done'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', {name:'Surviving control'})).toHaveFocus();
  });

  it('blocks Escape and backdrop dismissal while busy', async () => {
    const user = userEvent.setup(); render(<Harness busy/>);
    await user.click(screen.getByRole('button', {name:'Open note'}));
    await user.keyboard('{Escape}');
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy','true');
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('cannot activate retained destructive children after Escape starts exit motion', async () => {
    document.documentElement.dataset.motion = 'full';
    const destroy = vi.fn();
    function Confirmation() {
      const [open, setOpen] = useState(true);
      return <Dialog open={open} onClose={()=>setOpen(false)} title="Confirm deletion"><button onClick={destroy}>Delete files</button></Dialog>;
    }
    const user = userEvent.setup(); render(<Confirmation/>);
    const button = screen.getByRole('button',{name:'Delete files'});
    expect(button).toHaveFocus();
    await user.keyboard('{Escape}{Enter} ');
    expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state','exiting');
    fireEvent.click(button);
    expect(destroy).not.toHaveBeenCalled();
    await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('skips controls inside hidden ancestors and closed details when moving focus', async () => {
    const user = userEvent.setup();
    render(<Dialog open onClose={()=>{}} title="Focus choices"><div style={{display:'none'}}><button>Hidden action</button></div><details><summary>Details</summary><button>Collapsed action</button></details><button>Visible action</button></Dialog>);
    expect(screen.getByText('Details')).toHaveFocus();
    await user.tab(); expect(screen.getByRole('button',{name:'Visible action'})).toHaveFocus();
    await user.tab(); expect(screen.getByText('Details')).toHaveFocus();
  });

  it('keeps background inert through exit motion and supports live reduced-motion changes', async () => {
    vi.useFakeTimers(); document.documentElement.dataset.motion = 'full';
    const {container} = render(<Harness/>);
    fireEvent.click(screen.getByRole('button', {name:'Open note'}));
    expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state','entering');
    act(() => vi.advanceTimersByTime(40));
    expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state','open');
    fireEvent.click(screen.getByRole('button', {name:'Done'}));
    expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state','exiting');
    expect(container).toHaveAttribute('inert');
    act(() => vi.advanceTimersByTime(180));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container).not.toHaveAttribute('inert');
    fireEvent.click(screen.getByRole('button', {name:'Open note'}));
    await act(async () => { document.documentElement.dataset.motion = 'reduced'; });
    fireEvent.click(screen.getByRole('button', {name:'Done'}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('preserves a background element that was already inert', async () => {
    const existing = document.createElement('div'); existing.setAttribute('inert',''); document.body.append(existing);
    const user = userEvent.setup(); render(<Harness/>);
    await user.click(screen.getByRole('button', {name:'Open note'}));
    await user.keyboard('{Escape}');
    expect(existing).toHaveAttribute('inert'); existing.remove();
  });
});
