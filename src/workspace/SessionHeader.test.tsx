import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { deviceVideoMissingMs, formatMissing, SessionHeader } from './SessionHeader';
import type { SessionHeaderProps } from './types';

const props = (overrides: Partial<SessionHeaderProps> = {}): SessionHeaderProps => ({
  title: 'Library selection and details', draft: false, renameDisabled: false, onRename: vi.fn(),
  onOpenFolder: vi.fn(), copyDisabled: false, onCopyForAgent: vi.fn(), ...overrides,
});

describe('SessionHeader', () => {
  it('renames from the title, opens the folder and copies for the agent', async () => {
    const user = userEvent.setup();
    const handlers = props();
    render(<SessionHeader {...handlers}/>);
    const heading = screen.getByRole('heading', { level: 1, name: 'Library selection and details' });
    const rename = within(heading).getByRole('button', { name: 'Library selection and details' });
    expect(rename).toHaveAttribute('title', 'Rename recording');
    await user.click(rename);
    await user.click(screen.getByRole('button', { name: 'Open recording folder' }));
    await user.click(screen.getByRole('button', { name: 'Copy for agent' }));
    expect(handlers.onRename).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenFolder).toHaveBeenCalledTimes(1);
    expect(handlers.onCopyForAgent).toHaveBeenCalledTimes(1);
  });
  it('disables Copy for agent and renaming while recording', () => {
    render(<SessionHeader {...props({ copyDisabled: true, renameDisabled: true })}/>);
    expect(screen.getByRole('button', { name: 'Copy for agent' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Library selection and details' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open recording folder' })).toBeEnabled();
  });
  it('notes the device video a take is missing', () => {
    // A Quest was gone for 12 s in take 1 and 0.4 s in take 2: the session notes the total, under the title.
    const missing = deviceVideoMissingMs([{ startMs: 30000, endMs: 41600 }, { startMs: 95000, endMs: 95400 }]);
    expect(missing).toBe(12000);
    const { rerender } = render(<SessionHeader {...props({ deviceVideoMissingMs: missing })}/>);
    const note = screen.getByText('12 s of device video missing');
    expect(note.closest('header')).toBe(screen.getByRole('banner'));
    expect(screen.getByRole('heading', { level: 1, name: 'Library selection and details' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1 })).not.toContainElement(note);
    expect(note.title).toMatch(/black/);
    rerender(<SessionHeader {...props({ deviceVideoMissingMs: 183000 })}/>);
    expect(screen.getByText('3 min 3 s of device video missing')).toBeVisible();
    // No gaps, or a draft: no note.
    rerender(<SessionHeader {...props({ deviceVideoMissingMs: deviceVideoMissingMs(undefined) })}/>);
    expect(screen.queryByText(/of device video missing/)).not.toBeInTheDocument();
    rerender(<SessionHeader {...props({ title: 'New recording', draft: true, deviceVideoMissingMs: 12000 })}/>);
    expect(screen.queryByText(/of device video missing/)).not.toBeInTheDocument();
    expect([400, 59600, 60000, 3723000].map(formatMissing)).toEqual(['1 s', '1 min', '1 min', '1 h 2 min 3 s']);
  });
  it('shows a plain title and no actions for a draft', () => {
    render(<SessionHeader {...props({ title: 'New recording', draft: true })}/>);
    expect(screen.getByRole('heading', { level: 1, name: 'New recording' })).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
