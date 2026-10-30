import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CaptureSource } from '../backend';
import { CaptureControls, placePopover } from './CaptureControls';
import type { CaptureControlsViewProps } from './CaptureControls';
import type { CaptureControlsProps, CaptureMenu } from './types';

const sources: CaptureSource[] = [
  { id: 'display', name: 'Display 1', kind: 'display', available: true },
  { id: 'window', name: 'Design review window', kind: 'window', available: true },
  { id: 'quest', name: 'Quest 3', kind: 'quest', available: true },
  { id: 'camera', name: 'Studio camera', kind: 'camera', available: false, detail: 'Reconnect the camera.' },
];
const microphones = [{ id: 'mic1', name: 'Studio microphone' }, { id: 'mic2', name: 'Headset microphone' }];

function Harness({ platform = 'windows', ...overrides }: Partial<CaptureControlsViewProps> & { initialMenu?: CaptureMenu | null }) {
  const [menu, setMenu] = useState<CaptureMenu | null>(overrides.initialMenu ?? null);
  const [sourceId, setSourceId] = useState('display');
  const [microphoneId, setMicrophoneId] = useState<string | undefined>('mic1');
  const props: CaptureControlsProps = {
    sources, source: sources.find(item => item.id === sourceId), microphones, microphoneId, microphoneUnavailable: false,
    systemAudio: false, muted: false, menu, onMenu: setMenu, onSelectSource: setSourceId, onSelectMicrophone: setMicrophoneId,
    onSystemAudio: vi.fn(), onMuted: vi.fn(), onRefreshSources: vi.fn(), onRefreshMicrophones: vi.fn(),
    locked: false, busy: false, recordLabel: 'Record', recordDisabled: false, onRecord: vi.fn(), ...overrides,
  };
  return <><CaptureControls {...props} platform={platform}/><button>Elsewhere</button></>;
}

