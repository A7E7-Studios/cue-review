import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { CaptureSource, Transcript } from '../backend';
import { CaptureControls } from '../workspace/CaptureControls';
import { captureEmptyState, MediaStage, reviewEmptyState } from '../workspace/MediaStage';
import { PlaybackBar } from '../workspace/PlaybackBar';
import { RecordingDock } from '../workspace/RecordingDock';
import { SessionHeader } from '../workspace/SessionHeader';
import { TranscriptPane } from '../workspace/TranscriptPane';
import type { CaptureMenu, TranscriptPaneProps } from '../workspace/types';
import { takeTwoLiveTranscript, takeTwoStartMs, transcript as firstTakeTranscript, twoTakeSession, twoTakeTranscript, WINDOW_CLOSED } from './fixtures';

// The recorded screen from the Float v2 mocks. The review video is a still: the
// <video> shows it as its poster and never loads media.
const sample = new URL('../../docs/design/float-v2/sample-capture.svg', import.meta.url).href;
const SPEEDS = [1, 1.5, 2, 0.75];
const sources: CaptureSource[] = [
  { id: 'monitor:1', name: 'Display 1', kind: 'display', available: true },
  { id: 'window', name: 'Library — Component browser', kind: 'window', available: true },
  { id: 'quest', name: 'Quest 3', kind: 'quest', available: true },
  { id: 'camera', name: 'Studio camera with a very long device name', kind: 'camera', available: false, detail: 'Reconnect this camera and refresh, or choose another source.' },
];
const microphones = [{ id: 'microphone', name: 'Studio microphone' }, { id: 'headset', name: 'Headset microphone' }];
const takeOneSegments = twoTakeTranscript.segments.filter(segment => segment.startMs < takeTwoStartMs);
const recordingTakeTwo: Transcript = { takes: [{ index: 1, startMs: 0 }], segments: [...takeOneSegments, ...takeTwoLiveTranscript.segments] };

// 'window-closed': Record more was refused because the window chosen in the bar has closed since it was listed.
type Scenario = 'review' | 'recording-take-2' | 'recording-first' | 'processing' | 'error' | 'no-speech' | 'no-video' | 'window-closed' | 'draft' | 'draft-unavailable';
interface Args { scenario: Scenario; compact: boolean; focused: boolean }

