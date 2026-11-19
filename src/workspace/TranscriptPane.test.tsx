import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Transcript } from '../backend';
import { germanChosenTranscript, germanRecordingTranscript, germanTwoTakeTranscript, oneThenTwoTracksSpokenMs, oneThenTwoTracksTranscript, transcript as phraseTranscript, SPEECH_LANGUAGES, takeTwoLiveTranscript, takeTwoStartMs, twoLanguageTranscript,
  twoTakeTranscript, twoTrackRecordingTranscript, twoTrackSpokenMs, twoTrackTranscript } from '../stories/fixtures';
import { LIVE_NOTE, TranscriptPane } from './TranscriptPane';
import type { TranscriptPaneProps } from './types';

const props = (overrides: Partial<TranscriptPaneProps> = {}): TranscriptPaneProps => ({
  mode: 'review', transcript: twoTakeTranscript, timeMs: 33200, onSeek: vi.fn(), ...overrides,
});
const liveTranscript: Transcript = {
  takes: [{ index: 1, startMs: 0 }],
  segments: [...twoTakeTranscript.segments.filter(segment => segment.startMs < takeTwoStartMs), ...takeTwoLiveTranscript.segments],
};
/** The rows of `transcript` in the fixtures as the pane drew them before rows had tracks. */
const ONE_TRACK_MARKUP = [
  '<div class="cr-row is-current" data-row="0"><button type="button" class="cr-row-time" data-item="0:t" tabindex="0" aria-label="Seek to 0:00">0:00</button><div class="cr-row-body"><p class="cr-row-text"><button type="button" class="segment-text" data-item="0:s" tabindex="-1">The library feels clear and easy to navigate.</button></p></div></div>',
  '<div class="cr-row" data-row="1"><button type="button" class="cr-row-time" data-item="1:t" tabindex="-1" aria-label="Seek to 0:05">0:05</button><div class="cr-row-body"><p class="cr-row-text"><span role="button" class="word" data-item="1:0" tabindex="-1" aria-label="Seek to When I select at 0:05">When I select</span> <span role="button" class="word" data-item="1:1" tabindex="-1" aria-label="Seek to this model, at 0:06">this model,</span> <span role="button" class="word" data-item="1:2" tabindex="-1" aria-label="Seek to the details should update alongside it. at 0:08">the details should update alongside it.</span></p></div></div>',
  '<div class="cr-row" data-row="2"><button type="button" class="cr-row-time" data-item="2:t" tabindex="-1" aria-label="Seek to 0:12">0:12</button><div class="cr-row-body"><p class="cr-row-text"><button type="button" class="segment-text" data-item="2:s" tabindex="-1">The import action could be closer to the search field.</button></p></div></div>',
  '<div class="cr-row" data-row="3"><button type="button" class="cr-row-time" data-item="3:t" tabindex="-1" aria-label="Seek to 0:19">0:19</button><div class="cr-row-body"><p class="cr-row-text"><button type="button" class="segment-text" data-item="3:s" tabindex="-1">Everything else is working as expected.</button></p></div></div>',
  '<div class="cr-transcript-end" data-follow-end="true" aria-hidden="true"></div>',
].join('');
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
    const divider = screen.getByText('Take 2 · recording · detecting language');
    const tail = divider.nextElementSibling!.nextElementSibling!;
    expect(tail).toHaveClass('is-tail');
    expect(tail).toHaveTextContent('Right now it always opens in Documents, and');
    expect(within(tail as HTMLElement).getByText(LIVE_NOTE)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Seek to 0:31' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Seek to grid at 0:33' })).toHaveAttribute('aria-disabled', 'true');
    expect(tabStops()).toHaveLength(0);
    // While recording the column shows the live tail only: no Find in transcript.
    expect(screen.queryByRole('button', { name: 'Find in transcript' })).not.toBeInTheDocument();
  });
  it('shows finished stretches as rows and greys only the words still being heard', () => {
    const recording = (transcript: Transcript) => props({ mode: 'recording', transcript, timeMs: 88000, status: 'recording', liveTake: { index: 2, startMs: takeTwoStartMs } });
    const { rerender } = render(<TranscriptPane {...recording(liveTranscript)}/>);
    const stretch = screen.getByText('Picking this up again: the export dialog needs a default folder.').closest<HTMLElement>('.cr-row')!;
    expect(stretch).not.toHaveClass('is-tail');
    expect(within(stretch).getByRole('button', { name: 'Seek to 1:21' })).toBeDisabled();
    expect(stretch.querySelector('.cr-live-caret, .cr-live-note')).toBeNull();
    const tails = document.querySelectorAll<HTMLElement>('.cr-row.is-tail');
    expect(tails).toHaveLength(1);
    const [tail] = tails;
    expect(stretch.nextElementSibling).toBe(tail);
    expect(within(tail).getByRole('button', { name: 'Seek to 1:27' })).toBeDisabled();
    expect(tail.querySelector('.cr-row-text')).toHaveTextContent('Right now it always opens in Documents, and');
    expect(tail.querySelector('.cr-row-text .cr-live-caret')).not.toBeNull();
    expect(within(tail).getByText('Grey words are still being heard and may change.')).toBeVisible();
    // Nothing is being heard: the finished stretch stays a row and no live box shows.
    rerender(<TranscriptPane {...recording({ ...liveTranscript, segments: liveTranscript.segments.slice(0, -1) })}/>);
    expect(screen.getByText('Picking this up again: the export dialog needs a default folder.')).toBeVisible();
    expect(document.querySelector('.cr-row.is-tail, .cr-live-caret')).toBeNull();
    expect(screen.queryByText(LIVE_NOTE)).not.toBeInTheDocument();
  });
  it('keeps a tail with its note before the take has words, and shows live problems', () => {
    const transcript = { ...liveTranscript, segments: liveTranscript.segments.filter(segment => segment.startMs < takeTwoStartMs) };
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
    await waitFor(() => expect(screen.queryByRole('searchbox')).not.toBeInTheDocument());
    expect(document.querySelector('.found, .cr-find-mark')).toBeNull();
    rerender(<TranscriptPane {...props()}/>);
    await waitFor(() => expect(screen.queryByRole('searchbox')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Find in transcript' })).toHaveAttribute('aria-expanded', 'false');
  });
  it('treats a first recording as one live take, divided only once it has words or a language', () => {
    const first = (transcript: Transcript) => props({ mode: 'recording', transcript, timeMs: 8000, status: 'recording', languages: SPEECH_LANGUAGES });
    const { rerender } = render(<TranscriptPane {...first({ segments: [] })}/>);
    expect(screen.queryByText(/Take \d/)).not.toBeInTheDocument();
    rerender(<TranscriptPane {...first(takeTwoLiveTranscript)}/>);
    expect(screen.getByText('Take 1 · recording · detecting language')).toBeVisible();
    expect(screen.getByText(LIVE_NOTE)).toBeVisible();
    // A language chosen in Settings is known from the start.
    rerender(<TranscriptPane {...first({ segments: [], language: 'de' })}/>);
    expect(screen.getByText('Take 1 · recording · German')).toBeVisible();
  });
  it("names each take's language and whether it was detected", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TranscriptPane {...props({ transcript: germanTwoTakeTranscript, languages: SPEECH_LANGUAGES })}/>);
    // Detected by Auto: each take opens with its divider, take 1 included.
    const first = screen.getByText('Take 1 · 0:00 · German, detected');
    expect(first.nextElementSibling).toHaveTextContent('Die Bibliothek wirkt klar und leicht zu bedienen.');
    const second = screen.getByText('Take 2 · 1:20 · English, detected');
    expect(second.nextElementSibling).toHaveTextContent('Picking this up again: the export dialog needs a progress state.');
    // The divider is no stop of the roving tab order: Down goes from take 1's last row to take 2's first.
    expect(first).not.toHaveAttribute('tabindex');
    expect(first.querySelector('[data-item]')).toBeNull();
    screen.getByRole('button', { name: 'Seek to 1:10' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Seek to 1:21' })).toHaveFocus();

    // Chosen in Settings: the language alone, on a session of one take too.
    rerender(<TranscriptPane {...props({ transcript: germanChosenTranscript, languages: SPEECH_LANGUAGES })}/>);
    expect(screen.getByText('Take 1 · 0:00 · German')).toBeVisible();
    expect(screen.getAllByText(/^Take \d/)).toHaveLength(1);
    // A code the list does not name shows the code; a transcript without a language has no divider, as before.
    rerender(<TranscriptPane {...props({ transcript: { ...phraseTranscript, language: 'xx', languageDetected: true }, languages: SPEECH_LANGUAGES })}/>);
    expect(screen.getByText('Take 1 · 0:00 · xx, detected')).toBeVisible();
    rerender(<TranscriptPane {...props({ transcript: phraseTranscript, languages: SPEECH_LANGUAGES })}/>);
    expect(screen.queryByText(/Take \d/)).not.toBeInTheDocument();
    // Takes without a language keep the plain "Take N · m:ss" divider.
    rerender(<TranscriptPane {...props({ languages: SPEECH_LANGUAGES })}/>);
    expect(screen.getByText('Take 2 · 1:20')).toBeVisible();
    expect(screen.queryByText(/Take 1/)).not.toBeInTheDocument();

    // While take 2 records it is detecting until its language arrives, then names it in place.
    const recording = (transcript: Transcript, language?: string) => props({ mode: 'recording', transcript, timeMs: 88000, status: 'recording', languages: SPEECH_LANGUAGES,
      liveTake: { index: 2, startMs: takeTwoStartMs, language } });
    rerender(<TranscriptPane {...recording(germanRecordingTranscript)}/>);
    expect(screen.getByText('Take 1 · 0:00 · German, detected')).toBeVisible();
    expect(screen.getByText('Take 2 · recording · detecting language')).toBeVisible();
    rerender(<TranscriptPane {...recording({ ...germanRecordingTranscript, language: 'en', languageDetected: true })}/>);
    expect(screen.getByText('Take 2 · recording · English, detected')).toBeVisible();
    expect(screen.queryByText(/detecting language/)).not.toBeInTheDocument();
    rerender(<TranscriptPane {...recording(germanRecordingTranscript, 'en')}/>);
    expect(screen.getByText('Take 2 · recording · English')).toBeVisible();
  });
});

