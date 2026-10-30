import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import type { Segment, Transcript } from '../backend';
import { TranscriptPane } from '../workspace/TranscriptPane';
import type { TranscriptPaneProps } from '../workspace/types';
import { takeTwoLiveTranscript, takeTwoStartMs, twoTakeTranscript } from './fixtures';

const takeOneSegments = twoTakeTranscript.segments.filter(segment => segment.startMs < takeTwoStartMs);
const PHRASES = [
  'The library feels clear and easy to navigate.',
  'When I select this model the details should update alongside it.',
  'The import action could be closer to the search field.',
  'Now if I open the filters the panel covers the first row of results.',
  'Scrolling is smooth but the header loses its shadow when you scroll back up.',
  'The preview takes a second to load so a placeholder would help.',
  'The export dialog needs a progress state and a way to cancel.',
];
// About 40 minutes of review notes across three takes, every word timed.
const longSegments: Segment[] = Array.from({ length: 480 }, (_, index) => {
  const text = `${PHRASES[index % PHRASES.length].slice(0, -1)}${index % 3 === 0 ? ', again' : ''}.`;
  const startMs = index * 5000;
  const words = text.split(' ');
  const step = 4200 / words.length;
  return { id: `long-${index}`, startMs, endMs: startMs + 4200, text, words: words.map((word, at) => ({ text: word, startMs: Math.round(startMs + at * step), endMs: Math.round(startMs + (at + 1) * step) })) };
});
const longTranscript: Transcript = { segments: longSegments, takes: [{ index: 1, startMs: 0 }, { index: 2, startMs: 800000 }, { index: 3, startMs: 1800000 }] };
const DURATIONS = { review: 134000, long: longSegments.length * 5000 };

type Scenario = 'review' | 'recording-take-2' | 'recording-long' | 'recording-take-2-waiting' | 'processing' | 'error' | 'error-after-take' | 'empty' | 'long';
interface Args { scenario: Scenario; playing: boolean }

