import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PlaybackBar } from './PlaybackBar';
import { Scrubber } from './Scrubber.tsx';
import type { PlaybackBarProps } from './types';

const props = (overrides: Partial<PlaybackBarProps> = {}): PlaybackBarProps => ({
  timeMs: 33400, durationMs: 134000, segments: [{ startMs: 31000, endMs: 36500 }], takes: [{ index: 1, startMs: 0 }, { index: 2, startMs: 80000 }],
  onSeek: vi.fn(), playing: false, canPlay: true, onTogglePlay: vi.fn(), speed: 1, onSpeed: vi.fn(),
  focused: false, onToggleFocus: vi.fn(), recordMoreDisabled: false, onRecordMore: vi.fn(), ...overrides,
});

describe('PlaybackBar', () => {
  it('chooses a speed from the speed list', async () => {
    const user = userEvent.setup();
    const handlers = props();
    render(<PlaybackBar {...handlers} platform="windows"/>);
    const button = screen.getByRole('button', { name: 'Playback speed 1×' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await user.click(button);
    const list = screen.getByRole('menu', { name: 'Playback speed' });
    const items = within(list).getAllByRole('menuitemradio');
    expect(items.map(item => item.textContent)).toEqual(['0.5×', '0.75×', '1×Normal', '1.25×', '1.5×', '1.75×', '2×']);
    expect(within(list).getByRole('menuitemradio', { name: '1× Normal' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(list).getByRole('menuitemradio', { name: '1.5×' }));
    expect(handlers.onSpeed).toHaveBeenCalledWith(1.5);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });
  it('chooses a speed with the keyboard', async () => {
    const user = userEvent.setup();
    const handlers = props({ speed: 1.25 });
    render(<PlaybackBar {...handlers} platform="windows"/>);
    screen.getByRole('button', { name: 'Playback speed 1.25×' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menuitemradio', { name: '1.25×' })).toHaveFocus();
    expect(screen.getByRole('menuitemradio', { name: '1.25×' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');
    expect(screen.getByRole('menuitemradio', { name: '1.5×' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(handlers.onSpeed).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Playback speed 1.25×' })).toHaveFocus();
    await user.keyboard('{Enter}{End}{Enter}');
    expect(handlers.onSpeed).toHaveBeenCalledWith(2);
    expect(screen.getByRole('button', { name: 'Playback speed 1.25×' })).toHaveFocus();
    await user.keyboard('{ArrowDown}{Home} ');
    expect(handlers.onSpeed).toHaveBeenLastCalledWith(0.5);
  });
  it('shows Focus video pressed with the same icon', () => {
    const { rerender, container } = render(<PlaybackBar {...props()} platform="windows"/>);
    const icon = () => container.querySelector('.cr-focus svg path')?.getAttribute('d');
    const before = icon();
    expect(screen.getByRole('button', { name: 'Focus video' })).toHaveAttribute('aria-pressed', 'false');
    rerender(<PlaybackBar {...props({ focused: true })} platform="windows"/>);
    expect(screen.getByRole('button', { name: 'Focus video' })).toHaveAttribute('aria-pressed', 'true');
    expect(icon()).toBe(before);
  });
  it('names its controls and reports them through callbacks', async () => {
    const user = userEvent.setup();
    const handlers = props();
    render(<PlaybackBar {...handlers} platform="windows"/>);
    const group = screen.getByRole('group', { name: 'Playback' });
    await user.click(within(group).getByRole('button', { name: 'Play' }));
    await user.click(within(group).getByRole('button', { name: 'Focus video' }));
    const more = within(group).getByRole('button', { name: 'Record more' });
    expect(more).toHaveAttribute('aria-keyshortcuts', 'Control+R');
    expect(more.title).toContain('Ctrl+R');
    await user.click(more);
    expect(handlers.onTogglePlay).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleFocus).toHaveBeenCalledTimes(1);
    expect(handlers.onRecordMore).toHaveBeenCalledTimes(1);
    expect(group).toHaveTextContent('0:33 / 2:14');
  });
  it('switches names for playing, focus mode and speed, and uses ⌘ on macOS', () => {
    render(<PlaybackBar {...props({ playing: true, focused: true, speed: 1.5, recordMoreDisabled: true, canPlay: false })} platform="macos"/>);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Focus video' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Playback speed 1.5×' })).toHaveTextContent('1.5×');
    const more = screen.getByRole('button', { name: 'Record more' });
    expect(more).toBeDisabled();
    expect(more).toHaveAttribute('aria-keyshortcuts', 'Meta+R');
    expect(more.title).toContain('⌘R');
  });
  it('shows why Record more failed beside the pill, with New recording and Dismiss', async () => {
    const user = userEvent.setup();
    const handlers = props({ recordMoreError: 'The original window/display for this recording is no longer available.', onNewRecording: vi.fn(), onDismissRecordMoreError: vi.fn() });
    const { rerender } = render(<PlaybackBar {...handlers} platform="windows"/>);
    const alert = within(screen.getByRole('group', { name: 'Playback' })).getByRole('alert');
    expect(alert).toHaveTextContent('no longer available');
    expect(screen.getByRole('button', { name: 'Record more' })).toHaveAccessibleDescription('The original window/display for this recording is no longer available.');
    await user.click(within(alert).getByRole('button', { name: 'New recording' }));
    await user.click(within(alert).getByRole('button', { name: 'Dismiss error' }));
    expect(handlers.onNewRecording).toHaveBeenCalledTimes(1);
    expect(handlers.onDismissRecordMoreError).toHaveBeenCalledTimes(1);
    // Busy for a moment: New recording stays focusable but does nothing.
    rerender(<PlaybackBar {...handlers} recordMoreBusy platform="windows"/>);
    const start = within(alert).getByRole('button', { name: 'New recording' });
    expect(start).toHaveAttribute('aria-disabled', 'true');
    await user.click(start);
    expect(handlers.onNewRecording).toHaveBeenCalledTimes(1);
    rerender(<PlaybackBar {...handlers} recordMoreError={undefined} platform="windows"/>);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