function Workspace({ scenario, compact, focused: initiallyFocused }: Args) {
  const review = ['review', 'processing', 'error', 'no-speech', 'no-video', 'window-closed'].includes(scenario);
  const [recordMoreError, setRecordMoreError] = useState(scenario === 'window-closed' ? WINDOW_CLOSED : '');
  const recording = scenario.startsWith('recording');
  const draft = scenario.startsWith('draft');
  const take = scenario === 'recording-take-2' ? 2 : 1;
  const [time, setTime] = useState(33200);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [focused, setFocused] = useState(initiallyFocused);
  const [muted, setMuted] = useState(false);
  const [compactMode, setCompactMode] = useState(compact);
  const [menu, setMenu] = useState<CaptureMenu | null>(null);
  const [sourceId, setSourceId] = useState(scenario === 'draft-unavailable' ? 'camera' : scenario === 'window-closed' ? 'window' : 'monitor:1');
  const [microphoneId, setMicrophoneId] = useState('microphone');
  const [systemAudio, setSystemAudio] = useState(false);
  const [notice, setNotice] = useState('');
  const duration = scenario === 'processing' ? takeTwoStartMs : twoTakeSession.durationMs;
  const elapsed = take === 2 ? 8000 : 8200;
  const source = sources.find(item => item.id === sourceId);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setTime(value => {
      const next = Math.min(duration, value + 250 * speed);
      if (next >= duration) setPlaying(false);
      return next;
    }), 250);
    return () => window.clearInterval(timer);
  }, [playing, speed, duration]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 2500); return () => window.clearTimeout(timer); }, [notice]);

  const seek = (ms: number) => setTime(Math.max(0, Math.min(duration, ms)));
  const transcriptProps: TranscriptPaneProps = recording
    ? { mode: 'recording', transcript: take === 2 ? recordingTakeTwo : firstTakeTranscript, timeMs: (take === 2 ? takeTwoStartMs : 0) + elapsed, onSeek: seek, status: 'recording', liveTake: take === 2 ? { index: 2, startMs: takeTwoStartMs } : undefined, emptyMessage: 'Listening… transcript updates in short batches.' }
    : scenario === 'processing' ? { mode: 'review', transcript: { segments: [] }, timeMs: time, onSeek: seek, status: 'processing', emptyMessage: 'Transcribing…' }
      : scenario === 'error' ? { mode: 'review', transcript: { segments: [], error: 'The speech model could not be loaded. Install transcription in Settings, then retry.' }, timeMs: time, onSeek: seek, error: 'The speech model could not be loaded. Install transcription in Settings, then retry.', onRetry: () => setNotice('Retry selected.') }
        : scenario === 'no-speech' ? { mode: 'review', transcript: { segments: [] }, timeMs: time, onSeek: seek, emptyMessage: 'No speech was detected in this recording.' }
          : { mode: draft ? 'draft' : 'review', transcript: twoTakeTranscript, timeMs: time, onSeek: seek };
  const playable = review && scenario !== 'processing' && scenario !== 'no-video';
  const segments = transcriptProps.transcript.segments;
  const showTranscript = !draft && !focused && !compactMode;

  const bar = {
    sources, source, systemAudio, onSelectSource: setSourceId, onSystemAudio: setSystemAudio,
    microphones, microphoneId, microphoneUnavailable: false, muted, menu, onMenu: setMenu, onSelectMicrophone: setMicrophoneId, onMuted: setMuted,
    onRefreshSources: () => setNotice('Refresh selected.'), onRefreshMicrophones: () => setNotice('Refresh selected.'), locked: false, busy: false,
  };
  const controls = recording
    ? <RecordingDock elapsedMs={elapsed} take={take} audioLevel={0.0126} sourceName="Display 1" hasMicrophone microphoneName="Microphone (HD Pro Webcam C920)" muted={muted} onMuted={setMuted}
        compact={compactMode} onToggleCompact={() => setCompactMode(value => !value)} stopDisabled={false} onStop={() => setNotice('Stop selected.')}/>
    : draft
      ? <CaptureControls {...bar}
          recordLabel="Record" recordDisabled={!source?.available} onRecord={() => setNotice('Record selected.')}/>
      : <>
        <PlaybackBar timeMs={time} durationMs={duration} segments={segments} takes={twoTakeTranscript.takes} onSeek={seek}
          playing={playing} canPlay={playable} onTogglePlay={() => setPlaying(value => !value)} speed={speed}
          onCycleSpeed={() => setSpeed(value => SPEEDS[(SPEEDS.indexOf(value) + 1) % SPEEDS.length])} focused={focused}
          onToggleFocus={() => setFocused(value => !value)}/>
        <CaptureControls {...bar} review recordLabel="Record more" recordDisabled={scenario === 'processing' || !source?.available}
          onRecord={() => scenario === 'window-closed' && sourceId === 'window' ? setRecordMoreError(WINDOW_CLOSED) : setNotice('Record more selected.')}
          recordMoreError={recordMoreError || undefined} onNewRecording={() => setNotice('New recording selected.')} onDismissRecordMoreError={() => setRecordMoreError('')}/>
      </>;

  return <div style={{ height: '100vh', display: 'flex', minWidth: 0, overflow: 'hidden', background: 'var(--color-sheet)', color: 'var(--color-text)' }}>
    <div className="cr-center">
      <SessionHeader title={draft ? 'New recording' : twoTakeSession.name} draft={draft} renameDisabled={recording} onRename={() => setNotice('Rename selected.')}
        onOpenFolder={() => setNotice('Open folder selected.')} copyDisabled={recording || scenario === 'processing'} onCopyForAgent={() => setNotice('Agent instructions copied.')}/>
      <MediaStage mode={recording ? 'recording' : draft ? 'draft' : 'review'} focused={focused} sourceName="Display 1"
        previewUrl={(recording || scenario === 'draft') ? sample : undefined}
        empty={draft ? captureEmptyState({ source }) : reviewEmptyState({ processing: scenario === 'processing' })}
        videoSrc={playable ? sample : undefined} videoProps={{ poster: sample, onClick: () => setPlaying(value => !value) }}>
        {controls}
      </MediaStage>
      {notice && <p role="status" style={{ position: 'fixed', bottom: 12, left: 12, margin: 0, padding: '6px 10px', borderRadius: 8, background: 'var(--color-pill)', fontSize: 12 }}>{notice}</p>}
    </div>
    {showTranscript && <aside className="cr-transcript-column"><TranscriptPane {...transcriptProps}/></aside>}
  </div>;
}

