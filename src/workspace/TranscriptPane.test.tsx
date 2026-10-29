import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Transcript } from '../backend';
import { transcript as phraseTranscript, takeTwoLiveTranscript, takeTwoStartMs, twoTakeTranscript } from '../stories/fixtures';
import { LIVE_NOTE, TranscriptPane } from './TranscriptPane';
import type { TranscriptPaneProps } from './types';

const props = (overrides: Partial<TranscriptPaneProps> = {}): TranscriptPaneProps => ({
  mode: 'review', transcript: twoTakeTranscript, timeMs: 33200, onSeek: vi.fn(), ...overrides,
});
const liveTranscript: Transcript = {
  takes: [{ index: 1, startMs: 0 }],
  segments: [...twoTakeTranscript.segments.filter(segment => segment.startMs < takeTwoStartMs), ...takeTwoLiveTranscript.segments],
};
const scroller = () => document.querySelector<HTMLElement>('.cr-transcript-scroll')!;
const tabStops = () => [...document.querySelectorAll<HTMLElement>('[data-item][tabindex="0"]:not(:disabled)')];

afterEach(() => { delete document.documentElement.dataset.motion; });

describe('TranscriptPane in review', () => {
  it('is the Transcript region with sentence rows, no status chip and word-level seek', async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    render(<TranscriptPane {...props({ onSeek })}/>);
    const pane = screen.getByRole('region', { name: 'Transcript' });
    expect(within(pane).getByRole('heading', { level: 2, name: 'Transcript' })).toBeVisible();
    expect(within(pane).queryByRole('status')).not.toBeInTheDocument();
    const grid = screen.getByRole('button', { name: 'Seek to grid at 0:33' });
    expect(grid).toHaveClass('word', 'spoken');
    expect(grid).toHaveAttribute('aria-current', 'true');
    expect(grid.closest('.cr-row')).toHaveClass('is-current');
    await user.click(grid);
    await user.click(screen.getByRole('button', { name: 'Seek to 0:24' }));
    await user.click(screen.getByRole('button', { name: 'Now if I open the filters, the panel covers the first row of results.' }));
    expect(onSeek.mock.calls.map(call => call[0])).toEqual([33200, 24000, 24000]);
  });
  it('renders words as inline text buttons that wrap with the sentence, activated by click, Enter and Space', async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    const { rerender } = render(<TranscriptPane {...props({ onSeek })}/>);
    const grid = screen.getByRole('button', { name: 'Seek to grid at 0:33' });
    grid.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    rerender(<TranscriptPane {...props({ onSeek, transcript: phraseTranscript, timeMs: 0 })}/>);
    const phrase = screen.getByRole('button', { name: 'Seek to the details should update alongside it. at 0:08' });
    // A <button> is laid out as one unbreakable box; an inline span wraps like the text around it.
    expect(phrase.tagName).toBe('SPAN');
    expect(phrase).toHaveClass('word');
    await user.click(phrase);
    expect(onSeek.mock.calls.map(call => call[0])).toEqual([33200, 33200, 8000]);
  });
  it('divides takes with "Take N · m:ss" before the first row of each later take', () => {
    render(<TranscriptPane {...props()}/>);
    const divider = screen.getByText('Take 2 · 1:20');
    const next = divider.nextElementSibling;
    expect(next).toHaveTextContent('Picking this up again: the export dialog needs a progress state.');
    expect(screen.queryByText(/Take 1/)).not.toBeInTheDocument();
  });
  it('enters at the spoken word with one tab stop, then moves with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<><button>Before</button><TranscriptPane {...props()}/><button>After</button></>);
    expect(tabStops()).toEqual([screen.getByRole('button', { name: 'Seek to grid at 0:33' })]);
    screen.getByRole('button', { name: 'Before' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Find in transcript' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Seek to grid at 0:33' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Seek to down at 0:33' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('button', { name: 'Seek to the at 0:32' })).toHaveFocus();
    expect(tabStops()).toHaveLength(1);
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Seek to 0:38' })).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getByRole('button', { name: 'Seek to 0:24' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: 'And the finished toast could link straight to the file.' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('button', { name: 'Seek to 0:00' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Seek to grid at 0:33' })).toHaveFocus();
  });
  it('shows an inline error with Retry transcription instead of the empty message', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(<TranscriptPane {...props({ transcript: { segments: [] }, error: 'Speech model not found', emptyMessage: 'No speech was detected in this recording.', onRetry })}/>);
    expect(screen.getByText('Speech model not found')).toBeVisible();
    expect(screen.queryByText('No speech was detected in this recording.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry transcription' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<TranscriptPane {...props({ transcript: { segments: [] }, error: 'Speech model not found', onRetry, retryDisabled: true })}/>);
    expect(screen.getByRole('button', { name: 'Retry transcription' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Discard take/ })).not.toBeInTheDocument();
  });
  it('offers to discard a stuck take beside Retry, inert but focusable while another action runs', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onDiscardTake = vi.fn();
    const error = 'Take 2 is saved but has not been added to the recording yet. Retry to finish adding it.';
    const { rerender } = render(<TranscriptPane {...props({ error, onRetry, discardTake: 2, onDiscardTake })}/>);
    const discard = screen.getByRole('button', { name: 'Discard take 2' });
    expect(discard).toHaveAttribute('aria-haspopup', 'dialog');
    expect(discard.parentElement).toBe(screen.getByRole('button', { name: 'Retry transcription' }).parentElement);
    await user.click(discard);
    expect(onDiscardTake).toHaveBeenCalledTimes(1);
    rerender(<TranscriptPane {...props({ error, onRetry, discardTake: 2, onDiscardTake, retryBusy: true })}/>);
    expect(discard).toHaveAttribute('aria-disabled', 'true');
    discard.focus();
    expect(discard).toHaveFocus();
    await user.click(discard);
    await user.click(screen.getByRole('button', { name: 'Retry transcription' }));
    expect(onDiscardTake).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
  it('shows the empty message in the body and a Processing chip while processing', () => {
    render(<TranscriptPane {...props({ transcript: { segments: [] }, status: 'processing', emptyMessage: 'Transcribing…' })}/>);
    expect(screen.getByRole('status')).toHaveTextContent('Processing');
    expect(screen.getByText('Transcribing…')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Return to playback' })).not.toBeInTheDocument();
  });
});