function Column({ scenario, playing: initiallyPlaying }: Args) {
  const long = scenario === 'long';
  const [time, setTime] = useState(long ? 600000 : 33200);
  const [playing, setPlaying] = useState(initiallyPlaying);
  const [notice, setNotice] = useState('');
  const duration = long ? DURATIONS.long : DURATIONS.review;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setTime(value => Math.min(duration, value + 250)), 250);
    return () => window.clearInterval(timer);
  }, [playing, duration]);
  const base = { timeMs: time, onSeek: setTime };
  const props: TranscriptPaneProps = {
    review: { ...base, mode: 'review', transcript: twoTakeTranscript },
    long: { ...base, mode: 'review', transcript: longTranscript },
    'recording-take-2': { mode: 'recording', transcript: { takes: [{ index: 1, startMs: 0 }], segments: [...takeOneSegments, ...takeTwoLiveTranscript.segments] }, timeMs: takeTwoStartMs + 8000, onSeek: setTime, status: 'recording', liveTake: { index: 2, startMs: takeTwoStartMs } },
    // A long first take, then take 2 recording: enough rows to scroll away from the live words.
    'recording-long': { mode: 'recording', transcript: { takes: [{ index: 1, startMs: 0 }], segments: [...longSegments.slice(0, 16), ...takeTwoLiveTranscript.segments.map(segment => ({ ...segment, id: `live-${segment.startMs}` }))] }, timeMs: takeTwoStartMs + 8000, onSeek: setTime, status: 'recording', liveTake: { index: 2, startMs: takeTwoStartMs } },
    'recording-take-2-waiting': { mode: 'recording', transcript: { takes: [{ index: 1, startMs: 0 }], segments: takeOneSegments }, timeMs: takeTwoStartMs + 1200, onSeek: setTime, status: 'recording', liveTake: { index: 2, startMs: takeTwoStartMs }, emptyMessage: 'Listening… transcript updates in short batches.', liveError: 'Live transcription is catching up. Words appear after each short batch.' },
    processing: { ...base, mode: 'review', transcript: { segments: [] }, status: 'processing', emptyMessage: 'Transcribing…' },
    error: { ...base, mode: 'review', transcript: { segments: [] }, error: 'Speech model not found. Install transcription in Settings, then retry.', onRetry: () => setNotice('Retry selected.') },
    'error-after-take': { ...base, mode: 'review', transcript: { ...twoTakeTranscript, segments: takeOneSegments, takes: [{ index: 1, startMs: 0 }, { index: 2, startMs: takeTwoStartMs }] }, error: 'Take 2 could not be transcribed: the audio track is missing.', onRetry: () => setNotice('Retry selected.') },
    empty: { ...base, mode: 'review', transcript: { segments: [] }, emptyMessage: 'No speech was detected in this recording.' },
  }[scenario] as TranscriptPaneProps;
  return <div style={{ height: '100vh', display: 'flex', justifyContent: 'flex-end', background: 'var(--color-sheet)', color: 'var(--color-text)' }}>
    <div style={{ flex: 1, minWidth: 0, padding: 24, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
      {props.mode === 'review' && <button type="button" className="cr-btn cr-pill" onClick={() => setPlaying(value => !value)}>{playing ? 'Pause sample' : 'Play sample'}</button>}
      <p style={{ margin: 0 }}>Sample time {Math.floor(time / 60000)}:{String(Math.floor(time / 1000) % 60).padStart(2, '0')}. Scroll the transcript away to stop following.</p>
      {notice && <p role="status" style={{ margin: 0 }}>{notice}</p>}
    </div>
    <aside className="cr-transcript-column"><TranscriptPane {...props}/></aside>
  </div>;
}

const meta = {
  title: 'Workspace/Transcript',
  component: Column,
  args: { scenario: 'review', playing: false },
  argTypes: { scenario: { control: 'select', options: ['review', 'recording-take-2', 'recording-long', 'recording-take-2-waiting', 'processing', 'error', 'error-after-take', 'empty', 'long'] } },
  render: args => <Column key={args.scenario} {...args}/>,
  globals: { viewport: { value: 'desktop', isRotated: false } },
} satisfies Meta<typeof Column>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Review: Story = {};
export const ReviewDark: Story = { globals: { theme: 'dark' } };
export const ReviewSmallWindow: Story = { globals: { viewport: { value: 'small', isRotated: false } } };
export const RecordingTakeTwo: Story = { args: { scenario: 'recording-take-2' } };
export const RecordingTakeTwoDark: Story = { args: { scenario: 'recording-take-2' }, globals: { theme: 'dark' } };
export const RecordingBeforeWords: Story = { args: { scenario: 'recording-take-2-waiting' } };
export const Processing: Story = { args: { scenario: 'processing' } };
export const Error: Story = { args: { scenario: 'error' } };
export const ErrorAfterTake: Story = { args: { scenario: 'error-after-take' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const LongTranscript: Story = { args: { scenario: 'long' } };
export const LongTranscriptPlaying: Story = { args: { scenario: 'long', playing: true } };

export const FindInTranscript: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Find in transcript' }));
    const field = canvas.getByRole('searchbox', { name: 'Find in transcript' });
    await userEvent.type(field, 'preview');
    await expect(canvas.getByText('1 of 2')).toBeVisible();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByText('2 of 2')).toBeVisible();
  },
};
export const KeyboardNavigation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole('button', { name: 'Find in transcript' }).focus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Seek to grid at 0:33' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}{ArrowDown}');
    await expect(canvas.getByRole('button', { name: 'Seek to 0:38' })).toHaveFocus();
  },
};
export const ReturnToPlayback: Story = {
  args: { scenario: 'long' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const scroller = canvasElement.querySelector<HTMLElement>('.cr-transcript-scroll')!;
    await waitFor(() => expect(canvas.getByRole('button', { name: /Seek to 10:00/ })).toBeVisible());
    // Let the initial follow scroll settle, then read elsewhere.
    await new Promise(resolve => setTimeout(resolve, 900));
    fireEvent.wheel(scroller);
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    const back = await canvas.findByRole('button', { name: 'Return to playback' });
    await userEvent.click(back);
    await waitFor(() => expect(canvas.queryByRole('button', { name: 'Return to playback' })).not.toBeInTheDocument());
  },
};
/** Scrolled up while recording: the button goes back to the newest words, not to playback. */
export const BackToLive: Story = {
  args: { scenario: 'recording-long' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const scroller = canvasElement.querySelector<HTMLElement>('.cr-transcript-scroll')!;
    await waitFor(() => expect(canvas.getByText('Take 2 · recording')).toBeVisible());
    await new Promise(resolve => setTimeout(resolve, 900));
    fireEvent.wheel(scroller);
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    await expect(await canvas.findByRole('button', { name: 'Back to live' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Return to playback' })).not.toBeInTheDocument();
  },
};
