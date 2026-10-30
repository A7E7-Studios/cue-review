import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RecordingDock, litBars, shortMicrophoneName } from './RecordingDock';
import type { RecordingDockProps } from './types';

const props = (overrides: Partial<RecordingDockProps> = {}): RecordingDockProps => ({
  elapsedMs: 8000, take: 2, audioLevel: 0.6, sourceName: 'Display 1', hasMicrophone: true, muted: false, onMuted: vi.fn(),
  compact: false, onToggleCompact: vi.fn(), stopDisabled: false, onStop: vi.fn(), ...overrides,
});

describe('RecordingDock', () => {
  it('shows the take timer, level and locked source for take 2, with no take label or caption', () => {
    render(<RecordingDock {...props()} platform="windows"/>);
    const dock = screen.getByRole('group', { name: 'Recording controls' });
    const timer = within(dock).getByRole('timer', { name: 'Take 2 elapsed time' });
    expect(timer).toHaveTextContent('00:08');
    expect(timer).toHaveTextContent(/^00:08$/);
    expect(within(dock).getByRole('meter', { name: 'Microphone level' })).toHaveAttribute('aria-valuenow', '-4');
    expect(within(dock).getByRole('button', { name: 'Display 1' })).toBeDisabled();
    expect(screen.queryByText(/Take 2|Adding to this session/)).not.toBeInTheDocument();
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
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', 'Muted');
  });
  it('keeps every control named when its label is only drawn as an icon', () => {
    render(<RecordingDock {...props({ sourceName: 'A very long window title that would not fit' })} platform="windows"/>);
    // Narrow slots hide these labels visually (workspace.css); the text stays in the accessible name.
    expect(screen.getByRole('button', { name: 'A very long window title that would not fit' }).querySelector('.cr-dock-label')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' }).querySelector('.cr-dock-label')).toHaveTextContent('Stop');
  });
  it('lights one bar per 6 dB above −60 dBFS', () => {
    const at = (db: number) => 10 ** (db / 20);
    expect([at(-61), at(-59), at(-38), at(-12.5), at(-11.9), at(-5.9), 1, 0].map(litBars)).toEqual([0, 1, 4, 8, 9, 10, 10, 0]);
    const { rerender } = render(<RecordingDock {...props({ audioLevel: at(-38) })}/>);
    const meter = screen.getByRole('meter', { name: 'Microphone level' });
    expect(meter).toHaveAttribute('aria-valuenow', '-38');
    const bars = [...meter.querySelectorAll('span')].map(bar => bar.dataset.level);
    expect(bars).toEqual(['low', 'low', 'low', 'low', 'off', 'off', 'off', 'off', 'off', 'off']);
    rerender(<RecordingDock {...props({ audioLevel: 1 })}/>);
    expect([...meter.querySelectorAll('span')].map(bar => bar.dataset.level).slice(7)).toEqual(['low', 'high', 'high']);
  });
  it('names the microphone on its chip', () => {
    render(<RecordingDock {...props({ microphoneName: 'Default — Microphone (HD Pro Webcam C920)' })}/>);
    const mute = screen.getByRole('button', { name: 'Mute microphone' });
    expect(mute).toHaveAccessibleDescription('HD Pro Webcam C920');
    expect(mute.closest('.cr-mic-chip')).toHaveTextContent(/^HD Pro Webcam C920$/);
    expect(mute.title).toBe('Mute Default — Microphone (HD Pro Webcam C920)');
    expect(shortMicrophoneName('Headset Microphone (Oculus Virtual Audio Device)')).toBe('Headset Microphone (Oculus Virtual Audio Device)');
    expect(shortMicrophoneName('Mikrofon (HD Pro Webcam C920)')).toBe('HD Pro Webcam C920');
  });
  it('keeps the chip and a flat meter while muted, and says Muted', () => {
    render(<RecordingDock {...props({ microphoneName: 'Microphone (HD Pro Webcam C920)', muted: true })}/>);
    const mute = screen.getByRole('button', { name: 'Mute microphone' });
    expect(mute).toHaveAttribute('aria-pressed', 'true');
    expect(mute).toHaveAccessibleDescription('Muted');
    expect(mute.closest('.cr-mic-chip')).toHaveTextContent(/^Muted$/);
    expect(mute.title).toBe('Unmute Microphone (HD Pro Webcam C920)');
    const meter = screen.getByRole('meter', { name: 'Microphone level' });
    expect(meter).toHaveAttribute('aria-valuetext', 'Muted');
    expect([...meter.querySelectorAll('span')].every(bar => bar.dataset.level === 'off')).toBe(true);
    // The chip is the same element, muted or not: workspace.css gives it one width.
    expect(mute.closest('.cr-mic-chip')).toHaveAttribute('data-muted', 'true');
  });
  it('hides the meter and mute without a live microphone', () => {
    render(<RecordingDock {...props({ hasMicrophone: false, audioLevel: undefined })}/>);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mute microphone' })).not.toBeInTheDocument();
  });
});