describe('TranscriptPane while recording', () => {
  it('shows the Recording chip, the live divider and the provisional tail with inert words', () => {
    render(<TranscriptPane {...props({ mode: 'recording', transcript: liveTranscript, timeMs: 88000, status: 'recording', liveTake: { index: 2, startMs: takeTwoStartMs } })}/>);
    expect(screen.getByRole('status')).toHaveTextContent('Recording');
    const divider = screen.getByText('Take 2 · recording');
    const tail = divider.nextElementSibling!;
    expect(tail).toHaveClass('is-tail');
    expect(tail).toHaveTextContent('Picking this up again: the export dialog needs');
    expect(within(tail as HTMLElement).getByText(LIVE_NOTE)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Seek to 0:31' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Seek to grid at 0:33' })).toHaveAttribute('aria-disabled', 'true');
    expect(tabStops()).toHaveLength(0);
    // While recording the column shows the live tail only: no Find in transcript.
    expect(screen.queryByRole('button', { name: 'Find in transcript' })).not.toBeInTheDocument();
  });
  it('keeps a tail with its note before the take has words, and shows live problems', () => {
    const transcript = { ...liveTranscript, segments: liveTranscript.segments.slice(0, -1) };
    render(<TranscriptPane {...props({ mode: 'recording', transcript, timeMs: 81000, status: 'recording', liveTake: { index: 2, startMs: takeTwoStartMs }, emptyMessage: 'Listening… transcript updates in short batches.', liveError: 'Live transcription paused.' })}/>);
    expect(screen.getByText('Take 2 · recording')).toBeVisible();
    expect(screen.getByText('Listening… transcript updates in short batches.')).toBeVisible();
    expect(screen.getByText(LIVE_NOTE)).toBeVisible();
    expect(screen.getByText('Live transcription paused.')).toBeVisible();
  });
  it('ignores clicks and keys on live words', async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    render(<TranscriptPane {...props({ mode: 'recording', transcript: liveTranscript, timeMs: 88000, status: 'recording', liveTake: { index: 2, startMs: takeTwoStartMs }, onSeek })}/>);
    const grid = screen.getByRole('button', { name: 'Seek to grid at 0:33' });
    expect(grid).toHaveAttribute('tabindex', '-1');
    await user.click(grid);
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onSeek).not.toHaveBeenCalled();
  });
  it('closes Find in transcript when recording starts', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TranscriptPane {...props()}/>);
    await user.click(screen.getByRole('button', { name: 'Find in transcript' }));
    await user.type(screen.getByRole('searchbox', { name: 'Find in transcript' }), 'grid');
    rerender(<TranscriptPane {...props({ mode: 'recording', transcript: liveTranscript, timeMs: 88000, status: 'recording', liveTake: { index: 2, startMs: takeTwoStartMs } })}/>);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(document.querySelector('.found, .cr-find-mark')).toBeNull();
    rerender(<TranscriptPane {...props()}/>);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Find in transcript' })).toHaveAttribute('aria-expanded', 'false');
  });
  it('treats a first recording as one live take without a divider', () => {
    render(<TranscriptPane {...props({ mode: 'recording', transcript: takeTwoLiveTranscript, timeMs: 8000, status: 'recording' })}/>);
    expect(screen.queryByText(/Take \d/)).not.toBeInTheDocument();
    expect(screen.getByText(LIVE_NOTE)).toBeVisible();
  });
});

