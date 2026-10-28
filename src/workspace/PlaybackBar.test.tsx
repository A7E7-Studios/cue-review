import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PlaybackBar } from './PlaybackBar';
import { Scrubber } from './Scrubber.tsx';
import type { PlaybackBarProps } from './types';

const props = (overrides: Partial<PlaybackBarProps> = {}): PlaybackBarProps => ({
  timeMs: 33400, durationMs: 134000, segments: [{ startMs: 31000, endMs: 36500 }], takes: [{ index: 1, startMs: 0 }, { index: 2, startMs: 80000 }],
  onSeek: vi.fn(), playing: false, canPlay: true, onTogglePlay: vi.fn(), speed: 1, onCycleSpeed: vi.fn(),
  focused: false, onToggleFocus: vi.fn(), recordMoreDisabled: false, onRecordMore: vi.fn(), ...overrides,
});

describe('PlaybackBar', () => {
  it('names its controls and reports them through callbacks', async () => {
    const user = userEvent.setup();
    const handlers = props();
    render(<PlaybackBar {...handlers} platform="windows"/>);
    const group = screen.getByRole('group', { name: 'Playback' });
    await user.click(within(group).getByRole('button', { name: 'Play' }));
    await user.click(within(group).getByRole('button', { name: 'Playback speed 1×' }));
    await user.click(within(group).getByRole('button', { name: 'Focus video' }));
    const more = within(group).getByRole('button', { name: 'Record more' });
    expect(more).toHaveAttribute('aria-keyshortcuts', 'Control+R');
    expect(more.title).toContain('Ctrl+R');
    await user.click(more);
    expect(handlers.onTogglePlay).toHaveBeenCalledTimes(1);
    expect(handlers.onCycleSpeed).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleFocus).toHaveBeenCalledTimes(1);
    expect(handlers.onRecordMore).toHaveBeenCalledTimes(1);
    expect(group).toHaveTextContent('0:33 / 2:14');
  });
  it('switches names for playing, focus mode and speed, and uses ⌘ on macOS', () => {
    render(<PlaybackBar {...props({ playing: true, focused: true, speed: 1.5, recordMoreDisabled: true, canPlay: false })} platform="macos"/>);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restore transcript' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Playback speed 1.5×' })).toHaveTextContent('1.5×');
    const more = screen.getByRole('button', { name: 'Record more' });
    expect(more).toBeDisabled();
    expect(more).toHaveAttribute('aria-keyshortcuts', 'Meta+R');
    expect(more.title).toContain('⌘R');
  });
});

describe('Scrubber', () => {
  it('is a named native range with a spoken value that keeps fine positions', () => {
    render(<Scrubber timeMs={2500} durationMs={10000} segments={[]} takes={[{ index: 2, startMs: 6000 }]} onSeek={vi.fn()}/>);
    const slider = screen.getByRole('slider', { name: 'Playback position' });
    expect(slider).toHaveValue('2500');
    expect(slider).toHaveAttribute('aria-valuetext', '0:02 of 0:10, take 2 starts at 0:06');
  });
  it('seeks with the keyboard: arrows, Shift+arrows, Page keys, Home and End', async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    render(<Scrubber timeMs={33000} durationMs={134000} segments={[]} onSeek={onSeek}/>);
    screen.getByRole('slider', { name: 'Playback position' }).focus();
    await user.keyboard('{ArrowRight}{ArrowLeft}{Shift>}{ArrowRight}{/Shift}{PageUp}{Home}{End}');
    expect(onSeek.mock.calls.map(call => call[0])).toEqual([38000, 28000, 34000, 46400, 0, 134000]);
  });
  it('seeks and drags with the pointer on the drawn track and focuses the range', () => {
    const onSeek = vi.fn();
    const { container } = render(<Scrubber timeMs={0} durationMs={100000} segments={[{ startMs: 0, endMs: 50000 }]} onSeek={onSeek}/>);
    const root = container.querySelector<HTMLElement>('.cr-scrubber')!;
    const track = container.querySelector<HTMLElement>('.cr-scrubber-track')!;
    track.getBoundingClientRect = () => ({ left: 100, width: 400, top: 0, right: 500, bottom: 8, height: 8, x: 100, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(root, { button: 0, pointerId: 1, clientX: 200 });
    fireEvent.pointerMove(root, { pointerId: 1, clientX: 400 });
    fireEvent.pointerUp(root, { pointerId: 1, clientX: 400 });
    fireEvent.pointerMove(root, { pointerId: 1, clientX: 500 });
    expect(onSeek.mock.calls.map(call => call[0])).toEqual([25000, 75000]);
    expect(screen.getByRole('slider', { name: 'Playback position' })).toHaveFocus();
    expect(container.querySelectorAll('.cr-scrubber-speech')).toHaveLength(1);
  });
  it('draws played speech in the accent and a tick for take 2 only', () => {
    const { container } = render(<Scrubber timeMs={33400} durationMs={134000} segments={[{ startMs: 0, endMs: 4000 }, { startMs: 31000, endMs: 36500 }, { startMs: 81000, endMs: 86000 }]}
      takes={[{ index: 1, startMs: 0 }, { index: 2, startMs: 80000 }]} onSeek={vi.fn()}/>);
    expect([...container.querySelectorAll('.cr-scrubber-speech')].map(run => run.hasAttribute('data-played'))).toEqual([true, true, false, false]);
    expect(container.querySelectorAll('.cr-scrubber-tick')).toHaveLength(1);
  });
  it('ignores input without a duration', () => {
    const onSeek = vi.fn();
    const { container } = render(<Scrubber timeMs={0} durationMs={0} segments={[]} onSeek={onSeek}/>);
    fireEvent.pointerDown(container.querySelector('.cr-scrubber')!, { button: 0, pointerId: 1, clientX: 10 });
    expect(screen.getByRole('slider', { name: 'Playback position' })).toBeDisabled();
    expect(onSeek).not.toHaveBeenCalled();
  });
});