const meta = {
  title: 'Workspace/Media',
  component: Workspace,
  args: { scenario: 'review', compact: false, focused: false },
  argTypes: { scenario: { control: 'select', options: ['review', 'recording-take-2', 'recording-first', 'processing', 'error', 'no-speech', 'no-video', 'window-closed', 'draft', 'draft-unavailable'] } },
  render: args => <Workspace key={`${args.scenario}-${args.compact}-${args.focused}`} {...args}/>,
  globals: { viewport: { value: 'desktop', isRotated: false } },
} satisfies Meta<typeof Workspace>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Review: Story = {};
export const ReviewSmallWindow: Story = { globals: { viewport: { value: 'small', isRotated: false } } };
export const ReviewDark: Story = { globals: { theme: 'dark' } };
export const ReviewFocused: Story = { args: { focused: true } };
export const ReviewCompactSize: Story = { args: { compact: true }, globals: { viewport: { value: 'compact', isRotated: false } } };
export const RecordingTakeTwo: Story = { args: { scenario: 'recording-take-2' } };
export const RecordingTakeTwoDark: Story = { args: { scenario: 'recording-take-2' }, globals: { theme: 'dark' } };
export const RecordingTakeTwoSmallWindow: Story = { args: { scenario: 'recording-take-2' }, globals: { viewport: { value: 'small', isRotated: false } } };
export const RecordingFirstTake: Story = { args: { scenario: 'recording-first' } };
export const RecordingCompact: Story = { args: { scenario: 'recording-take-2', compact: true }, globals: { viewport: { value: 'compact', isRotated: false } } };
export const RecordingCompactDark: Story = { args: { scenario: 'recording-take-2', compact: true }, globals: { viewport: { value: 'compact', isRotated: false }, theme: 'dark' } };
export const Processing: Story = { args: { scenario: 'processing' } };
export const TranscriptError: Story = { args: { scenario: 'error' } };
export const NoSpeech: Story = { args: { scenario: 'no-speech' } };
export const NoVideo: Story = { args: { scenario: 'no-video' } };
export const RecordMoreWindowClosed: Story = { args: { scenario: 'window-closed' } };
export const RecordMoreWindowClosedDark: Story = { args: { scenario: 'window-closed' }, globals: { theme: 'dark' } };
export const RecordMoreWindowClosedSmallWindow: Story = { args: { scenario: 'window-closed' }, globals: { viewport: { value: 'small', isRotated: false } } };
export const Draft: Story = { args: { scenario: 'draft' } };
export const DraftSourceUnavailable: Story = { args: { scenario: 'draft-unavailable' } };
export const DraftCompactSize: Story = { args: { scenario: 'draft' }, globals: { viewport: { value: 'compact', isRotated: false } } };

export const ScrubWithKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const slider = canvas.getByRole('slider', { name: 'Playback position' });
    slider.focus();
    await userEvent.keyboard('{End}');
    await expect(canvas.getByRole('group', { name: 'Playback' })).toHaveTextContent('2:14 / 2:14');
    await userEvent.keyboard('{Home}{ArrowRight}');
    await expect(slider).toHaveValue('5000');
  },
};
export const ChooseSourceWithKeyboard: Story = {
  args: { scenario: 'draft' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Display 1' });
    await userEvent.click(trigger);
    const list = await canvas.findByRole('group', { name: 'Capture sources' });
    await waitFor(() => expect(within(list).getByRole('button', { name: 'Display 1' })).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(canvas.queryByRole('group', { name: 'Capture sources' })).not.toBeInTheDocument());
    await expect(canvas.getByRole('button', { name: 'Library — Component browser' })).toHaveFocus();
  },
};
export const MuteWhileRecording: Story = {
  args: { scenario: 'recording-take-2' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const mute = canvas.getByRole('button', { name: 'Mute microphone' });
    const dock = canvasElement.querySelector<HTMLElement>('.cr-dock')!;
    await document.fonts.ready;
    const width = dock.getBoundingClientRect().width;
    await userEvent.click(mute);
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    await expect(mute).toHaveAccessibleDescription('Muted');
    // The meter stays, flat, and the dock keeps its width.
    await expect(canvas.getByRole('meter', { name: 'Microphone level' })).toHaveAttribute('aria-valuetext', 'Muted');
    await expect(dock.getBoundingClientRect().width).toBe(width);
  },
};