describe('TranscriptPane with two tracks', () => {
  const rowOf = (name: string) => screen.getByRole('button', { name }).closest<HTMLElement>('.cr-row')!;
  const tag = (row: HTMLElement) => row.querySelector('.cr-track-tag');
  it('marks each row of a two-track take with its track', async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    render(<TranscriptPane {...props({ transcript: twoTrackTranscript, timeMs: twoTrackSpokenMs, onSeek, languages: SPEECH_LANGUAGES })}/>);
    const rows = [...document.querySelectorAll<HTMLElement>('.cr-row')];
    // Every row carries its segment's track: the call's on the left, the reviewer's set in with the time after the words.
    expect(rows.map(row => row.dataset.track)).toEqual(twoTrackTranscript.segments.map(segment => segment.track));
    expect(rows.filter(row => row.dataset.track === 'microphone')).toHaveLength(5);
    // No other mark at rest: no tag, no track name in the text.
    expect(document.querySelector('.cr-track-tag')).toBeNull();
    expect(screen.queryByText(/Microphone|Computer audio/)).not.toBeInTheDocument();
    // The current row, the spoken word, past rows and word seek work on both sides.
    const grid = screen.getByRole('button', { name: 'Seek to grid at 0:22' });
    expect(grid).toHaveClass('spoken');
    expect(rowOf('Seek to 0:21, microphone')).toHaveClass('is-current');
    expect(rowOf('Seek to 0:16, microphone')).toHaveClass('is-past');
    expect(rowOf('Seek to 0:11, computer audio')).toHaveClass('is-past');
    expect(rowOf('Seek to 0:27, computer audio')).not.toHaveClass('is-past');
    await user.click(screen.getByRole('button', { name: 'Seek to 0:38, microphone' }));
    await user.click(screen.getByRole('button', { name: 'Seek to Okay, at 0:00' }));
    expect(onSeek.mock.calls.map(call => call[0])).toEqual([38000, 0]);
    // Find in transcript finds on both sides.
    await user.click(screen.getByRole('button', { name: 'Find in transcript' }));
    await user.type(screen.getByRole('searchbox', { name: 'Find in transcript' }), 'grid');
    expect(screen.getByRole('status')).toHaveTextContent('1 of 4');
    expect([...document.querySelectorAll<HTMLElement>('.cr-row.is-match')].map(row => row.dataset.track)).toEqual(['system', 'microphone', 'microphone', 'microphone']);
  });
  it("names a row's track on hover and focus and to a screen reader", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<><button>Before</button><TranscriptPane {...props({ transcript: twoTrackTranscript, timeMs: twoTrackSpokenMs, languages: SPEECH_LANGUAGES })}/></>);
    // A screen reader hears the track with each row's time.
    expect(screen.getByRole('button', { name: 'Seek to 0:00, computer audio' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Seek to 0:16, microphone' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Seek to 0:16' })).not.toBeInTheDocument();
    // Hover: the tag above the row names its track, hidden from the reader who already heard it.
    const mic = rowOf('Seek to 0:16, microphone');
    await user.hover(mic);
    expect(tag(mic)).toHaveTextContent(/^Microphone$/);
    expect(tag(mic)).toHaveAttribute('aria-hidden', 'true');
    expect(tag(mic)!.querySelector('svg')).not.toBeNull();
    expect(document.querySelectorAll('.cr-track-tag')).toHaveLength(1);
    await user.unhover(mic);
    expect(tag(mic)).toBeNull();
    // Keyboard focus into a row shows it too, and moves with the focus.
    screen.getByRole('button', { name: 'Find in transcript' }).focus();
    await user.tab();
    const grid = screen.getByRole('button', { name: 'Seek to grid at 0:22' });
    expect(grid).toHaveFocus();
    expect(tag(rowOf('Seek to 0:21, microphone'))).toHaveTextContent('Microphone');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Seek to 0:27, computer audio' })).toHaveFocus();
    expect(tag(rowOf('Seek to 0:21, microphone'))).toBeNull();
    expect(tag(rowOf('Seek to 0:27, computer audio'))).toHaveTextContent(/^Computer audio$/);
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(document.querySelector('.cr-track-tag')).toBeNull();
    // When the take's tracks differ in language the tag names the row's.
    rerender(<><button>Before</button><TranscriptPane {...props({ transcript: twoLanguageTranscript, timeMs: twoTrackSpokenMs, languages: SPEECH_LANGUAGES })}/></>);
    const call = rowOf('Seek to 0:27, computer audio');
    await user.hover(call);
    expect(tag(call)).toHaveTextContent('Computer audio · German');
    await user.hover(rowOf('Seek to 0:38, microphone'));
    expect(tag(rowOf('Seek to 0:38, microphone'))).toHaveTextContent('Microphone · English');
  });
  it('names the two languages at their sides of the take line when the tracks differ', () => {
    const { rerender } = render(<TranscriptPane {...props({ transcript: twoLanguageTranscript, timeMs: twoTrackSpokenMs, languages: SPEECH_LANGUAGES })}/>);
    const line = document.querySelector<HTMLElement>('.cr-take-divider')!;
    expect(line).toHaveTextContent('Computer audio: German Take 1 · 0:00 · detected Microphone: English');
    const [left, right] = line.querySelectorAll('b');
    expect(left).toHaveTextContent('German');
    expect(right).toHaveTextContent('English');
    expect(line.querySelector('i')).toHaveTextContent(/^Take 1 · 0:00 · detected$/);
    // The same language on both, or one known: the take line as before.
    rerender(<TranscriptPane {...props({ transcript: twoTrackTranscript, timeMs: twoTrackSpokenMs, languages: SPEECH_LANGUAGES })}/>);
    expect(screen.getByText('Take 1 · 0:00 · English, detected')).toBeVisible();
    rerender(<TranscriptPane {...props({ transcript: { ...twoLanguageTranscript, trackLanguages: { system: { language: 'de', languageDetected: true } } }, timeMs: twoTrackSpokenMs, languages: SPEECH_LANGUAGES })}/>);
    expect(screen.getByText('Take 1 · 0:00 · English, detected')).toBeVisible();
    // While recording: the live take line splits once both are decided.
    rerender(<TranscriptPane {...props({ mode: 'recording', status: 'recording', transcript: { ...twoTrackRecordingTranscript, trackLanguages: twoLanguageTranscript.trackLanguages }, timeMs: 63500, languages: SPEECH_LANGUAGES })}/>);
    expect(document.querySelector('.cr-take-divider')).toHaveTextContent('Computer audio: German Take 1 · recording · detected Microphone: English');
    expect(document.querySelector('.cr-take-divider')).toHaveAttribute('data-live');
  });
  it('shows one live box per side while both tracks are heard, with the note once', () => {
    render(<TranscriptPane {...props({ mode: 'recording', status: 'recording', transcript: twoTrackRecordingTranscript, timeMs: 63500, languages: SPEECH_LANGUAGES })}/>);
    expect(screen.getByText('Take 1 · recording · English, detected')).toBeVisible();
    const tails = [...document.querySelectorAll<HTMLElement>('.cr-row.is-tail')];
    expect(tails.map(row => row.dataset.track)).toEqual(['system', 'microphone']);
    expect(tails[0]).toHaveTextContent('That number is in the dialog, but not on');
    expect(tails[1]).toHaveTextContent('Then put it on the');
    tails.forEach(tail => expect(tail.querySelector('.cr-row-text .cr-live-caret')).not.toBeNull());
    expect(screen.getAllByText(LIVE_NOTE)).toHaveLength(1);
    expect(within(tails[1]).getByText(LIVE_NOTE)).toBeVisible();
    expect(within(tails[1]).getByRole('button', { name: 'Seek to 1:01, microphone' })).toBeDisabled();
    // The finished rows of both tracks are ordinary rows.
    expect(document.querySelectorAll('.cr-row:not(.is-tail)')).toHaveLength(10);
    // One side quiet: its box goes, the other keeps the note.
    cleanup();
    render(<TranscriptPane {...props({ mode: 'recording', status: 'recording', transcript: { ...twoTrackRecordingTranscript, segments: twoTrackRecordingTranscript.segments.slice(0, -1) }, timeMs: 63500 })}/>);
    const [only] = document.querySelectorAll<HTMLElement>('.cr-row.is-tail');
    expect(document.querySelectorAll('.cr-row.is-tail')).toHaveLength(1);
    expect(only).toHaveAttribute('data-track', 'system');
    expect(within(only).getByText(LIVE_NOTE)).toBeVisible();
  });
  it('renders a one-track transcript exactly as before', async () => {
    const user = userEvent.setup();
    render(<TranscriptPane {...props({ transcript: phraseTranscript, timeMs: 0 })}/>);
    expect(scroller().innerHTML).toBe(ONE_TRACK_MARKUP);
    await user.hover(document.querySelector('.cr-row')!);
    expect(scroller().innerHTML).toBe(ONE_TRACK_MARKUP);
    cleanup();
    // A one-track take before a two-track take keeps its plain rows.
    render(<TranscriptPane {...props({ transcript: oneThenTwoTracksTranscript, timeMs: oneThenTwoTracksSpokenMs, languages: SPEECH_LANGUAGES })}/>);
    const rows = [...document.querySelectorAll<HTMLElement>('.cr-row')];
    expect(rows.slice(0, 4).map(row => row.dataset.track)).toEqual([undefined, undefined, undefined, undefined]);
    expect(screen.getByRole('button', { name: 'Seek to 0:00' })).toBeVisible();
    expect(rows.slice(4).every(row => row.dataset.track)).toBe(true);
    expect(screen.getByText('Take 1 · 0:00 · English, detected')).toBeVisible();
    expect(screen.getByText('Take 2 · 0:24 · English, detected')).toBeVisible();
    await user.hover(rows[0]);
    expect(document.querySelector('.cr-track-tag')).toBeNull();
  });
});

