import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RecordingDock } from './RecordingDock';
import type { RecordingDockProps } from './types';

const props = (overrides: Partial<RecordingDockProps> = {}): RecordingDockProps => ({
  elapsedMs: 8000, take: 2, audioLevel: 0.6, sourceName: 'Display 1', hasMicrophone: true, muted: false, onMuted: vi.fn(),
  compact: false, onToggleCompact: vi.fn(), stopDisabled: false, onStop: vi.fn(), ...overrides,
});

describe('RecordingDock', () => {
  it('shows the take timer, level, locked source and caption for take 2', () => {
    render(<RecordingDock {...props()} platform="windows"/>);
    const dock = screen.getByRole('group', { name: 'Recording controls' });
    const timer = within(dock).getByRole('timer', { name: 'Take 2 elapsed time' });
    expect(timer).toHaveTextContent('00:08');
    expect(timer).toHaveTextContent('Take 2');
    expect(within(dock).getByRole('meter', { name: 'Microphone level' })).toHaveAttribute('aria-valuenow', '60');
    expect(within(dock).getByRole('button', { name: 'Display 1' })).toBeDisabled();
    expect(screen.getByText('Adding to this session. Stop to process take 2 on this device.')).toBeVisible();
    expect(dock.querySelector('progress, [role=progressbar]')).toBeNull();
  });
  it('labels a first recording without a take number or caption', () => {
    render(<RecordingDock {...props({ take: 1, elapsedMs: 3723000 })}/>);
    const timer = screen.getByRole('timer', { name: 'Take 1 elapsed time' });
    expect(timer).toHaveTextContent('1:02:03');
    expect(timer).not.toHaveTextContent('Take');
    expect(screen.queryByText(/Adding to this session/)).not.toBeInTheDocument();
  });
  it('toggles mute and compact mode and stops with its shortcut in the tooltip', async () => {
    const user = userEvent.setup();
    const handlers = props();
    const { rerender } = render(<RecordingDock {...handlers} platform="windows"/>);
    const mute = screen.getByRole('button', { name: 'Mute microphone' });
    expect(mute).toHaveAttribute('aria-pressed', 'false');
    await user.click(mute);
    expect(handlers.onMuted).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole('button', { name: 'Compact' }));
    expect(handlers.onToggleCompact).toHaveBeenCalledTimes(1);
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop).toHaveAttribute('aria-keyshortcuts', 'Control+R');
    expect(stop.title).toBe('Stop recording (Ctrl+R)');
    await user.click(stop);
    expect(handlers.onStop).toHaveBeenCalledTimes(1);
    rerender(<RecordingDock {...handlers} muted compact stopDisabled/>);
    expect(screen.getByRole('button', { name: 'Mute microphone' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Mute microphone' }));
    expect(handlers.onMuted).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'Expand' })).toBeVisible();
    // Stop under way: still focusable and visible, but inert.
    const busyStop = screen.getByRole('button', { name: 'Stop' });
    expect(busyStop).toHaveAttribute('aria-disabled', 'true');
    expect(busyStop).toBeEnabled();
    busyStop.focus();
    await user.click(busyStop);
    expect(busyStop).toHaveFocus();
    expect(handlers.onStop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });
  it('keeps every control named when its label is only drawn as an icon', () => {
    render(<RecordingDock {...props({ sourceName: 'A very long window title that would not fit' })} platform="windows"/>);
    // Narrow slots hide these labels visually (workspace.css); the text stays in the accessible name.
    expect(screen.getByRole('button', { name: 'A very long window title that would not fit' }).querySelector('.cr-dock-label')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' }).querySelector('.cr-dock-label')).toHaveTextContent('Stop');
  });
  it('hides the meter and mute without a live microphone', () => {
    render(<RecordingDock {...props({ hasMicrophone: false, audioLevel: undefined })}/>);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mute microphone' })).not.toBeInTheDocument();
  });
});