describe('Find in transcript', () => {
  it('finds, steps through matches and closes back to its button', async () => {
    const user = userEvent.setup();
    render(<TranscriptPane {...props()}/>);
    const button = screen.getByRole('button', { name: 'Find in transcript' });
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const field = screen.getByRole('searchbox', { name: 'Find in transcript' });
    expect(field).toHaveFocus();
    await user.type(field, 'preview');
    expect(screen.getByRole('status')).toHaveTextContent('1 of 2');
    expect(document.querySelectorAll('mark.cr-find-mark')).toHaveLength(2);
    expect(document.querySelector('.is-match-current')).toHaveTextContent('Hovering a card shows the preview');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('status')).toHaveTextContent('2 of 2');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(screen.getByRole('status')).toHaveTextContent('1 of 2');
    await user.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByRole('status')).toHaveTextContent('2 of 2');
    await user.clear(field);
    await user.type(field, 'grid');
    expect(screen.getByRole('button', { name: 'Seek to grid at 0:33' })).toHaveClass('found');
    await user.type(field, 'zz');
    expect(screen.getByRole('status')).toHaveTextContent('No matches');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });
});

describe('Following playback', () => {
  it('scrolls the playing row into view, stops when the reader scrolls away and returns on request', async () => {
    const user = userEvent.setup();
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    scroll.mockClear();
    render(<TranscriptPane {...props()}/>);
    expect(scroll).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'nearest' });
    expect(scroll.mock.contexts.at(-1)).toHaveClass('is-current');
    fireEvent.wheel(scroller());
    fireEvent.scroll(scroller());
    const back = screen.getByRole('button', { name: 'Return to playback' });
    scroll.mockClear();
    await user.click(back);
    expect(screen.queryByRole('button', { name: 'Return to playback' })).not.toBeInTheDocument();
    expect(scroll).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Seek to grid at 0:33' })).toHaveFocus());
  });
  it('resumes following after a seek from the transcript or a jump in time', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TranscriptPane {...props()}/>);
    fireEvent.wheel(scroller()); fireEvent.scroll(scroller());
    await user.click(screen.getByRole('button', { name: 'Seek to 0:05' }));
    expect(screen.queryByRole('button', { name: 'Return to playback' })).not.toBeInTheDocument();
    fireEvent.wheel(scroller()); fireEvent.scroll(scroller());
    expect(screen.getByRole('button', { name: 'Return to playback' })).toBeVisible();
    rerender(<TranscriptPane {...props({ timeMs: 33400 })}/>);
    expect(screen.getByRole('button', { name: 'Return to playback' })).toBeVisible();
    rerender(<TranscriptPane {...props({ timeMs: 90000 })}/>);
    expect(screen.queryByRole('button', { name: 'Return to playback' })).not.toBeInTheDocument();
  });
  it('offers no return before the playhead reaches the first sentence', () => {
    const late: Transcript = { ...twoTakeTranscript, segments: twoTakeTranscript.segments.slice(1) };
    render(<TranscriptPane {...props({ transcript: late, timeMs: 1000 })}/>);
    fireEvent.wheel(scroller()); fireEvent.scroll(scroller());
    expect(screen.queryByRole('button', { name: 'Return to playback' })).not.toBeInTheDocument();
  });
  it('returns to the sentence the playhead last passed while it sits in a pause', async () => {
    const user = userEvent.setup();
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    render(<TranscriptPane {...props({ timeMs: 18000 })}/>);
    fireEvent.wheel(scroller()); fireEvent.scroll(scroller());
    scroll.mockClear();
    await user.click(screen.getByRole('button', { name: 'Return to playback' }));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toHaveTextContent('The import action could be closer to the search field.');
  });
  it('resumes following when the reader scrolls the playing row back into view', () => {
    render(<TranscriptPane {...props()}/>);
    fireEvent.wheel(scroller()); fireEvent.scroll(scroller());
    expect(screen.getByRole('button', { name: 'Return to playback' })).toBeVisible();
    const view = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 400 }));
    fireEvent.wheel(scroller()); fireEvent.scroll(scroller());
    view.mockRestore();
    expect(screen.queryByRole('button', { name: 'Return to playback' })).not.toBeInTheDocument();
  });
  it('offers Back to live while recording and scrolls to the newest words', async () => {
    const user = userEvent.setup();
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    render(<TranscriptPane {...props({ mode: 'recording', transcript: liveTranscript, timeMs: 88000, status: 'recording', liveTake: { index: 2, startMs: takeTwoStartMs } })}/>);
    fireEvent.wheel(scroller()); fireEvent.scroll(scroller());
    expect(screen.queryByRole('button', { name: 'Return to playback' })).not.toBeInTheDocument();
    scroll.mockClear();
    await user.click(screen.getByRole('button', { name: 'Back to live' }));
    expect(screen.queryByRole('button', { name: 'Back to live' })).not.toBeInTheDocument();
    expect(scroll.mock.contexts.at(-1)).toHaveAttribute('data-follow-end');
  });
  it('ignores its own automatic scrolls', () => {
    render(<TranscriptPane {...props()}/>);
    fireEvent.scroll(scroller());
    expect(screen.queryByRole('button', { name: 'Return to playback' })).not.toBeInTheDocument();
  });
  it('does not request smooth scrolling with reduced motion', () => {
    document.documentElement.dataset.motion = 'reduced';
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    scroll.mockClear();
    render(<TranscriptPane {...props()}/>);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'nearest' });
    expect(scroll).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
  });
});