describe('Find in transcript', () => {
  it('opens the find bar with Ctrl+F', async () => {
    const { rerender } = render(<TranscriptPane {...props()}/>);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    // App turns Ctrl/⌘+F into a new findRequest.
    rerender(<TranscriptPane {...props()} findRequest={1}/>);
    const field = screen.getByRole('searchbox', { name: 'Find in transcript' });
    // It slides open: the first frames start closed.
    expect(field.closest('.cr-find-reveal')).toHaveAttribute('data-state', 'entering');
    await waitFor(() => expect(field.closest('.cr-find-reveal')).toHaveAttribute('data-state', 'open'));
    expect(field).toHaveFocus();
    // A second request while open takes focus back to the field.
    screen.getByRole('button', { name: 'Find in transcript' }).focus();
    rerender(<TranscriptPane {...props()} findRequest={2}/>);
    expect(field).toHaveFocus();
  });
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
    await waitFor(() => expect(screen.queryByRole('searchbox')).not.toBeInTheDocument());
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
  it('resumes following when the reader scrolls back to the newest words while recording', () => {
    render(<TranscriptPane {...props({ mode: 'recording', transcript: liveTranscript, timeMs: 88000, status: 'recording', liveTake: { index: 2, startMs: takeTwoStartMs } })}/>);
    fireEvent.wheel(scroller()); fireEvent.scroll(scroller());
    expect(screen.getByRole('button', { name: 'Back to live' })).toBeVisible();
    const view = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 400 }));
    fireEvent.wheel(scroller()); fireEvent.scroll(scroller());
    view.mockRestore();
    expect(screen.queryByRole('button', { name: 'Back to live' })).not.toBeInTheDocument();
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