describe('CaptureControls', () => {
  it('keeps the trigger hooks and names, and opens a picker focused on the selected option', async () => {
    const user = userEvent.setup();
    render(<Harness/>);
    const source = screen.getByRole('button', { name: 'Display 1' });
    const mic = screen.getByRole('button', { name: 'Studio microphone' });
    expect(source).toHaveClass('source-trigger');
    expect(mic).toHaveClass('mic-trigger');
    await user.click(source);
    expect(source).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('group', { name: 'Capture sources' });
    expect(within(list).getByRole('button', { name: 'Display 1' })).toHaveFocus();
    expect(within(list).getByRole('button', { name: 'Display 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(list).getByRole('button', { name: 'Studio camera · unavailable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh capture devices' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Include system audio' })).not.toBeChecked();
  });
  it('moves through options with arrows, Home, End and typeahead, keeping one tab stop', async () => {
    const user = userEvent.setup();
    render(<Harness initialMenu="source"/>);
    const list = screen.getByRole('group', { name: 'Capture sources' });
    const option = (name: string) => within(list).getByRole('button', { name });
    expect(option('Display 1')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(option('Design review window')).toHaveFocus();
    expect(option('Design review window')).toHaveAttribute('tabindex', '0');
    expect(option('Display 1')).toHaveAttribute('tabindex', '-1');
    await user.keyboard('{End}');
    expect(option('Studio camera · unavailable')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(option('Display 1')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(option('Studio camera · unavailable')).toHaveFocus();
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    await user.keyboard('{Home}q');
    expect(option('Quest 3')).toHaveFocus();
    clock = 1000;
    await user.keyboard('d');
    expect(option('Display 1')).toHaveFocus();
    await user.keyboard('e');
    expect(option('Design review window')).toHaveFocus();
  });
  it('selects an option, closes the picker and returns focus to its trigger', async () => {
    const user = userEvent.setup();
    render(<Harness/>);
    await user.click(screen.getByRole('button', { name: 'Display 1' }));
    await user.click(within(screen.getByRole('group', { name: 'Capture sources' })).getByRole('button', { name: 'Quest 3' }));
    expect(screen.queryByRole('group', { name: 'Capture sources' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quest 3' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Quest 3' }));
    expect(screen.getByRole('checkbox', { name: 'Include device audio' })).toBeInTheDocument();
  });
  it('closes on Escape, a click outside or tabbing away, restoring focus on Escape only', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    try {
      render(<Harness/>);
      const mic = screen.getByRole('button', { name: 'Studio microphone' });
      await user.click(mic);
      expect(within(screen.getByRole('group', { name: 'Microphone options' })).getByRole('button', { name: 'Studio microphone' })).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('group', { name: 'Microphone options' })).not.toBeInTheDocument();
      expect(mic).toHaveFocus();
      expect(outer).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
      await user.click(mic);
      await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
      expect(screen.queryByRole('group', { name: 'Microphone options' })).not.toBeInTheDocument();
      await user.click(mic);
      await user.tab(); await user.tab(); await user.tab();
      expect(screen.queryByRole('group', { name: 'Microphone options' })).not.toBeInTheDocument();
    } finally { window.removeEventListener('keydown', outer); }
  });
  it('lists No microphone, the unavailable previous choice and the mute option', async () => {
    const user = userEvent.setup();
    const onMuted = vi.fn();
    render(<Harness microphoneId="gone" microphoneUnavailable onMuted={onMuted}/>);
    const trigger = screen.getByRole('button', { name: 'Microphone unavailable' });
    await user.click(trigger);
    const list = screen.getByRole('group', { name: 'Microphone options' });
    expect(within(list).getByRole('button', { name: 'Previously selected microphone · unavailable' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(list).getByRole('button', { name: 'No microphone' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Reconnect the selected microphone and refresh microphones, choose another input, or select No microphone.')).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: 'Mute microphone' }));
    expect(onMuted).toHaveBeenCalledWith(true);
    await user.click(within(list).getByRole('button', { name: 'No microphone' }));
    expect(screen.queryByRole('group', { name: 'Microphone options' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it('names the microphone trigger Muted or No microphone, and locks the pickers', () => {
    const { rerender } = render(<Harness muted/>);
    expect(screen.getByRole('button', { name: 'Muted' })).toHaveClass('mic-trigger');
    rerender(<Harness microphoneId="" locked busy/>);
    expect(screen.getByRole('button', { name: 'No microphone' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Display 1' })).toBeDisabled();
  });
  it('records with the shortcut in the tooltip and the given label', async () => {
    const user = userEvent.setup();
    const onRecord = vi.fn();
    const { rerender } = render(<Harness onRecord={onRecord}/>);
    const record = screen.getByRole('button', { name: 'Record' });
    expect(record).toHaveAttribute('aria-keyshortcuts', 'Control+R');
    expect(record.title).toContain('Ctrl+R');
    await user.click(record);
    expect(onRecord).toHaveBeenCalledTimes(1);
    rerender(<Harness recordLabel="Please wait…" recordDisabled/>);
    expect(screen.getByRole('button', { name: 'Please wait…' })).toBeDisabled();
  });
});

describe('CaptureControls as the recording bar', () => {
  const closed = 'This window is no longer available';
  it('is one named bar holding the pickers and Record in a draft', () => {
    render(<Harness/>);
    const bar = within(screen.getByRole('group', { name: 'Recording bar' }));
    expect(bar.getByRole('button', { name: 'Display 1' })).toBeEnabled();
    expect(bar.getByRole('button', { name: 'Studio microphone' })).toBeEnabled();
    const record = bar.getByRole('button', { name: 'Record' });
    expect(record).toHaveClass('cr-record');
    expect(record).toHaveAttribute('title', 'Start recording (Ctrl+R)');
  });
  it('offers Record more in review with both pickers to choose', async () => {
    const user = userEvent.setup();
    const onRecord = vi.fn();
    const onSystemAudio = vi.fn();
    render(<Harness review recordLabel="Record more" onRecord={onRecord} onSystemAudio={onSystemAudio}/>);
    const bar = within(screen.getByRole('group', { name: 'Recording bar' }));
    const source = bar.getByRole('button', { name: 'Display 1' });
    // The source picker opens as in a draft, with nothing saying it is locked.
    expect(source).toBeEnabled();
    expect(source).not.toHaveAttribute('aria-disabled');
    expect(source).not.toHaveAttribute('aria-describedby');
    expect(source).toHaveAttribute('title', 'Display 1');
    await user.click(source);
    expect(source).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('checkbox', { name: 'Include system audio' }));
    expect(onSystemAudio).toHaveBeenCalledWith(true);
    await user.click(within(screen.getByRole('group', { name: 'Capture sources' })).getByRole('button', { name: 'Design review window' }));
    expect(bar.getByRole('button', { name: 'Design review window' })).toHaveFocus();
    // Tab order: the source, the microphone, then Record more.
    await user.tab();
    expect(bar.getByRole('button', { name: 'Studio microphone' })).toHaveFocus();
    await user.tab();
    expect(bar.getByRole('button', { name: 'Record more' })).toHaveFocus();
    await user.click(bar.getByRole('button', { name: 'Studio microphone' }));
    await user.click(within(screen.getByRole('group', { name: 'Microphone options' })).getByRole('button', { name: 'Headset microphone' }));
    expect(bar.getByRole('button', { name: 'Headset microphone' })).toHaveFocus();
    const more = bar.getByRole('button', { name: 'Record more' });
    expect(more).toHaveAttribute('aria-keyshortcuts', 'Control+R');
    expect(more).toHaveAttribute('title', 'Record more (Ctrl+R): continue this session as a new take');
    await user.click(more);
    expect(onRecord).toHaveBeenCalledTimes(1);
  });
  it('locks both pickers while Record more is busy', () => {
    render(<Harness review locked busy recordLabel="Record more"/>);
    expect(screen.getByRole('button', { name: 'Display 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Studio microphone' })).toBeDisabled();
  });
  it('shows the macOS shortcut for Record more', () => {
    render(<Harness review recordLabel="Record more" platform="macos"/>);
    const more = screen.getByRole('button', { name: 'Record more' });
    expect(more).toHaveAttribute('aria-keyshortcuts', 'Meta+R');
    expect(more).toHaveAttribute('title', 'Record more (⌘R): continue this session as a new take');
  });
  it('shows why Record more failed under the bar, with New recording and Dismiss', async () => {
    const user = userEvent.setup();
    const handlers = { onNewRecording: vi.fn(), onDismissRecordMoreError: vi.fn() };
    const { rerender } = render(<Harness review recordLabel="Record more" recordMoreError={closed} {...handlers}/>);
    const alert = within(screen.getByRole('group', { name: 'Recording bar' })).getByRole('alert');
    expect(alert).toHaveTextContent('no longer available');
    expect(screen.getByRole('button', { name: 'Record more' })).toHaveAccessibleDescription(closed);
    await user.click(within(alert).getByRole('button', { name: 'New recording' }));
    await user.click(within(alert).getByRole('button', { name: 'Dismiss error' }));
    expect(handlers.onNewRecording).toHaveBeenCalledTimes(1);
    expect(handlers.onDismissRecordMoreError).toHaveBeenCalledTimes(1);
    // Busy for a moment: New recording stays focusable but does nothing.
    rerender(<Harness review recordLabel="Record more" recordMoreError={closed} recordBusy {...handlers}/>);
    const start = within(alert).getByRole('button', { name: 'New recording' });
    expect(start).toHaveAttribute('aria-disabled', 'true');
    await user.click(start);
    expect(handlers.onNewRecording).toHaveBeenCalledTimes(1);
    rerender(<Harness review recordLabel="Record more" {...handlers}/>);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('placePopover', () => {
  const viewport = { width: 1280, height: 820 };
  it('opens below the trigger when it fits', () => {
    expect(placePopover({ left: 100, top: 300, bottom: 336 }, { width: 300, height: 240 }, viewport)).toEqual({ left: 100, top: 342, maxHeight: 470, side: 'bottom' });
  });
  it('flips above when there is more room there and caps the height to it', () => {
    expect(placePopover({ left: 100, top: 700, bottom: 736 }, { width: 300, height: 240 }, viewport)).toEqual({ left: 100, top: 454, maxHeight: 686, side: 'top' });
    expect(placePopover({ left: 100, top: 200, bottom: 236 }, { width: 300, height: 400 }, { width: 520, height: 320 })).toEqual({ left: 100, top: 8, maxHeight: 186, side: 'top' });
  });
  it('stays inside the viewport horizontally', () => {
    expect(placePopover({ left: 1100, top: 100, bottom: 136 }, { width: 300, height: 200 }, viewport).left).toBe(972);
    expect(placePopover({ left: -20, top: 100, bottom: 136 }, { width: 300, height: 200 }, viewport).left).toBe(8);
  });
});
