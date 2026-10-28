import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SessionHeader } from './SessionHeader';
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
  it('shows a plain title and no actions for a draft', () => {
    render(<SessionHeader {...props({ title: 'New recording', draft: true })}/>);
    expect(screen.getByRole('heading', { level: 1, name: 'New recording' })).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
